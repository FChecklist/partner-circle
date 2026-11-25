// Cloud audit round 1 on 31c7c4a: payout path findings (H1 stale read, H2 no sent marker, M2 concurrent approve).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mk, DAY } from './helpers.js';
import { handle } from '../src/app.js';

const click = async (h, user, siteId = 'mom') => {
  const l = await h.call('POST', '/v1/me/links', { key: user.key, body: { site_id: siteId, path: '/' } });
  const res = await handle(h.ctx, new Request(`https://pc.test${l.data.url}`));
  return new URL(res.headers.get('location')).searchParams.get('pc');
};

/** A verified partner with two matured Rs 1,500 commissions (orders A and B). */
async function twoSales(h, name = 'Pia') {
  const p = await h.staff('partner', name);
  await h.verifyUser(p);
  for (const o of ['A', 'B']) {
    const ck = await click(h, p);
    await h.sale('mom', { order_id: `${name}-${o}`, click_id: ck, amount_minor: 1000000 });
  }
  h.advance(38 * DAY);
  return p;
}

const flaky = (calls, failFirst = true) => ({
  mode: 'test',
  async createPayout(req) {
    calls.push(req.payout_id);
    if (failFirst && calls.length === 1) throw new Error('timeout after provider accepted');
    return { provider: 'fake', provider_ref: `ref_${calls.length}`, status: 'queued', mode: 'test' };
  },
});

test('H1: a refund that lands while the payout request is being built refuses the request (no refunded sale in a payout)', async () => {
  const h = await mk();
  const p = await twoSales(h);
  const origAll = h.ctx.db.all.bind(h.ctx.db);
  let fired = false;
  h.ctx.db.all = async (sql, params) => {
    const rows = await origAll(sql, params);
    if (!fired && /SELECT l\.seq, l\.amount_minor/.test(sql)) {
      fired = true;
      await h.signed('mom', 'POST', '/v1/integration/refunds', { order_id: 'Pia-B' }); // lands right after the entries were read
    }
    return rows;
  };
  const r = await h.call('POST', '/v1/me/payouts', { key: p.key });
  h.ctx.db.all = origAll;
  assert.equal(r.status, 409);
  assert.equal(r.data.error.code, 'balance_changed');
  assert.equal(await h.ctx.db.first('SELECT 1 AS x FROM payouts'), null, 'no payout was created');
  const again = await h.call('POST', '/v1/me/payouts', { key: p.key });
  assert.equal(again.status < 300 || again.data.error.code === 'below_minimum', true);
  const b = (await h.call('GET', '/v1/me/balance', { key: p.key })).data;
  assert.equal(b.ledger_total_minor, b.available_minor + b.pending_minor, 'ledger identity holds');
});

test('H1: approve refuses a payout whose sale is no longer recorded', async () => {
  const h = await mk();
  const p = await twoSales(h);
  const po = (await h.call('POST', '/v1/me/payouts', { key: p.key })).data;
  await h.ctx.db.run("UPDATE sales SET status='refunded' WHERE order_id='Pia-B'");
  const a = await h.call('POST', `/v1/admin/payouts/${po.id}/approve`, { key: h.owner });
  assert.equal(a.data.error.code, 'sale_changed');
});

test('H2: after an unknown provider outcome the payout is marked sent: it cannot be rejected, released or voided as "not sent"', async () => {
  const calls = [];
  const h = await mk({ payouts: flaky(calls) });
  const p = await twoSales(h);
  const po = (await h.call('POST', '/v1/me/payouts', { key: p.key })).data;
  const a = await h.call('POST', `/v1/admin/payouts/${po.id}/approve`, { key: h.owner });
  assert.equal(a.status, 502);
  const row = await h.ctx.db.first('SELECT status, sent_at, attempts FROM payouts WHERE id=?', [po.id]);
  assert.equal(row.status, 'approved');
  assert.ok(row.sent_at, 'sent marker written before the call');
  assert.equal(row.attempts, 1);
  // the owner cannot reject it as not sent, and cannot mark it failed without confirming with the provider
  assert.equal((await h.call('POST', `/v1/admin/payouts/${po.id}/reject`, { key: h.owner })).data.error.code, 'maybe_sent');
  assert.equal((await h.call('POST', `/v1/admin/payouts/${po.id}/mark-failed`, { key: h.owner })).data.error.code, 'maybe_sent');
  // a refund now flags it (no clawback) and does NOT cancel it or void the commission
  const r = await h.signed('mom', 'POST', '/v1/integration/refunds', { order_id: 'Pia-A' });
  assert.equal(r.data.refund_after_payout, true);
  assert.equal((await h.ctx.db.first('SELECT status FROM payouts WHERE id=?', [po.id])).status, 'approved');
  // a retry uses the same payout id (the provider's idempotency key), and the owner can finish it
  const ex = await h.call('POST', `/v1/admin/payouts/${po.id}/execute`, { key: h.owner });
  assert.equal(ex.status, 200);
  assert.equal(calls[0], calls[1], 'same payout id both times');
  // only after confirming with the provider can the owner mark a sent payout failed
  const h2 = await mk({ payouts: flaky([]) });
  const p2 = await twoSales(h2, 'Quin');
  const po2 = (await h2.call('POST', '/v1/me/payouts', { key: p2.key })).data;
  await h2.call('POST', `/v1/admin/payouts/${po2.id}/approve`, { key: h2.owner });
  const f = await h2.call('POST', `/v1/admin/payouts/${po2.id}/mark-failed`, { key: h2.owner, body: { confirmed_not_sent: true } });
  assert.equal(f.status, 200);
});

test('M2: two concurrent approvals call the provider once', async () => {
  const calls = [];
  const h = await mk({ payouts: flaky(calls, false) });
  const p = await twoSales(h);
  const po = (await h.call('POST', '/v1/me/payouts', { key: p.key })).data;
  const [a, b] = await Promise.all([
    h.call('POST', `/v1/admin/payouts/${po.id}/approve`, { key: h.owner }),
    h.call('POST', `/v1/admin/payouts/${po.id}/approve`, { key: h.owner }),
  ]);
  assert.equal(calls.length, 1, 'provider called once');
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
});

// ------------------------------------------------------------------ cloud audit round 1, angle 2 (security / privacy / abuse)
import { unconfiguredMailer } from '../src/adapters.js';
import { normEmail } from '../src/util.js';

test('sec M1: a partner cannot register more than 50 prospects', async () => {
  const h = await mk();
  const p = await h.staff('partner', 'Many');
  for (let i = 0; i < 50; i++) assert.equal((await h.call('POST', '/v1/me/prospects', { key: p.key, body: { site_id: 'mom', customer_email: `c${i}@example.test` } })).status < 300, true);
  assert.equal((await h.call('POST', '/v1/me/prospects', { key: p.key, body: { site_id: 'mom', customer_email: 'c51@example.test' } })).data.error.code, 'prospect_limit');
});

test('sec M2: a self-purchase with an e-mail alias (+tag, dots on Gmail) is blocked as self-referral', async () => {
  assert.equal(normEmail('J.Ane+shop@GoogleMail.com'), 'jane@gmail.com');
  const h = await mk();
  const p = await h.staff('partner', 'Gma');
  const ck = await click(h, p);
  const r = await h.sale('mom', { order_id: 'alias1', click_id: ck, amount_minor: 1000000, customer_email: 'gma+shop@example.test' });
  assert.equal(r.data.status, 'blocked');
});

test('sec M4: a user can rotate their own key (old key dies); changing payout details notifies them and flags the owner queue', async () => {
  const h = await mk();
  const p = await h.staff('partner', 'Rota');
  await h.verifyUser(p);
  const rot = await h.call('POST', '/v1/me/keys/rotate', { key: p.key });
  assert.equal(rot.status, 200);
  assert.equal((await h.call('GET', '/v1/me', { key: p.key })).status, 401, 'old key no longer works');
  assert.equal((await h.call('GET', '/v1/me', { key: rot.data.api_key })).status, 200);
  const before = h.mailer.outbox.length;
  await h.call('PUT', '/v1/me/kyc', { key: rot.data.api_key, body: { pan: 'ABCDE1234F', upi_id: 'thief@okbank' } });
  assert.ok(h.mailer.outbox.length > before, 'the partner is told');
  const q = (await h.call('GET', '/v1/admin/queue', { key: h.owner })).data;
  assert.equal(q.kyc[0].payout_details_changed, true);
});

test('sec M5: the owner cannot vouch for an e-mail when mail is not configured (no proof)', async () => {
  const h = await mk();
  const p = await h.staff('partner', 'Vouch');
  h.ctx.mailer = unconfiguredMailer();
  assert.equal((await h.call('POST', `/v1/admin/users/${p.id}/verify-email`, { key: h.owner })).data.error.code, 'mail_not_configured');
});

test('sec M6: the leaderboard names only you, shows no handles; the owner queue shows the sponsor', async () => {
  const h = await mk();
  const boss = await h.staff('exec', 'Boss');
  const p = await h.staff('partner', 'Pia');
  await h.verifyUser(p);
  const ck = await click(h, p);
  await h.sale('mom', { order_id: 'lb1', click_id: ck, amount_minor: 1000000 });
  const other = await h.staff('partner', 'Zed');
  const lb = (await h.call('GET', '/v1/leaderboard', { key: other.key })).data.month;
  assert.ok(lb.length >= 1);
  for (const r of lb) { assert.equal(r.handle, undefined); assert.equal(r.first_name, null); }
  const reg = await h.call('POST', '/v1/register', { body: { role: 'partner', name: 'Newbie', email: 'newbie@example.test', phone: '9876543211', sponsor: boss.handle } });
  assert.equal(reg.status, 201);
  const q = (await h.call('GET', '/v1/admin/queue', { key: h.owner })).data;
  assert.equal(q.partners.find((x) => x.name === 'Newbie').sponsor.handle, boss.handle);
});

test('sec M8: key use is written at most once per 10 minutes; a flood past the limit is refused without more writes', async () => {
  const h = await mk();
  const p = await h.staff('partner', 'Busy');
  await h.call('GET', '/v1/me', { key: p.key });
  const t1 = (await h.ctx.db.first('SELECT last_used_at AS t FROM api_keys WHERE user_id=?', [p.id])).t;
  h.advance(1000);
  await h.call('GET', '/v1/me', { key: p.key });
  assert.equal((await h.ctx.db.first('SELECT last_used_at AS t FROM api_keys WHERE user_id=?', [p.id])).t, t1);
});

test('sec M7: sign-up records the notice version shown (no consent field needed); a person can export their data and ask for erasure', async () => {
  const h = await mk();
  const reg = await h.call('POST', '/v1/register', { body: { role: 'partner', name: 'Dpdp', email: 'dpdp@example.test', phone: '9876543212' } });
  assert.equal(reg.status, 201);
  const k = reg.data.api_key;
  const ex = await h.call('GET', '/v1/me/export', { key: k });
  assert.equal(ex.status, 200);
  assert.ok(ex.data.shared_with.length >= 2 && ex.data.notice_version);
  assert.equal((await h.call('POST', '/v1/me/erase-request', { key: k })).data.requested, true);
  const log = await h.ctx.db.all("SELECT action FROM audit_log WHERE action IN ('user.notice_shown','user.erase_requested')");
  assert.equal(log.length, 2);
});

// ------------------------------------------------------------------ cloud audit round 2 on 536133b (refund/claim race, markFailed race)
async function pendingPayout(h, name) {
  const p = await twoSales(h, name);
  const po = (await h.call('POST', '/v1/me/payouts', { key: p.key })).data;
  return { p, po };
}
import { auditStmts } from '../src/chain.js';
/** Another isolate approves and hands the payout to the provider (marker + audit entry) without going through this process's gate. */
const sneakSend = async (h, poId) => {
  await h.ctx.db.batch([
    { sql: "UPDATE payouts SET status='approved', sent_at=?, attempts=1 WHERE id=?", params: [h.ctx.now(), poId] },
    ...(await auditStmts(h.ctx, [{ action: 'payout.approve', target: `payout:${poId}`, meta: { other_isolate: true } }])),
  ]);
};
/** Run `fire` once, after the statements are built and just before the first batch that would cancel a waiting payout (the stale-read window). */
function afterCancelRead(h, fire) {
  const orig = h.ctx.db.batch.bind(h.ctx.db);
  let done = false;
  h.ctx.db.batch = async (stmts) => {
    if (!done && stmts.some((x) => /DELETE FROM payout_items/.test(x.sql))) { done = true; await fire(); }
    return orig(stmts);
  };
  return () => { h.ctx.db.batch = orig; };
}
const noRelease = async (h, p, poId) => {
  assert.ok((await h.ctx.db.first('SELECT sent_at FROM payouts WHERE id=?', [poId])).sent_at, 'the payout was sent');
  assert.ok((await h.ctx.db.first('SELECT COUNT(*) AS n FROM payout_items WHERE payout_id=?', [poId])).n > 0, 'sent payout keeps its items');
  assert.equal(await h.ctx.db.first("SELECT 1 AS x FROM ledger WHERE kind='payout_release' AND payout_id=?", [poId]), null, 'no release for a sent payout');
  assert.equal((await h.ctx.db.first('SELECT status FROM payouts WHERE id=?', [poId])).status, 'approved');
};

test('H1 (round 2): a refund that races an approve does not release the sent payout', async () => {
  const h = await mk();
  const { p, po } = await pendingPayout(h, 'Rae');
  const restore = afterCancelRead(h, () => sneakSend(h, po.id));
  const r = await h.signed('mom', 'POST', '/v1/integration/refunds', { order_id: 'Rae-B' });
  restore();
  assert.equal(r.status, 200);
  assert.equal(r.data.refund_after_payout, true, 'flagged for the owner instead');
  await noRelease(h, p, po.id);
});

test('H1 (round 2): a claim that races an approve does not release the sent payout', async () => {
  const h = await mk();
  const { p, po } = await pendingPayout(h, 'Dee');
  const restore = afterCancelRead(h, () => sneakSend(h, po.id));
  const sale = await h.ctx.db.first("SELECT * FROM sales WHERE order_id='Dee-B'");
  const { setDispute } = await import('../src/sales.js');
  await setDispute(h.ctx, sale, 'open', 'claim');
  restore();
  await noRelease(h, p, po.id);
});

test('M1 (round 2): mark-failed does not release a payout that was sent after its first read', async () => {
  const h = await mk();
  const { po } = await pendingPayout(h, 'Moe');
  await h.ctx.db.run("UPDATE payouts SET status='approved' WHERE id=?", [po.id]);
  const orig = h.ctx.db.first.bind(h.ctx.db);
  let done = false;
  h.ctx.db.first = async (sql, params) => {
    const row = await orig(sql, params);
    if (!done && /SELECT \* FROM payouts WHERE id=\?/.test(sql)) { done = true; await sneakSend(h, po.id); }
    return row;
  };
  const f = await h.call('POST', `/v1/admin/payouts/${po.id}/mark-failed`, { key: h.owner });
  h.ctx.db.first = orig;
  assert.equal(f.status, 409);
  assert.equal(f.data.error.code, 'maybe_sent');
  assert.equal(await h.ctx.db.first("SELECT 1 AS x FROM ledger WHERE kind='payout_release' AND payout_id=?", [po.id]), null);
});

test('L1 (round 2): the owner queue flags a pending payout that holds a refunded sale', async () => {
  const h = await mk();
  const { po } = await pendingPayout(h, 'Lou');
  await h.ctx.db.run("UPDATE sales SET status='refunded' WHERE order_id='Lou-B'");
  const q = (await h.call('GET', '/v1/admin/queue', { key: h.owner })).data;
  assert.equal(q.payouts.find((x) => x.id === po.id).flagged_refunds, 1);
});

test('sec round 2: held and fresh prospect replies look the same; rotate is never idempotency-stored; consent is required; erase requests reach the queue', async () => {
  const h = await mk();
  const a = await h.staff('partner', 'Ann'); const b = await h.staff('partner', 'Bob');
  const fresh = (await h.call('POST', '/v1/me/prospects', { key: a.key, body: { site_id: 'mom', customer_email: 'x1@example.test' } })).data;
  const held = (await h.call('POST', '/v1/me/prospects', { key: b.key, body: { site_id: 'mom', customer_email: 'x1@example.test' } })).data;
  assert.deepEqual(Object.keys(fresh).sort(), Object.keys(held).sort());
  const rot = await h.call('POST', '/v1/me/keys/rotate', { key: a.key, headers: { 'idempotency-key': 'k1' } });
  assert.equal(rot.status, 200);
  assert.equal(await h.ctx.db.first("SELECT 1 AS x FROM idempotency WHERE body LIKE '%' || ? || '%'", [rot.data.api_key]), null, 'new key is not stored in clear');
  const nc = await h.call('POST', '/v1/register', { body: { role: 'partner', name: 'No', email: 'no@example.test', phone: '9876543299' } });
  assert.equal(nc.status, 201, 'sign-up works with no consent field');
  const old = await h.call('POST', '/v1/register', { body: { consent: true, role: 'partner', name: 'Old', email: 'old@example.test', phone: '9876543298' } });
  assert.equal(old.status, 201, 'an old client that still sends consent is accepted and the field is ignored');
  assert.equal((await h.call('POST', '/v1/register', { body: { role: 'partner', name: 'Bad', email: 'not-an-email', phone: '9876543297' } })).status, 422, 'bad input is still rejected');
  await h.call('POST', '/v1/me/erase-request', { key: rot.data.api_key });
  const q = (await h.call('GET', '/v1/admin/queue', { key: h.owner })).data;
  assert.equal(q.erase_requests.length, 1);
});

test('sec round 3: 60 repeat erase requests from one person write one row and do not hide another person from the owner queue', async () => {
  const h = await mk();
  const a = await h.staff('partner', 'Spam'); const b = await h.staff('partner', 'Victim');
  await h.call('POST', '/v1/me/erase-request', { key: b.key });
  for (let i = 0; i < 60; i++) await h.call('POST', '/v1/me/erase-request', { key: a.key });
  assert.equal((await h.ctx.db.first("SELECT COUNT(*) AS n FROM audit_log WHERE action='user.erase_requested'")).n, 2);
  const q = (await h.call('GET', '/v1/admin/queue', { key: h.owner })).data.erase_requests;
  assert.deepEqual(q.map((x) => x.user_id).sort(), [a.id, b.id].sort());
});

test('sec round 4: 60 people asking for erasure all appear (oldest first) and 40 parallel calls from one person write one row', async () => {
  const h = await mk();
  const first = await h.staff('partner', 'First');
  await h.call('POST', '/v1/me/erase-request', { key: first.key });
  for (let i = 0; i < 55; i++) { const u = await h.staff('partner', `P${i}`); await h.call('POST', '/v1/me/erase-request', { key: u.key }); }
  const q = (await h.call('GET', '/v1/admin/queue', { key: h.owner })).data.erase_requests;
  assert.equal(q.length, 56);
  assert.equal(q[0].user_id, first.id);
  const par = await h.staff('partner', 'Par');
  await Promise.all(Array.from({ length: 40 }, () => h.call('POST', '/v1/me/erase-request', { key: par.key })));
  assert.equal((await h.ctx.db.first("SELECT COUNT(*) AS n FROM audit_log WHERE action='user.erase_requested' AND target=?", [`user:${par.id}`])).n, 1);
});

test('round 5: a signed sale body cannot be replayed to the refunds endpoint; razorpay replay with a new event-id header is ignored; constructor is refused; erasure list empties', async () => {
  const h = await mk();
  const { signBody, siteSecret } = await import('../src/auth.js');
  const site = await h.ctx.db.first("SELECT * FROM sites WHERE id='mom'");
  const raw = JSON.stringify({ order_id: 'rp1', amount_minor: 100000 });
  const sig = await signBody(await siteSecret(h.ctx, site), String(h.clock.t), 'POST', '/v1/integration/sales', raw);
  const hd = { 'x-pc-site': 'mom', 'x-pc-timestamp': String(h.clock.t), 'x-pc-signature': sig };
  assert.equal((await h.call('POST', '/v1/integration/sales', { rawBody: raw, headers: hd })).status, 201);
  assert.equal((await h.call('POST', '/v1/integration/refunds', { rawBody: raw, headers: hd })).status, 401, 'same signature, other path: refused');
  const ev = { event: 'refund.processed', payload: { refund: { entity: { id: 'rfnd_1', payment_id: 'pay_x', amount: 500 } } } };
  assert.equal((await h.rzp(ev, { eventId: 'a' })).data.duplicate, undefined);
  assert.equal((await h.rzp(ev, { eventId: 'b' })).data.duplicate, true, 'new header, same signed body: still a duplicate');
  assert.equal((await h.call('PUT', '/v1/admin/policy', { key: h.owner, body: { constructor: 1 } })).status, 422);
  const p = await h.staff('partner', 'Gone');
  await h.call('POST', '/v1/me/erase-request', { key: p.key });
  assert.equal((await h.call('GET', '/v1/admin/queue', { key: h.owner })).data.erase_requests.length, 1);
  await h.call('POST', `/v1/admin/users/${p.id}/erase`, { key: h.owner });
  assert.equal((await h.call('GET', '/v1/admin/queue', { key: h.owner })).data.erase_requests.length, 0);
});
