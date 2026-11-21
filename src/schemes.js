// Weekly / monthly / quarterly contests (SPIFs) and the leaderboard. Progress counts only the user's own sales that are
// recorded (not refunded/blocked) and confirmed by Razorpay, inside the scheme window.

import { HttpError, newId, needStr, isInt, DAY } from './util.js';
import { atomic, auditStmts, ledgerStmts } from './chain.js';
import { getPolicy } from './policy.js';

export async function createScheme(ctx, body) {
  const name = needStr(body.name, 'name', 120);
  if (!['weekly', 'monthly', 'quarterly', 'custom'].includes(body.period)) throw new HttpError(422, 'invalid_field', 'period');
  if (!['sales_count', 'net_minor'].includes(body.metric)) throw new HttpError(422, 'invalid_field', 'metric');
  if (!isInt(body.target, 1) || !isInt(body.bonus_minor, 1, 100_000_000) || !isInt(body.starts_at, 1) || !isInt(body.ends_at, 1) || body.ends_at <= body.starts_at) {
    throw new HttpError(422, 'invalid_field', 'target, bonus_minor, starts_at, ends_at must be positive integers with ends_at after starts_at');
  }
  if (body.site_id && !(await ctx.db.first('SELECT 1 AS x FROM sites WHERE id=?', [body.site_id]))) throw new HttpError(422, 'invalid_field', 'unknown site_id');
  const id = newId('sc');
  await atomic(ctx, async () => [
    { sql: "INSERT INTO schemes (id,name,period,metric,target,bonus_minor,site_id,starts_at,ends_at,status,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,'draft',?,?)",
      params: [id, name, body.period, body.metric, body.target, body.bonus_minor, body.site_id || null, body.starts_at, body.ends_at, ctx.actor?.keyId || null, ctx.now()] },
    ...(await auditStmts(ctx, [{ action: 'scheme.create', target: `scheme:${id}`, meta: { name, period: body.period, bonus_minor: body.bonus_minor } }])),
  ]);
  return ctx.db.first('SELECT * FROM schemes WHERE id=?', [id]);
}

export async function setSchemeStatus(ctx, id, status) {
  const s = await ctx.db.first('SELECT * FROM schemes WHERE id=?', [id]);
  if (!s) throw new HttpError(404, 'not_found', 'scheme not found');
  const ok = (s.status === 'draft' && ['active', 'cancelled'].includes(status)) || (s.status === 'active' && status === 'cancelled');
  if (!ok) throw new HttpError(409, 'bad_state', `scheme is ${s.status}`);
  await atomic(ctx, async () => [
    { sql: 'UPDATE schemes SET status=? WHERE id=?', params: [status, id] },
    ...(await auditStmts(ctx, [{ action: `scheme.${status}`, target: `scheme:${id}` }])),
  ]);
  return { ...s, status };
}

export const listSchemes = (ctx, onlyLive) =>
  ctx.db.all(`SELECT * FROM schemes ${onlyLive ? "WHERE status='active'" : ''} ORDER BY starts_at DESC`);

const progressSql = (s) => `SELECT user_id, COUNT(*) AS c, COALESCE(SUM(net_minor),0) AS n FROM sales
  WHERE user_id IS NOT NULL AND status='recorded' AND rzp_status='confirmed' AND paid_at >= ? AND paid_at < ? ${s.site_id ? 'AND site_id = ?' : ''}`;
const progressParams = (s) => (s.site_id ? [s.starts_at, s.ends_at, s.site_id] : [s.starts_at, s.ends_at]);

export async function progressFor(ctx, scheme, userId) {
  const r = await ctx.db.first(`${progressSql(scheme)} AND user_id = ? GROUP BY user_id`, [...progressParams(scheme), userId]);
  const value = scheme.metric === 'sales_count' ? r?.c || 0 : r?.n || 0;
  return { scheme_id: scheme.id, name: scheme.name, period: scheme.period, metric: scheme.metric, target: scheme.target, value, percent: Math.min(100, Math.floor((value * 100) / scheme.target)), bonus_minor: scheme.bonus_minor, ends_at: scheme.ends_at };
}

/** Owner action after the window closes: one 'adjustment' ledger entry per winner (ref makes a double-settle impossible). */
export async function settleScheme(ctx, id) {
  const s = await ctx.db.first('SELECT * FROM schemes WHERE id=?', [id]);
  if (!s) throw new HttpError(404, 'not_found', 'scheme not found');
  if (s.status !== 'active') throw new HttpError(409, 'bad_state', `scheme is ${s.status}, only active schemes settle`);
  if (s.ends_at > ctx.now()) throw new HttpError(409, 'not_ended', 'the scheme window has not ended yet');
  const policy = await getPolicy(ctx);
  const rows = await ctx.db.all(`${progressSql(s)} GROUP BY user_id`, progressParams(s));
  const winners = [];
  for (const r of rows) {
    const value = s.metric === 'sales_count' ? r.c : r.n;
    if (value < s.target) continue;
    const u = await ctx.db.first("SELECT id FROM users WHERE id=? AND status='active'", [r.user_id]);
    if (u) winners.push(u.id);
  }
  const eligible = Math.max(ctx.now(), s.ends_at) + policy.scheme_hold_days * DAY;
  await atomic(ctx, async () => [
    ...(await ledgerStmts(ctx, winners.map((uid) => ({ account_id: uid, kind: 'adjustment', amount_minor: s.bonus_minor, eligible_at: eligible, ref: `scheme:${s.id}:${uid}`, memo: `scheme: ${s.name}` })))),
    { sql: "UPDATE schemes SET status='settled' WHERE id=? AND status='active'", params: [s.id] },
    ...(await auditStmts(ctx, [{ action: 'scheme.settle', target: `scheme:${s.id}`, meta: { winners: winners.length, bonus_minor: s.bonus_minor } }])),
  ]);
  return { scheme_id: s.id, winners: winners.length, bonus_minor: s.bonus_minor, eligible_at: eligible };
}

export async function leaderboard(ctx, sinceMs, limit = 10) {
  return ctx.db.all(
    `SELECT u.id AS user_id, u.name, u.role, COUNT(*) AS sales, SUM(s.net_minor) AS net_minor FROM sales s JOIN users u ON u.id = s.user_id
      WHERE s.status='recorded' AND s.paid_at >= ? GROUP BY s.user_id ORDER BY net_minor DESC LIMIT ?`, [sinceMs, limit]);
}
