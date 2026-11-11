// HTTP surface. One function, handle(ctx, request) -> Response, shared by the Cloudflare Pages Function and the local dev server.

import { HttpError, json, isInt, needStr } from './util.js';
import { authenticate, bearer, requireScope, requireKind, rateLimit, verifySiteSignature, createKey, revokeKey, siteSecret, OWNER_ONLY_SCOPES } from './auth.js';
import { atomic, auditStmts, verifyLedger, verifyAudit } from './chain.js';
import { getPolicy, POLICY_VALIDATORS } from './policy.js';
import * as U from './users.js';
import * as L from './links.js';
import * as S from './sales.js';
import * as P from './payouts.js';
import * as SC from './schemes.js';
import * as PR from './prospects.js';
import { handleRazorpayWebhook } from './razorpay.js';

const MAX_BODY = 64 * 1024;
const routes = [];
const route = (method, pattern, opts, fn) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$');
  routes.push({ method, re, keys, opts, fn });
};

// ---------------------------------------------------------------- public
route('GET', '/v1/health', { auth: 'public' }, async ({ ctx }) => ({ ok: true, time: ctx.now() }));

route('GET', '/v1/public/sites', { auth: 'public', cors: true }, async ({ ctx }) =>
  (await ctx.db.all('SELECT id,name,host,discount_allowed,max_discount_bps,return_days FROM sites WHERE active=1 ORDER BY name')));

// (idem:false: the response holds a login key, which must never be cached)
route('POST', '/v1/register', { auth: 'public', ipLimit: [10, 3600000], idem: false }, async ({ ctx, body }) => [201, await U.register(ctx, body)]);

route('POST', '/v1/webhooks/razorpay', { auth: 'public', raw: true, idem: false }, async ({ ctx, req, rawBody }) => handleRazorpayWebhook(ctx, req, rawBody));

// ---------------------------------------------------------------- site integration
route('GET', '/v1/integration/links/:slug', { auth: 'site' }, async ({ ctx, actor, params }) => L.resolveLink(ctx, actor.site, params.slug));
route('POST', '/v1/integration/codes/validate', { auth: 'site' }, async ({ ctx, actor, body }) => L.validateCode(ctx, actor.site, body?.code));
route('POST', '/v1/integration/leads', { auth: 'site' }, async ({ ctx, actor, body }) => [201, await L.recordLead(ctx, actor.site, body || {})]);
route('POST', '/v1/integration/sales', { auth: 'signed' }, async ({ ctx, actor, body }) => {
  const r = await S.recordSale(ctx, actor.site, body);
  return [r.duplicate ? 200 : 201, r];
});
route('POST', '/v1/integration/refunds', { auth: 'signed' }, async ({ ctx, actor, body }) => S.recordRefund(ctx, actor.site, body || {}));

// ---------------------------------------------------------------- who am I (any valid key)
route('GET', '/v1/whoami', { auth: 'any' }, async ({ actor }) => ({
  kind: actor.type, scopes: actor.scopes, user: actor.user ? U.publicUser(actor.user) : null, site_id: actor.site?.id ?? null,
}));

// ---------------------------------------------------------------- me
const me = { auth: 'user' };
route('GET', '/v1/me', me, async ({ ctx, actor }) => ({ ...U.publicUser(actor.user), kyc: await U.kycView(ctx, actor.user.id), sponsor: actor.user.parent_id ? (await ctx.db.first('SELECT name,handle,role FROM users WHERE id=?', [actor.user.parent_id])) : null }));
route('PATCH', '/v1/me', me, async ({ ctx, actor, body }) => U.publicUser(await U.updateProfile(ctx, actor.user, body || {})));
route('POST', '/v1/me/email/send-code', me, async ({ ctx, actor }) => U.sendEmailCode(ctx, actor.user, rateLimit));
route('POST', '/v1/me/email/verify', me, async ({ ctx, actor, body }) => U.verifyEmailCode(ctx, actor.user, needStr(body?.code, 'code', 12)));
route('GET', '/v1/me/kyc', me, async ({ ctx, actor }) => U.kycView(ctx, actor.user.id));
route('PUT', '/v1/me/kyc', me, async ({ ctx, actor, body }) => U.submitKyc(ctx, actor.user, body || {}));
route('GET', '/v1/me/team', me, async ({ ctx, actor }) => ({ members: await U.teamOf(ctx, actor.user.id) }));
route('GET', '/v1/me/links', me, async ({ ctx, actor }) => ({ links: await L.listLinks(ctx, actor.user.id) }));
route('POST', '/v1/me/links', me, async ({ ctx, actor, body }) => [201, await L.createLink(ctx, actor.user, body || {})]);
route('GET', '/v1/me/prospects', me, async ({ ctx, actor }) => ({ prospects: await PR.listProspects(ctx, actor.user.id) }));
route('POST', '/v1/me/prospects', me, async ({ ctx, actor, body }) => [201, await PR.registerProspect(ctx, actor.user, body || {})]);
route('GET', '/v1/me/codes', me, async ({ ctx, actor }) => ({ codes: await L.listCodes(ctx, actor.user.id) }));
route('POST', '/v1/me/codes', me, async ({ ctx, actor, body }) => [201, await L.createCode(ctx, actor.user, body || {})]);
route('DELETE', '/v1/me/codes/:code', me, async ({ ctx, actor, params }) => L.deactivateCode(ctx, params.code, actor.user.id));
route('GET', '/v1/me/sales', me, async ({ ctx, actor }) => ({ sales: await S.listSales(ctx, actor.user.id) }));
route('GET', '/v1/me/balance', me, async ({ ctx, actor }) => P.balances(ctx, actor.user.id));
route('GET', '/v1/me/ledger', me, async ({ ctx, actor }) => ({
  entries: (await ctx.db.all('SELECT seq,ts,kind,amount_minor,eligible_at,memo,sale_id,payout_id FROM ledger WHERE account_id=? ORDER BY seq DESC LIMIT 100', [actor.user.id])),
}));
route('GET', '/v1/me/payouts', me, async ({ ctx, actor }) => ({ payouts: await P.listPayouts(ctx, actor.user.id) }));
route('POST', '/v1/me/payouts', me, async ({ ctx, actor }) => [201, await P.requestPayout(ctx, actor.user)]);
route('GET', '/v1/me/schemes', me, async ({ ctx, actor }) => {
  const live = await SC.listSchemes(ctx, true);
  return { schemes: await Promise.all(live.map((s) => SC.progressFor(ctx, s, actor.user.id))) };
});
route('GET', '/v1/leaderboard', me, async ({ ctx }) => ({
  month: (await SC.leaderboard(ctx, ctx.now() - 30 * 86400000)).map((r) => ({ handle: r.handle, first_name: String(r.name || '').split(' ')[0], sales: r.sales, net_minor: r.net_minor })),
}));

route('GET', '/v1/me/summary', me, async ({ ctx, actor }) => {
  const u = actor.user;
  const since = ctx.now() - 30 * 86400000;
  const n = async (sql, p) => (await ctx.db.first(sql, p)).n || 0;
  const team = await U.teamOf(ctx, u.id);
  const ids = team.map((t) => t.id);
  const teamNet = ids.length ? await n(`SELECT SUM(net_minor) AS n FROM sales WHERE status='recorded' AND paid_at>=? AND user_id IN (${ids.map(() => '?').join(',')})`, [since, ...ids]) : 0;
  return {
    role: u.role, status: u.status, email_verified: !!u.email_verified,
    last_30_days: {
      clicks: await n('SELECT COUNT(*) AS n FROM clicks WHERE user_id=? AND ts>=?', [u.id, since]),
      leads: await n('SELECT COUNT(*) AS n FROM leads WHERE user_id=? AND ts>=?', [u.id, since]),
      sales: await n("SELECT COUNT(*) AS n FROM sales WHERE user_id=? AND status='recorded' AND paid_at>=?", [u.id, since]),
      net_minor: await n("SELECT SUM(net_minor) AS n FROM sales WHERE user_id=? AND status='recorded' AND paid_at>=?", [u.id, since]),
      team_net_minor: teamNet,
    },
    team_size: team.length,
    balance: await P.balances(ctx, u.id),
    kyc_status: (await U.kycView(ctx, u.id)).status,
  };
});

route('GET', '/v1/me/logs', me, async ({ ctx, actor }) => {
  const id = actor.user.id;
  const rows = [
    ...(await ctx.db.all("SELECT ts,'click' AS type,site_id AS what,'counted' AS result FROM clicks WHERE user_id=? ORDER BY ts DESC LIMIT 40", [id])),
    ...(await ctx.db.all("SELECT ts,'lead' AS type,site_id AS what,source AS result FROM leads WHERE user_id=? ORDER BY ts DESC LIMIT 40", [id])),
    ...(await ctx.db.all("SELECT paid_at AS ts,'sale' AS type,site_id AS what,CASE WHEN status='blocked' THEN 'blocked: '||block_reason WHEN status='refunded' THEN 'refunded' ELSE 'held until '||eligible_at END AS result FROM sales WHERE user_id=? ORDER BY paid_at DESC LIMIT 40", [id])),
    ...(await ctx.db.all("SELECT created_at AS ts,'payout' AS type,destination_masked AS what,status AS result FROM payouts WHERE user_id=? ORDER BY created_at DESC LIMIT 20", [id])),
    ...(await ctx.db.all("SELECT ts,'action' AS type,action AS what,'' AS result FROM audit_log WHERE actor_id=? ORDER BY seq DESC LIMIT 40", [id])),
  ].sort((a, b) => b.ts - a.ts).slice(0, 100);
  return { logs: rows };
});

// ---------------------------------------------------------------- admin (owner / AI)
const adm = (scope) => ({ auth: 'admin', scope });
route('GET', '/v1/admin/queue', adm('admin.read'), async ({ ctx }) => P.approvalQueue(ctx));

route('GET', '/v1/admin/summary', adm('admin.read'), async ({ ctx }) => {
  const rows = (sql, p) => ctx.db.all(sql, p);
  return {
    users: await rows('SELECT role,status,COUNT(*) AS n FROM users GROUP BY role,status'),
    sales: await rows("SELECT site_id,status,COUNT(*) AS n,SUM(net_minor) AS net_minor FROM sales GROUP BY site_id,status"),
    owed_minor: (await ctx.db.first('SELECT COALESCE(SUM(amount_minor),0) AS n FROM ledger')).n,
    paid_minor: (await ctx.db.first("SELECT COALESCE(SUM(gross_minor),0) AS n FROM payouts WHERE status='paid'")).n,
    open_payouts: (await ctx.db.first("SELECT COUNT(*) AS n FROM payouts WHERE status IN ('pending_approval','approved','processing')")).n,
    flagged_refunds: (await ctx.db.first('SELECT COUNT(*) AS n FROM sales WHERE refund_after_maturity=1')).n,
  };
});

route('GET', '/v1/admin/users', adm('admin.read'), async ({ ctx, url }) => {
  const where = [];
  const p = [];
  for (const f of ['role', 'status']) if (url.searchParams.get(f)) { where.push(`u.${f}=?`); p.push(url.searchParams.get(f)); }
  const rows = await ctx.db.all(`SELECT u.*, COALESCE(k.status,'none') AS kyc_status FROM users u LEFT JOIN user_kyc k ON k.user_id=u.id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY u.created_at DESC LIMIT 200`, p);
  return { users: rows.map((u) => ({ ...U.publicUser(u), kyc_status: u.kyc_status })) };
});

route('POST', '/v1/admin/users', { ...adm('users.create'), idem: false }, async ({ ctx, actor, body }) => {
  const status = actor.type === 'owner' ? 'active' : 'pending'; // an AI key can propose staff; the owner approves
  const user = await U.createUser(ctx, { ...(body || {}), status });
  const out = { user: U.publicUser(user) };
  if (status === 'active') out.api_key = (await createKey(ctx, { kind: 'user', user_id: user.id, label: 'created by owner', created_by: actor.keyId })).token;
  return [201, out];
});

route('POST', '/v1/admin/users/:id/approve', adm('users.approve'), async ({ ctx, params }) => {
  const u = await U.setStatus(ctx, params.id, 'active', 'approved');
  return U.publicUser(u);
});
route('POST', '/v1/admin/users/:id/suspend', adm('users.suspend'), async ({ ctx, params, body }) => U.publicUser(await U.setStatus(ctx, params.id, 'suspended', body?.why)));
route('POST', '/v1/admin/users/:id/reinstate', adm('users.approve'), async ({ ctx, params }) => U.publicUser(await U.setStatus(ctx, params.id, 'active', 'reinstated')));
route('POST', '/v1/admin/users/:id/kyc/review', adm('kyc.verify'), async ({ ctx, params, body }) => U.reviewKyc(ctx, params.id, body?.approve === true, body?.note));
route('POST', '/v1/admin/users/:id/codes', adm('codes.write'), async ({ ctx, params, body }) => [201, await L.createCode(ctx, null, body || {}, { asAdmin: true, forUserId: params.id })]);

route('GET', '/v1/admin/policy', adm('admin.read'), async ({ ctx }) => getPolicy(ctx));
route('PUT', '/v1/admin/policy', adm('policy.write'), async ({ ctx, body }) => {
  const entries = Object.entries(body || {});
  if (!entries.length) throw new HttpError(422, 'invalid_body', 'send at least one policy key');
  for (const [k, v] of entries) {
    if (!POLICY_VALIDATORS[k]) throw new HttpError(422, 'unknown_policy', `${k} is not a policy key`);
    if (!POLICY_VALIDATORS[k](v)) throw new HttpError(422, 'invalid_policy', `${k} has an out-of-range or malformed value`);
  }
  await atomic(ctx, async () => [
    ...entries.map(([k, v]) => ({ sql: 'INSERT INTO policy (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at', params: [k, JSON.stringify(v), ctx.now()] })),
    ...(await auditStmts(ctx, [{ action: 'policy.update', target: 'policy', meta: Object.fromEntries(entries) }])),
  ]);
  return getPolicy(ctx);
});

route('GET', '/v1/admin/sites', adm('admin.read'), async ({ ctx }) => ({ sites: await ctx.db.all('SELECT * FROM sites ORDER BY name') }));
route('PATCH', '/v1/admin/sites/:id', adm('policy.write'), async ({ ctx, params, body }) => {
  const site = await ctx.db.first('SELECT * FROM sites WHERE id=?', [params.id]);
  if (!site) throw new HttpError(404, 'not_found', 'site not found');
  const rules = {
    commission_bps: (v) => isInt(v, 0, 5000), refer_bps: (v) => isInt(v, 0, 5000), return_days: (v) => isInt(v, 0, 365), buffer_days: (v) => isInt(v, 0, 60),
    discount_allowed: (v) => v === 0 || v === 1, max_discount_bps: (v) => isInt(v, 0, 5000), active: (v) => v === 0 || v === 1,
  };
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(body || {})) {
    if (!rules[k]) throw new HttpError(422, 'unknown_field', `${k} cannot be changed here`);
    if (!rules[k](v)) throw new HttpError(422, 'invalid_field', `${k} out of range`);
    sets.push(`${k}=?`); vals.push(v);
  }
  if (!sets.length) throw new HttpError(422, 'invalid_body', 'nothing to change');
  await atomic(ctx, async () => [
    { sql: `UPDATE sites SET ${sets.join(',')} WHERE id=?`, params: [...vals, params.id] },
    ...(await auditStmts(ctx, [{ action: 'site.update', target: `site:${params.id}`, meta: body }])),
  ]);
  return ctx.db.first('SELECT * FROM sites WHERE id=?', [params.id]);
});
route('GET', '/v1/admin/sites/:id/secret', adm('keys.manage'), async ({ ctx, params }) => {
  const site = await ctx.db.first('SELECT * FROM sites WHERE id=?', [params.id]);
  if (!site) throw new HttpError(404, 'not_found', 'site not found');
  await atomic(ctx, () => auditStmts(ctx, [{ action: 'site.secret_revealed', target: `site:${site.id}` }]));
  return { site_id: site.id, secret_version: site.secret_version, signing_secret: await siteSecret(ctx, site) };
});
route('POST', '/v1/admin/sites/:id/rotate-secret', adm('keys.manage'), async ({ ctx, params }) => {
  const r = await ctx.db.run('UPDATE sites SET secret_version = secret_version + 1 WHERE id=?', [params.id]);
  if (!r.changes) throw new HttpError(404, 'not_found', 'site not found');
  await atomic(ctx, () => auditStmts(ctx, [{ action: 'site.secret_rotated', target: `site:${params.id}` }]));
  return { rotated: true };
});

route('GET', '/v1/admin/keys', adm('keys.manage'), async ({ ctx }) => ({
  keys: (await ctx.db.all('SELECT id,kind,user_id,site_id,label,scopes,rate_per_min,created_at,revoked_at,last_used_at FROM api_keys ORDER BY created_at DESC LIMIT 200')).map((k) => ({ ...k, scopes: JSON.parse(k.scopes) })),
}));
route('POST', '/v1/admin/keys', { ...adm('keys.manage'), idem: false }, async ({ ctx, actor, body }) => {
  const b = body || {};
  const k = await createKey(ctx, { kind: b.kind, user_id: b.user_id, site_id: b.site_id, label: b.label ? String(b.label).slice(0, 80) : null, scopes: b.scopes, rate_per_min: b.rate_per_min ?? 120, created_by: actor.keyId });
  await atomic(ctx, () => auditStmts(ctx, [{ action: 'key.create', target: `key:${k.id}`, meta: { kind: k.kind, scopes: k.scopes } }]));
  return [201, { id: k.id, kind: k.kind, scopes: k.scopes, token: k.token, note: 'Shown once. Store it in a secret manager.' }];
});
route('DELETE', '/v1/admin/keys/:id', adm('keys.manage'), async ({ ctx, params }) => {
  await revokeKey(ctx, params.id);
  await atomic(ctx, () => auditStmts(ctx, [{ action: 'key.revoke', target: `key:${params.id}` }]));
  return { revoked: true };
});

route('GET', '/v1/admin/audit', adm('admin.read'), async ({ ctx, url }) => {
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
  const actorType = url.searchParams.get('actor_type');
  const rows = await ctx.db.all(`SELECT seq,ts,actor_type,actor_id,key_id,action,target,meta FROM audit_log ${actorType ? 'WHERE actor_type=?' : ''} ORDER BY seq DESC LIMIT ?`, actorType ? [actorType, limit] : [limit]);
  return { entries: rows.map((r) => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : null })) };
});
route('GET', '/v1/admin/verify', adm('admin.read'), async ({ ctx }) => ({ ledger: await verifyLedger(ctx.db), audit: await verifyAudit(ctx.db) }));

route('GET', '/v1/admin/payouts', adm('admin.read'), async ({ ctx, url }) => {
  const st = url.searchParams.get('status');
  return { payouts: (await ctx.db.all(`SELECT * FROM payouts ${st ? 'WHERE status=?' : ''} ORDER BY created_at DESC LIMIT 200`, st ? [st] : [])).map(P.payoutView) };
});
route('POST', '/v1/admin/payouts/:id/approve', adm('payouts.approve'), async ({ ctx, params }) => P.approvePayout(ctx, params.id));
route('POST', '/v1/admin/payouts/:id/reject', adm('payouts.approve'), async ({ ctx, params, body }) => P.rejectPayout(ctx, params.id, body?.note));
route('POST', '/v1/admin/payouts/:id/execute', adm('payouts.approve'), async ({ ctx, params }) => P.executePayout(ctx, params.id));
route('POST', '/v1/admin/payouts/:id/mark-paid', adm('payouts.approve'), async ({ ctx, params, body }) => {
  const p = await ctx.db.first('SELECT * FROM payouts WHERE id=?', [params.id]);
  if (p && p.provider !== 'manual') throw new HttpError(409, 'not_manual', 'only manually-paid payouts are recorded by hand; provider payouts settle through the provider webhook');
  return P.markPaid(ctx, params.id, needStr(body?.reference, 'reference', 80));
});
route('POST', '/v1/admin/payouts/:id/mock-settle', adm('payouts.approve'), async ({ ctx, params }) => {
  if (ctx.payouts.mode !== 'mock') throw new HttpError(403, 'not_mock', 'mock settlement exists only in mock payout mode');
  return P.markPaid(ctx, params.id, `UTR_MOCK_${params.id.slice(-8)}`);
});

route('GET', '/v1/admin/schemes', adm('admin.read'), async ({ ctx }) => ({ schemes: await SC.listSchemes(ctx, false) }));
route('POST', '/v1/admin/schemes', adm('schemes.write'), async ({ ctx, body }) => [201, await SC.createScheme(ctx, body || {})]);
route('POST', '/v1/admin/schemes/:id/activate', adm('schemes.activate'), async ({ ctx, params }) => SC.setSchemeStatus(ctx, params.id, 'active'));
route('POST', '/v1/admin/schemes/:id/cancel', adm('schemes.write'), async ({ ctx, params }) => SC.setSchemeStatus(ctx, params.id, 'cancelled'));
route('POST', '/v1/admin/schemes/:id/settle', adm('schemes.settle'), async ({ ctx, params }) => SC.settleScheme(ctx, params.id));

// ---------------------------------------------------------------- dispatcher
const SEC_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };

const clientIp = (req) => req.headers.get('cf-connecting-ip') || null;

async function readBody(req) {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return { rawBody: '', body: undefined };
  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY) throw new HttpError(413, 'too_large', 'request body too large');
  if (!rawBody.trim()) return { rawBody, body: undefined };
  try { return { rawBody, body: JSON.parse(rawBody) }; } catch { return { rawBody, body: Symbol.for('bad-json') }; }
}

async function idempotent(ctx, scopeKey, rawBody, run) {
  const reqHash = await ctx.hash(rawBody);
  const prev = await ctx.db.first('SELECT * FROM idempotency WHERE scope=?', [scopeKey]);
  if (prev) {
    if (prev.req_hash !== reqHash) throw new HttpError(422, 'idempotency_conflict', 'this Idempotency-Key was already used with a different request');
    return { status: prev.status, data: JSON.parse(prev.body), replay: true };
  }
  const out = await run();
  if (Math.random() < 0.02) await ctx.db.run('DELETE FROM idempotency WHERE created_at < ?', [ctx.now() - 7 * 86400000]); // opportunistic cleanup
  if (out.status < 500) {
    await ctx.db.run('INSERT OR IGNORE INTO idempotency (scope,req_hash,status,body,created_at) VALUES (?,?,?,?,?)', [scopeKey, reqHash, out.status, JSON.stringify(out.data), ctx.now()]);
  }
  return out;
}

export async function handle(ctx, req) {
  const url = new URL(req.url);
  const path = url.pathname;
  try {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', ...SEC_HEADERS } });

    if (req.method === 'GET' && /^\/r\/[a-z0-9]+$/.test(path)) {
      const ip = clientIp(req);
      await rateLimit(ctx, `ip:${ip || 'unknown'}:r`, 120);
      const to = await L.followLink(ctx, path.slice(3), ip);
      return new Response(null, { status: 302, headers: { location: to, 'cache-control': 'no-store', ...SEC_HEADERS } });
    }

    let match = null;
    let params = {};
    let pathMatched = false;
    for (const r of routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== req.method) continue;
      match = r;
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      break;
    }
    if (!match) throw pathMatched ? new HttpError(405, 'method_not_allowed', 'method not allowed') : new HttpError(404, 'not_found', 'no such endpoint');

    const { rawBody, body } = await readBody(req);
    if (body === Symbol.for('bad-json')) throw new HttpError(400, 'invalid_json', 'body is not valid JSON');
    const o = match.opts;
    let actor = null;
    if (o.ipLimit) await rateLimit(ctx, `ip:${clientIp(req) || 'unknown'}:${match.re.source}`, o.ipLimit[0], o.ipLimit[1]);

    if (o.auth === 'any') {
      actor = await authenticate(ctx, req);
      if (!actor) throw new HttpError(401, 'auth_required', 'API key required');
    } else if (o.auth === 'user') {
      actor = await authenticate(ctx, req);
      requireKind(actor, 'user');
    } else if (o.auth === 'admin') {
      actor = await authenticate(ctx, req);
      requireKind(actor, 'owner', 'ai');
      requireScope(actor, o.scope);
      if (actor.type === 'ai' && OWNER_ONLY_SCOPES.includes(o.scope)) throw new HttpError(403, 'forbidden', 'only the owner can do this');
    } else if (o.auth === 'site') {
      actor = bearer(req) ? await authenticate(ctx, req) : null;
      if (actor) requireKind(actor, 'site');
      else actor = { type: 'site', keyId: null, scopes: ['integration'], site: await verifySiteSignature(ctx, req, rawBody) };
    } else if (o.auth === 'signed') {
      actor = { type: 'site', keyId: null, scopes: ['integration'], site: await verifySiteSignature(ctx, req, rawBody) };
    }
    if (actor) {
      actor.id = actor.type === 'site' ? actor.site.id : actor.type === 'user' ? actor.user.id : null;
      ctx.actor = actor;
    }

    const call = async () => {
      let out = await match.fn({ ctx, req, url, params, body, rawBody, actor });
      let status = 200;
      if (Array.isArray(out) && typeof out[0] === 'number') [status, out] = out;
      return { status, data: out };
    };
    const idemKey = req.headers.get('idempotency-key');
    let res;
    if (idemKey && req.method === 'POST' && o.idem !== false) {
      if (idemKey.length > 100) throw new HttpError(422, 'invalid_field', 'Idempotency-Key too long');
      res = await idempotent(ctx, `${actor?.keyId || actor?.id || clientIp(req) || 'anon'}:${path}:${idemKey}`, rawBody, call);
    } else res = await call();

    const headers = { ...SEC_HEADERS };
    if (o.cors) headers['access-control-allow-origin'] = '*';
    if (res.replay) headers['idempotent-replay'] = 'true';
    return json(res.data, res.status, headers);
  } catch (e) {
    return errorResponse(e);
  }
}

export function errorResponse(e) {
  if (e instanceof HttpError) {
    const headers = { ...SEC_HEADERS };
    if (e.status === 429 && e.extra?.retry_after_s) headers['retry-after'] = String(e.extra.retry_after_s);
    return json({ error: { code: e.code, message: e.message, ...(e.extra || {}) } }, e.status, headers);
  }
  console.error('unhandled', e?.stack || e); // message only goes to server logs; never echo internals to the client
  return json({ error: { code: 'internal_error', message: 'something went wrong' } }, 500, SEC_HEADERS);
}

