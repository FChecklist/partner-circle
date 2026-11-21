// The suite front door: tenant profile, provisioning into the engines, the one dashboard (with cache and degraded mode),
// commission posting to Moneypenny (no double pay) and the conversion request.
//
// Rules this file keeps:
//  * A partner never logs in to an engine. Every engine call is made here, on the server, signed.
//  * An engine being down never blocks sign-up, approval, sale recording or the page: the block shows the last known numbers, labelled, or a soft line.
//  * A matured commission is paid in ONE place: the payout flow (commission_dest='ledger', today's policy) or Moneypenny
//    (commission_dest='moneypenny'). The claim is an atomic batch and database triggers refuse a second claim.
//  * Text that comes back from an engine is untrusted: only whitelisted fields, clipped and stripped of markup. Money decisions are never made from cache.

import { HttpError, isInt } from './util.js';
import { atomic, auditStmts, ledgerStmts } from './chain.js';
import { balances } from './payouts.js';
import { EngineError } from './engines.js';

const FRESH_MS = 45_000;
const MAX_ATTEMPTS = 10;
const NO_CREDIT_REASONS = new Set(['no_rule', 'sale_ref_required', 'payer_required', 'no_cash_no_commission']);
const TRANSIENT_REASONS = new Set(['too_many_events', 'over_event_limit', 'daily_cap_reached']);

const clean = (s, n = 60) => String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, n);
const num = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);
const backoff = (attempts) => Math.min(6 * 3600_000, 60_000 * 2 ** Math.min(attempts, 12));

// ------------------------------------------------------------------ tenant profile (branding, wording, switches)

export async function getProfile(ctx) {
  return ctx.db.first('SELECT * FROM tenant_profile WHERE id=?', ['self']);
}

export const publicBrand = async (ctx) => {
  const p = await getProfile(ctx);
  return { product_name: p.product_name, accent: p.accent, logo_url: p.logo_url, currency_label: p.currency_label, credits_per_usd: p.credits_per_usd };
};

const bit = (v) => v === 0 || v === 1;
const PROFILE_RULES = {
  slug: (v) => typeof v === 'string' && /^[a-z0-9][a-z0-9-]{1,39}$/.test(v),
  product_name: (v) => typeof v === 'string' && /^[^<>\u0000-\u001f]{2,60}$/.test(v.trim()),
  accent: (v) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v),
  logo_url: (v) => v === null || (typeof v === 'string' && v.length <= 200 && /^https:\/\/[a-z0-9.-]+(\/[^\s"'<>]*)?$/i.test(v)),
  currency_label: (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ]{1,23}$/.test(v),
  credits_per_usd: (v) => isInt(v, 1, 100000),
  commission_dest: (v) => v === 'ledger' || v === 'moneypenny',
  mnp_enabled: bit,
  mono_enabled: bit,
};

export async function updateProfile(ctx, body) {
  const entries = Object.entries(body || {});
  if (!entries.length) throw new HttpError(422, 'invalid_body', 'send at least one field');
  for (const [k, v] of entries) {
    if (!Object.hasOwn(PROFILE_RULES, k)) throw new HttpError(422, 'unknown_field', `${k} cannot be changed here`);
    if (!PROFILE_RULES[k](v)) throw new HttpError(422, 'invalid_field', `${k} is malformed or out of range`);
  }
  const cur = await getProfile(ctx);
  const next = { ...cur, ...Object.fromEntries(entries.map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v])) };
  if (next.commission_dest === 'moneypenny' && cur.commission_dest !== 'moneypenny') {
    if (!ctx.engines.mnp) throw new HttpError(409, 'engine_not_connected', 'connect Moneypenny first (MNP_BASE_URL, MNP_KEY_ID, MNP_SECRET) before sending commissions there');
    if (!next.mnp_enabled) throw new HttpError(409, 'engine_off', 'switch the Moneypenny engine on first');
    // v1 ruling: commission to Moneypenny stays OFF until Moneypenny accepts these postings (docs/SUITE.md). Explicit server switch, not a UI toggle.
    if (ctx.env.MNP_COMMISSION_ENABLED !== '1') throw new HttpError(409, 'not_in_v1', 'sending commissions to Moneypenny is not enabled in this version');
  }
  if (next.commission_dest === 'moneypenny' && !next.mnp_enabled) throw new HttpError(409, 'engine_off', 'cannot switch Moneypenny off while commissions are sent there: claims would be stranded');
  const cols = entries.map(([k]) => k);
  await atomic(ctx, async () => [
    { sql: `UPDATE tenant_profile SET ${cols.map((c) => `${c}=?`).join(',')}, updated_at=? WHERE id='self'`, params: [...cols.map((c) => next[c]), ctx.now()] },
    ...(await auditStmts(ctx, [{ action: 'tenant.update', target: 'tenant:self', meta: Object.fromEntries(entries) }])),
  ]);
  return getProfile(ctx);
}

// ------------------------------------------------------------------ provisioning (signed API, no second login)

export async function enqueueLinks(ctx, userId, desired = 'active') {
  for (const engine of ['mnp', 'mono']) {
    await ctx.db.run(
      `INSERT INTO engine_links (user_id, engine, desired, state, attempts, next_try_at) VALUES (?,?,?,'pending',0,0)
       ON CONFLICT(user_id, engine) DO UPDATE SET desired=excluded.desired, state=CASE WHEN engine_links.desired=excluded.desired AND engine_links.state='linked' THEN 'linked' ELSE 'pending' END,
         attempts=CASE WHEN engine_links.desired=excluded.desired THEN engine_links.attempts ELSE 0 END, next_try_at=CASE WHEN engine_links.desired=excluded.desired THEN engine_links.next_try_at ELSE 0 END`,
      [userId, engine, desired]);
  }
}

/** Try every due link of one person. Never throws: a failed engine is retried later with back-off. */
export async function syncUser(ctx, userId) {
  const prof = await getProfile(ctx);
  const links = await ctx.db.all("SELECT * FROM engine_links WHERE user_id=? AND state<>'linked' AND next_try_at<=?", [userId, ctx.now()]);
  if (!links.length) return;
  const u = await ctx.db.first('SELECT * FROM users WHERE id=?', [userId]);
  for (const l of links) {
    const adapter = ctx.engines[l.engine];
    const on = l.engine === 'mnp' ? prof.mnp_enabled : prof.mono_enabled;
    if (!adapter || !on) continue;
    if (!u || !u.email || u.erased_at || (l.desired === 'active' && (u.status !== 'active' || !u.email_verified))) continue;
    try {
      if (l.engine === 'mono') {
        if (l.desired === 'suspended') await adapter.suspend({ email: u.email });
        else await adapter.provision({ email: u.email, name: clean(u.name, 120), role: u.role, team_ref: u.parent_id });
      } else if (l.desired === 'active') {
        await adapter.balance(u.email); // Moneypenny makes an account on first credit; this proves the door works for this person
      } // Moneypenny has no suspend call: earning stops on this side; credits already granted stay there (recorded below as no_remote_suspend)
      await atomic(ctx, async () => [
        { sql: "UPDATE engine_links SET state='linked', attempts=attempts+1, last_error=NULL, linked_at=? WHERE user_id=? AND engine=? AND desired=?", params: [ctx.now(), userId, l.engine, l.desired] },
        ...(await auditStmts({ ...ctx, actor: { type: 'system' } }, [{ action: 'engine.link', target: `user:${userId}`, meta: { engine: l.engine, desired: l.desired, ...(l.engine === 'mnp' && l.desired === 'suspended' ? { note: 'no_remote_suspend' } : {}) } }])),
      ]);
    } catch (e) {
      const attempts = l.attempts + 1;
      await ctx.db.run("UPDATE engine_links SET attempts=?, last_error=?, state=?, next_try_at=? WHERE user_id=? AND engine=? AND desired=?",
        [attempts, clean(e?.code || e?.message, 80), attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', ctx.now() + backoff(attempts), userId, l.engine, l.desired]);
    }
  }
}

// ------------------------------------------------------------------ the dashboard

async function cachedBlock(ctx, userId, name, enabled, adapter, fetcher, normalize) {
  if (!adapter) return { status: 'not_connected' };
  if (!enabled) return { status: 'off' };
  const row = await ctx.db.first('SELECT body, fetched_at FROM engine_cache WHERE user_id=? AND block=?', [userId, name]);
  if (row && ctx.now() - row.fetched_at < FRESH_MS) return { status: 'live', as_of: row.fetched_at, data: JSON.parse(row.body) };
  try {
    const data = normalize(await fetcher());
    await ctx.db.run('INSERT INTO engine_cache (user_id,block,body,fetched_at) VALUES (?,?,?,?) ON CONFLICT(user_id,block) DO UPDATE SET body=excluded.body, fetched_at=excluded.fetched_at', [userId, name, JSON.stringify(data), ctx.now()]);
    return { status: 'live', as_of: ctx.now(), data };
  } catch (e) {
    if (row) return { status: 'stale', as_of: row.fetched_at, data: JSON.parse(row.body) };
    return { status: e instanceof EngineError && e.code === 'unknown_person' ? 'setting_up' : 'unavailable' };
  }
}

const normMnp = (b) => ({
  credits: Math.max(0, num(b.credits)), can_convert: Math.max(0, num(b.can_convert)), settling: Math.max(0, num(b.settling)),
  conversion_enabled: !!b.conversion_enabled, inr_minor: b.inr_minor == null ? null : Math.max(0, num(b.inr_minor)),
});
const normTargets = (list) => (Array.isArray(list) ? list : []).slice(0, 20).map((t) => ({
  name: clean(t?.name ?? t?.title, 60), period: clean(t?.period, 20), unit: clean(t?.unit, 20),
  goal: Math.max(0, num(t?.goal ?? t?.target)), progress: Math.max(0, num(t?.progress ?? t?.done)), ends_at: t?.ends_at ? num(t.ends_at) : null,
}));
const normAch = (a) => ({
  level: a?.level == null ? null : clean(a.level, 20),
  badges: (Array.isArray(a?.badges) ? a.badges : []).slice(0, 20).map((b) => ({ name: clean(b?.name ?? b, 60), earned_at: b?.earned_at ? num(b.earned_at) : null })),
});

/** US cents for a number of credits, integer maths, rounded down (never promises more than is owed). */
const usdCents = (credits, cpu) => Math.floor((credits * 100) / cpu);
const money = (cents) => `${Math.floor(cents / 100).toLocaleString('en-US')}.${String(cents % 100).padStart(2, '0')}`;

export function moneypennyLines(prof, d) {
  const label = prof.currency_label;
  const cents = usdCents(d.credits, prof.credits_per_usd);
  const lines = {
    owned: `${d.credits.toLocaleString('en-US')} ${label} (credits) owned = US$${money(cents)}${d.inr_minor != null ? ` (about Rs ${money(d.inr_minor)})` : ''}`,
    rate: `${prof.credits_per_usd} ${label} = 1 US$`,
    convert: null,
  };
  if (d.can_convert > 0 && d.conversion_enabled) lines.convert = `You can convert ${d.can_convert.toLocaleString('en-US')} ${label} (US$${money(usdCents(d.can_convert, prof.credits_per_usd))}) to money`;
  else if (d.can_convert > 0) lines.convert = `${d.can_convert.toLocaleString('en-US')} ${label} can be converted once conversion is switched on`;
  if (d.settling > 0) lines.settling = `${d.settling.toLocaleString('en-US')} ${label} still settling`;
  return lines;
}

const SOFT = {
  stale: 'Showing the last numbers we saw; they will refresh in a moment.',
  unavailable: 'This part is refreshing, back in a moment. Everything else on this page is up to date.',
  setting_up: 'Your account is being set up here. Check again in a minute.',
  not_connected: 'This part is not connected yet.',
  off: 'This part is switched off.',
  verify_email: 'Verify your e-mail to see this part.',
};

export async function dashboard(ctx, user) {
  const prof = await getProfile(ctx);
  // best-effort, never blocks the page. People approved before the suite existed get their link rows here.
  try {
    if (user.status === 'active' && !(await ctx.db.first('SELECT 1 AS x FROM engine_links WHERE user_id=?', [user.id]))) await enqueueLinks(ctx, user.id, 'active');
    await syncUser(ctx, user.id);
  } catch { /* retried later */ }
  if (prof.commission_dest === 'moneypenny') { try { await runPostings(ctx, { userId: user.id, limit: 10 }); } catch { /* retried later */ } }
  const mnpOn = !!prof.mnp_enabled, monoOn = !!prof.mono_enabled;
  // Engines are asked about an e-mail only after the owner of this account proved it (otherwise anyone could read any e-mail's balance).
  const verified = !!(user.email_verified && user.email && user.status === 'active');
  const email = verified ? user.email : null;
  if (!verified) { try { await ctx.db.run('DELETE FROM engine_cache WHERE user_id=?', [user.id]); } catch { /* display cache only */ } }
  const none = { status: verified ? 'unavailable' : 'verify_email' };
  const [mnp, targets, ach] = await Promise.all([
    email ? cachedBlock(ctx, user.id, 'mnp', mnpOn, ctx.engines.mnp, () => ctx.engines.mnp.balance(email), normMnp) : none,
    email ? cachedBlock(ctx, user.id, 'targets', monoOn, ctx.engines.mono, () => ctx.engines.mono.targets(email), normTargets) : none,
    email ? cachedBlock(ctx, user.id, 'achievements', monoOn, ctx.engines.mono, () => ctx.engines.mono.achievements(email), normAch) : none,
  ]);
  const notes = [];
  for (const [k, b] of [['moneypenny', mnp], ['targets', targets], ['achievements', ach]]) if (SOFT[b.status]) notes.push({ block: k, text: SOFT[b.status] });
  const pend = await ctx.db.first("SELECT COALESCE(SUM(m.amount_minor),0) AS n FROM mp_postings m JOIN ledger l ON l.seq=m.ledger_seq JOIN sales s ON s.id=l.sale_id WHERE m.user_id=? AND m.state IN ('pending','rejected','dead') AND s.status='recorded'", [user.id]);
  const done = await ctx.db.first("SELECT COALESCE(SUM(amount_minor),0) AS n FROM mp_postings WHERE user_id=? AND state='posted'", [user.id]);
  return {
    brand: { product_name: prof.product_name, accent: prof.accent, logo_url: prof.logo_url, currency_label: prof.currency_label },
    commissions: { ...(await balances(ctx, user.id)), sent_to_moneypenny_minor: done.n, on_the_way_to_moneypenny_minor: pend.n, destination: prof.commission_dest },
    moneypenny: { status: mnp.status, as_of: mnp.as_of ?? null, ...(mnp.data ? { ...mnp.data, lines: moneypennyLines(prof, mnp.data) } : {}) },
    monopoly: {
      status: targets.status === 'live' || ach.status === 'live' ? (targets.status === 'live' && ach.status === 'live' ? 'live' : 'stale') : targets.status !== 'unavailable' ? targets.status : ach.status,
      as_of: targets.as_of ?? ach.as_of ?? null,
      targets: targets.data || [], achievements: ach.data || { level: null, badges: [] },
    },
    notes,
  };
}

/** A person asks Moneypenny to turn commission credits into money. Always live (never cached); Moneypenny records it and a person approves it there. */
export async function convertRequest(ctx, user, body, idem) {
  if (!idem) throw new HttpError(400, 'idempotency_key_required', 'send an Idempotency-Key header');
  const prof = await getProfile(ctx);
  if (!ctx.engines.mnp || !prof.mnp_enabled) throw new HttpError(503, 'engine_unavailable', 'Moneypenny is not available right now');
  if (user.status !== 'active' || !user.email_verified || !user.email) throw new HttpError(409, 'email_unverified', 'verify your e-mail first');
  if (!isInt(body?.credits, 1, 100_000_000)) throw new HttpError(422, 'invalid_field', 'credits must be a whole number');
  let r;
  try { r = await ctx.engines.mnp.convertRequest({ email: user.email, credits: body.credits, idem: `pcw:${user.id}:${(await ctx.hash(idem)).slice(0, 40)}` }); } catch (e) {
    if (e instanceof EngineError) throw new HttpError(e.definitive ? 422 : 503, e.definitive ? (String(e.code).replace(/[^a-z0-9_]/gi, '').slice(0, 40) || 'refused') : 'engine_unavailable', e.definitive ? clean(e.message, 160) : 'Moneypenny is not available right now; nothing was changed. Try again.');
    throw e;
  }
  await atomic(ctx, () => auditStmts(ctx, [{ action: 'moneypenny.convert_request', target: `user:${user.id}`, meta: { credits: body.credits, request_id: r.request_id } }]));
  await ctx.db.run("DELETE FROM engine_cache WHERE user_id=? AND block='mnp'", [user.id]);
  return r;
}

// ------------------------------------------------------------------ commissions to Moneypenny

const MATURED = `FROM ledger l JOIN sales s ON s.id = l.sale_id JOIN users u ON u.id = l.account_id
 WHERE l.kind IN ('commission','override') AND l.amount_minor > 0 AND l.eligible_at <= ?
   AND s.status = 'recorded' AND s.rzp_status = 'confirmed' AND COALESCE(s.dispute_status,'') <> 'open'
   AND u.status = 'active' AND u.email_verified = 1 AND u.email IS NOT NULL AND u.erased_at IS NULL
   AND EXISTS (SELECT 1 FROM user_kyc k WHERE k.user_id = u.id AND k.status = 'verified')
   AND NOT EXISTS (SELECT 1 FROM payout_items pi WHERE pi.ledger_seq = l.seq)
   AND NOT EXISTS (SELECT 1 FROM mp_postings mp WHERE mp.ledger_seq = l.seq)`;

/**
 * Step 1 (claim): matured entries move from the payout path to the Moneypenny path in ONE atomic batch (claim row + a reserve entry that keeps
 * the ledger balanced + an action-log entry). Step 2 (deliver): each claim is sent to Moneypenny with a stable event key; an unknown outcome is retried
 * with the same key, so it can never pay twice. Only runs when the owner chose commission_dest='moneypenny'.
 */
export async function runPostings(ctx, { userId = null, limit = 25 } = {}) {
  const prof = await getProfile(ctx);
  const mnp = ctx.engines.mnp;
  const out = { claimed: 0, posted: 0, retry: 0, rejected: 0 };
  if (!mnp || !prof.mnp_enabled) return { ...out, skipped: 'moneypenny_off' };
  if (prof.commission_dest === 'moneypenny' && ctx.env.MNP_COMMISSION_ENABLED === '1') { // the v1 switch is checked at claim time too
    const rows = await ctx.db.all(`SELECT l.seq, l.account_id, l.kind, l.amount_minor, l.ref, l.eligible_at, s.razorpay_payment_id AS pid ${MATURED} ${userId ? 'AND l.account_id=?' : ''} ORDER BY l.seq LIMIT ?`,
      userId ? [ctx.now(), userId, limit] : [ctx.now(), limit]);
    for (const r of rows) {
      const saleRef = r.kind === 'commission' ? r.pid : `${r.pid}:override:${r.account_id}`;
      try {
        let did = false;
        await atomic(ctx, async () => {
          // re-check inside the batch builder: a refund or claim that landed since the list was read makes this entry ineligible
          did = false;
          if (!(await ctx.db.first(`SELECT l.seq ${MATURED} AND l.seq=?`, [ctx.now(), r.seq]))) return [];
          did = true;
          return [
            { sql: 'INSERT INTO mp_postings (ledger_seq,user_id,amount_minor,event_key,sale_ref,state,created_at) VALUES (?,?,?,?,?,?,?)', params: [r.seq, r.account_id, r.amount_minor, `pc:${r.ref}`, saleRef, 'pending', ctx.now()] },
            ...(await ledgerStmts(ctx, [{ account_id: r.account_id, kind: 'payout_reserve', amount_minor: -r.amount_minor, eligible_at: ctx.now(), ref: `mpclaim:${r.seq}`, memo: 'sent to Moneypenny' }])),
            ...(await auditStmts({ ...ctx, actor: ctx.actor || { type: 'system' } }, [{ action: 'moneypenny.claim', target: `ledger:${r.seq}`, meta: { amount_minor: r.amount_minor, kind: r.kind } }])),
          ];
        });
        if (did) out.claimed += 1;
      } catch (e) {
        if (!/mp_postings|already belongs to a payout|UNIQUE constraint failed/.test(String(e.message))) throw e; // someone else claimed it first: fine
      }
    }
  }
  // deliver everything claimed and due (even if the owner later switched the destination back: a claim is a promise)
  const due = await ctx.db.all(
    `SELECT p.*, u.email, s.customer_hash, s.id AS sale_id FROM mp_postings p JOIN ledger l ON l.seq = p.ledger_seq JOIN sales s ON s.id = l.sale_id JOIN users u ON u.id = p.user_id
      WHERE p.state='pending' AND p.next_try_at <= ? AND s.status='recorded' AND COALESCE(s.dispute_status,'') <> 'open' AND u.status='active' AND u.email_verified=1 AND u.email IS NOT NULL
        ${userId ? 'AND p.user_id=?' : ''} ORDER BY p.ledger_seq LIMIT ?`, userId ? [ctx.now(), userId, limit] : [ctx.now(), limit]);
  for (const p of due) {
    let state, err = null, granted = null, attempts = p.attempts + 1, definite = false; // definite = Moneypenny answered "not granted": the next try needs a fresh Idempotency-Key
    // Mark "contacted" BEFORE the call, in a batch that also moves the action-log tail (so a concurrent refund rebuilds and sees it). From here a refund flags, never voids.
    let marked = false;
    await atomic(ctx, async () => {
      marked = false;
      // lease: only one run may send a claim at a time (a second concurrent run sees next_try_at in the future and skips)
      const cur = await ctx.db.first("SELECT attempts FROM mp_postings WHERE ledger_seq=? AND state='pending' AND next_try_at <= ?", [p.ledger_seq, ctx.now()]);
      if (!cur) return [];
      marked = true;
      return [
        { sql: "UPDATE mp_postings SET sent_at=COALESCE(sent_at, ?), attempts=attempts+1, next_try_at=? WHERE ledger_seq=? AND state='pending'", params: [ctx.now(), ctx.now() + 120000, p.ledger_seq] }, // attempts counted BEFORE the call: a crash mid-call still counts
        ...(await auditStmts({ ...ctx, actor: ctx.actor || { type: 'system' } }, [{ action: 'moneypenny.send', target: `ledger:${p.ledger_seq}`, meta: { attempt: attempts } }])),
      ];
    });
    if (!marked) continue; // taken back by a refund, or another run holds the lease
    attempts = (await ctx.db.first('SELECT attempts FROM mp_postings WHERE ledger_seq=?', [p.ledger_seq])).attempts; // what the mark step really wrote
    try {
      const r = await mnp.postCommission({
        email: p.email, event_key: p.event_key, cash_minor: p.amount_minor, sale_ref: p.sale_ref, gen: p.gen,
        payer_email: `${String(p.customer_hash || p.sale_id).replace(/[^a-z0-9]/gi, '').slice(0, 40)}@payer.invalid`,
      });
      if ((r.reason === 'granted' && r.granted > 0) || r.reason === 'already_earned') { state = 'posted'; granted = r.granted; }
      else if (!r.reason || r.reason === 'granted') { state = 'pending'; err = 'unclear_answer'; } // ok but nothing granted / no reason: outcome unknown, retry with the same key, never mark posted
      else if (TRANSIENT_REASONS.has(r.reason)) { state = 'pending'; err = r.reason; definite = true; }
      else { state = 'rejected'; err = r.reason; definite = true; }
    } catch (e) {
      err = clean(e?.code || e?.message, 80);
      definite = e instanceof EngineError && e.definitive; // a definite refusal: the retry after a requeue needs a fresh Idempotency-Key
      state = definite ? 'rejected' : attempts >= MAX_ATTEMPTS ? 'dead' : 'pending';
    }
    if (state === 'pending' && attempts >= MAX_ATTEMPTS) state = 'dead';
    await atomic(ctx, async () => [
      { sql: "UPDATE mp_postings SET state=?, last_error=?, next_try_at=?, granted_credits=?, posted_at=?, gen=gen+? WHERE ledger_seq=? AND state='pending'",
        params: [state, err, ctx.now() + backoff(attempts), granted, state === 'posted' ? ctx.now() : null, definite ? 1 : 0, p.ledger_seq] },
      ...(await auditStmts({ ...ctx, actor: ctx.actor || { type: 'system' } }, [{ action: `moneypenny.${state === 'pending' ? 'retry' : state}`, target: `ledger:${p.ledger_seq}`, meta: { reason: err, granted, attempts } }])),
    ]);
    await ctx.db.run("DELETE FROM engine_cache WHERE user_id=? AND block='mnp'", [p.user_id]);
    if (state === 'posted') out.posted += 1; else if (state === 'pending') out.retry += 1; else out.rejected += 1;
  }
  return out;
}

/** Owner: put a rejected or dead posting back in the queue after the cause (a missing Moneypenny rule, say) is fixed. Same event key, so it still cannot pay twice. */
export async function requeuePosting(ctx, seq) {
  const p = await ctx.db.first('SELECT * FROM mp_postings WHERE ledger_seq=?', [seq]);
  if (!p) throw new HttpError(404, 'not_found', 'posting not found');
  if (!['rejected', 'dead'].includes(p.state)) throw new HttpError(409, 'bad_state', `a ${p.state} posting cannot be requeued`);
  await atomic(ctx, async () => [
    { sql: "UPDATE mp_postings SET state='pending', next_try_at=0 WHERE ledger_seq=? AND state IN ('rejected','dead')", params: [seq] },
    ...(await auditStmts(ctx, [{ action: 'moneypenny.requeue', target: `ledger:${seq}`, meta: { was: p.state, reason: p.last_error } }])),
  ]);
  return ctx.db.first('SELECT * FROM mp_postings WHERE ledger_seq=?', [seq]);
}

/** Owner: give a DEFINITELY rejected claim back to the ledger (state 'rejected' only: 'dead' means the outcome is unknown and stays manual). */
export async function releasePosting(ctx, seq) {
  const p = await ctx.db.first('SELECT * FROM mp_postings WHERE ledger_seq=?', [seq]);
  if (!p) throw new HttpError(404, 'not_found', 'posting not found');
  if (p.state !== 'rejected' || p.granted_credits != null) throw new HttpError(409, 'bad_state', 'only a definitely rejected posting can be released');
  // Releasable only when Moneypenny provably holds NO credit: one single attempt (no earlier unknown outcome), a "nothing granted" reason
  // (never sale_already_used / a 4xx on a retry), and the sale still standing (a refunded sale keeps its commission reversed).
  if (p.attempts > 1 || !NO_CREDIT_REASONS.has(p.last_error)) throw new HttpError(409, 'manual_review', 'this refusal cannot prove that no credit exists at Moneypenny; check there first');
  if (!(await ctx.db.first("SELECT 1 AS x FROM ledger l JOIN sales s ON s.id=l.sale_id WHERE l.seq=? AND s.status='recorded'", [seq]))) throw new HttpError(409, 'sale_not_recorded', 'the sale was refunded or changed; the entry stays reversed');
  await atomic(ctx, async () => {
    // re-checked inside the builder: a refund that lands meanwhile makes the builder re-run and then refuse
    if (!(await ctx.db.first("SELECT 1 AS x FROM mp_postings m JOIN ledger l ON l.seq=m.ledger_seq JOIN sales s ON s.id=l.sale_id WHERE m.ledger_seq=? AND m.state='rejected' AND m.granted_credits IS NULL AND m.attempts<=1 AND s.status='recorded'", [seq]))) return [];
    return [
      { sql: "DELETE FROM mp_postings WHERE ledger_seq=? AND state='rejected' AND granted_credits IS NULL", params: [seq] },
      ...(await ledgerStmts(ctx, [{ account_id: p.user_id, kind: 'payout_release', amount_minor: p.amount_minor, eligible_at: ctx.now(), ref: `mprelease:${seq}`, memo: 'Moneypenny refused; returned to balance' }])),
      ...(await auditStmts(ctx, [{ action: 'moneypenny.release', target: `ledger:${seq}`, meta: { amount_minor: p.amount_minor, reason: p.last_error } }])),
    ];
  });
  if (await ctx.db.first('SELECT 1 AS x FROM mp_postings WHERE ledger_seq=?', [seq])) throw new HttpError(409, 'not_released', 'the posting changed meanwhile (for example the sale was refunded); nothing was released');
  return { released: true, ledger_seq: seq };
}

export async function suiteStatus(ctx) {
  const prof = await getProfile(ctx);
  return {
    tenant: { slug: prof.slug, product_name: prof.product_name },
    commission_destination: prof.commission_dest,
    payout_mode: ctx.payouts.mode || 'mock',
    engines: { moneypenny: { configured: !!ctx.engines.mnp, enabled: !!prof.mnp_enabled }, monopoly: { configured: !!ctx.engines.mono, enabled: !!prof.mono_enabled } },
    links: await ctx.db.all('SELECT engine, state, COUNT(*) AS n FROM engine_links GROUP BY engine, state'),
    postings: await ctx.db.all('SELECT state, COUNT(*) AS n, COALESCE(SUM(amount_minor),0) AS amount_minor FROM mp_postings GROUP BY state'),
    exceptions: await ctx.db.all("SELECT ledger_seq, user_id, amount_minor, state, last_error, attempts FROM mp_postings WHERE state IN ('rejected','dead') ORDER BY ledger_seq LIMIT 50"),
    // sent to Moneypenny, then the sale was refunded: never delivered again, needs the owner to reconcile with Moneypenny (no clawback)
    refunded_sent: await ctx.db.all("SELECT m.ledger_seq, m.user_id, m.amount_minor, m.state, m.attempts FROM mp_postings m JOIN ledger l ON l.seq=m.ledger_seq JOIN sales s ON s.id=l.sale_id WHERE m.sent_at IS NOT NULL AND m.state IN ('pending','rejected','dead') AND s.status<>'recorded' ORDER BY m.ledger_seq LIMIT 50"),
  };
}
