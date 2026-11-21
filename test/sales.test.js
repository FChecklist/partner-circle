import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mk, DAY } from './helpers.js';
import { handle } from '../src/app.js';

async function world(h) {
  const m = await h.staff('manager', 'Anita');
  const l = await h.staff('leader', 'Ravi', m);
  const e = await h.staff('exec', 'Sonal', l);
  const p = await h.staff('partner', 'Imran', e);
  return { m, l, e, p };
}
const click = async (h, user, siteId = 'mom') => {
  const l = await h.call('POST', '/v1/me/links', { key: user.key, body: { site_id: siteId, path: '/' } });
  const res = await handle(h.ctx, new Request(`https://pc.test${l.data.url}`, { headers: { 'cf-connecting-ip': '198.51.100.9' } }));
  return new URL(res.headers.get('location')).searchParams.get('pc');
};
const ledger = (h, userId) => h.db.all('SELECT kind, amount_minor, eligible_at FROM ledger WHERE account_id=? ORDER BY seq', [userId]);
const bal = async (h, u) => (await h.call('GET', '/v1/me/balance', { key: u.key })).data;

test('click attribution: commission 15% of net, upline overrides by role, hold = return window + buffer (37 days)', async () => {
  const h = await mk();
  const w = await world(h);
  const ck = await click(h, w.p);
  const paidAt = h.clock.t;
  const r = await h.sale('mom', { order_id: 'ord1', amount_minor: 118000, tax_minor: 18000, click_id: ck, customer_email: 'buyer@example.test' });
  assert.equal(r.status, 201);
  assert.equal(r.data.attribution, 'click');
  assert.equal(r.data.eligible_at, paidAt + 37 * DAY);
  assert.equal(r.data.commission_minor, 15000); // 15% of net 100000
  assert.deepEqual((await ledger(h, w.p.id)).map((x) => [x.kind, x.amount_minor]), [['commission', 15000]]);
  assert.deepEqual((await ledger(h, w.e.id)).map((x) => [x.kind, x.amount_minor]), [['override', 1000]]); // 100 bps
  assert.deepEqual((await ledger(h, w.l.id)).map((x) => [x.kind, x.amount_minor]), [['override', 750]]); // 75 bps
  assert.deepEqual((await ledger(h, w.m.id)).map((x) => [x.kind, x.amount_minor]), [['override', 500]]); // 50 bps
  // the buyer's e-mail is stored only as a keyed hash
  const sale = await h.db.first('SELECT * FROM sales');
  assert.ok(!JSON.stringify(sale).includes('buyer@example.test'));
  assert.match(sale.customer_hash, /^[0-9a-f]{64}$/);
});

test('hold days differ per product: games/Townhall 7 days, Veridian + PROJEXA 37 days', async () => {
  const h = await mk();
  const p = await h.staff('partner', 'Holder');
  const out = {};
  for (const s of ['tam', 'th', 'mom', 'dpdp', 'projexa', 'aios']) {
    const ck = await click(h, p, s);
    const r = await h.sale(s, { order_id: `o-${s}`, click_id: ck });
    out[s] = (r.data.eligible_at - h.clock.t) / DAY;
  }
  assert.deepEqual(out, { tam: 7, th: 7, mom: 37, dpdp: 37, projexa: 37, aios: 37 });
});

test('precedence: code beats click beats earlier sign-up; no signal means no partner and no ledger', async () => {
  const h = await mk();
  const a = await h.staff('partner', 'Alpha');
  const b = await h.staff('partner', 'Bravo');
  const c = await h.staff('partner', 'Charlie');
  await h.call('POST', '/v1/me/codes', { key: a.key, body: { site_id: 'mom', discount_bps: 1000, code: 'ALPHA10', max_uses: 5 } });
  const ckB = await click(h, b);
  // charlie brought a sign-up earlier
  await h.call('POST', '/v1/admin/keys', { key: h.owner, body: { kind: 'site', site_id: 'mom' } }).then(async (k) => {
    const ckC = await click(h, c);
    const lead = await h.call('POST', '/v1/integration/leads', { key: k.data.token, body: { customer_email: 'lee@example.test', click_id: ckC } });
    assert.equal(lead.data.source, 'click');
  });
  const s1 = await h.sale('mom', { order_id: 's1', code: 'alpha10', click_id: ckB, customer_email: 'lee@example.test' });
  assert.equal(s1.data.attribution, 'code');
  assert.equal(s1.data.partner_handle, a.handle);
  const s2 = await h.sale('mom', { order_id: 's2', click_id: ckB, customer_email: 'lee@example.test' });
  assert.equal(s2.data.attribution, 'click');
  assert.equal(s2.data.partner_handle, b.handle);
  const s3 = await h.sale('mom', { order_id: 's3', customer_email: 'lee@example.test' });
  assert.equal(s3.data.attribution, 'lead');
  assert.equal(s3.data.partner_handle, c.handle);
  const s4 = await h.sale('mom', { order_id: 's4', customer_email: 'stranger@example.test' });
  assert.equal(s4.data.attribution, 'none');
  assert.equal(s4.data.partner_handle, null);
  assert.equal(s4.data.commission_minor, 0);
  assert.equal((await h.db.first("SELECT COUNT(*) AS n FROM ledger WHERE sale_id=?", [s4.data.id])).n, 0);
  assert.equal((await h.db.first("SELECT used_count FROM codes WHERE code='ALPHA10'")).used_count, 1);
});

test('attribution window: a click older than the policy window earns nothing', async () => {
  const h = await mk();
  const p = await h.staff('partner', 'Late');
  const ck = await click(h, p);
  h.advance(31 * DAY);
  const r = await h.sale('mom', { order_id: 'late1', click_id: ck });
  assert.equal(r.data.attribution, 'none');
  await h.call('PUT', '/v1/admin/policy', { key: h.owner, body: { attribution_window_days: 60 } });
  const r2 = await h.sale('mom', { order_id: 'late2', click_id: ck });
  assert.equal(r2.data.attribution, 'click');
});

test('a click on another site, or a made-up click id, is ignored', async () => {
  const h = await mk();
  const p = await h.staff('partner', 'Cross');
  const ck = await click(h, p, 'dpdp');
  assert.equal((await h.sale('mom', { order_id: 'x1', click_id: ck })).data.attribution, 'none');
  assert.equal((await h.sale('mom', { order_id: 'x2', click_id: 'ck_deadbeefdeadbeef' })).data.attribution, 'none');
});

test('self-referral is blocked: no commission, logged, visible to the partner', async () => {
  const h = await mk();
  const p = await h.staff('partner', 'Selfie');
  const ck = await click(h, p);
  const r = await h.sale('mom', { order_id: 'self1', click_id: ck, customer_email: p.email.toUpperCase() });
  assert.equal(r.data.status, 'blocked');
  assert.equal(r.data.attribution, 'click');
  assert.equal((await ledger(h, p.id)).length, 0);
  const logs = await h.call('GET', '/v1/me/logs', { key: p.key });
  assert.ok(logs.data.logs.some((x) => x.type === 'sale' && x.result === 'blocked: self_referral'));
  // lead capture also refuses self-referral
  const k = (await h.call('POST', '/v1/admin/keys', { key: h.owner, body: { kind: 'site', site_id: 'mom' } })).data.token;
  const lead = await h.call('POST', '/v1/integration/leads', { key: k, body: { customer_email: p.email, click_id: ck } });
  assert.equal(lead.data.blocked, 'self_referral');
});

test('suspended partner: new sales are blocked, not paid', async () => {
  const h = await mk();
  const p = await h.staff('partner', 'Sus');
  const ck = await click(h, p);
  assert.equal((await h.call('POST', `/v1/admin/users/${p.id}/suspend`, { key: h.ai, body: { why: 'fraud flag' } })).data.status, 'suspended');
  const r = await h.sale('mom', { order_id: 'sus1', click_id: ck });
  assert.equal(r.data.status, 'blocked');
  assert.equal(r.data.block_reason, 'partner_not_active');
  assert.equal((await h.call('POST', `/v1/admin/users/${p.id}/reinstate`, { key: h.ai })).status, 403);
  assert.equal((await h.call('POST', `/v1/admin/users/${p.id}/reinstate`, { key: h.owner })).data.status, 'active');
});

test('Refer and Earn members earn the (lower) refer rate and have no upline overrides', async () => {
  const h = await mk();
  const r = (await h.call('POST', '/v1/register', { body: { consent: true, role: 'refer', name: 'Rita' } })).data;
  const ck = await click(h, { key: r.api_key });
  const s = await h.sale('mom', { order_id: 'rf1', click_id: ck, amount_minor: 100000 });
  assert.equal(s.data.commission_minor, 5000); // refer_bps 500
  assert.equal(s.data.overrides.length, 0);
});

test('sale validation and idempotency: same order returns the same sale, different amount conflicts, bad input is 422', async () => {
  const h = await mk();
  const a = await h.signed('mom', 'POST', '/v1/integration/sales', { order_id: 'dup', amount_minor: 5000 });
  const b = await h.signed('mom', 'POST', '/v1/integration/sales', { order_id: 'dup', amount_minor: 5000 });
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(b.data.duplicate, true);
  assert.equal(a.data.id, b.data.id);
  assert.equal((await h.signed('mom', 'POST', '/v1/integration/sales', { order_id: 'dup', amount_minor: 6000 })).status, 409);
  assert.equal((await h.db.first('SELECT COUNT(*) AS n FROM sales')).n, 1);
  for (const bad of [{ amount_minor: 100 }, { order_id: 'x', amount_minor: 0 }, { order_id: 'x', amount_minor: 1.5 }, { order_id: 'x', amount_minor: 100, tax_minor: 100 },
    { order_id: 'x', amount_minor: 100, currency: 'USD' }, { order_id: 'x', amount_minor: 100, paid_at: h.clock.t + 3600000 }, { order_id: 'x', amount_minor: '100' }]) {
    assert.equal((await h.signed('mom', 'POST', '/v1/integration/sales', bad)).status, 422, JSON.stringify(bad));
  }
  // a site cannot post a sale for another site by changing the header only: the signature is bound to the site secret
  const forged = await h.signed('dpdp', 'POST', '/v1/integration/sales', { order_id: 'f1', amount_minor: 100 }, { secretOverride: 'x'.repeat(64) });
  assert.equal(forged.status, 401);
});

test('code use is counted; an exhausted code stops attributing; failed insert gives the use back', async () => {
  const h = await mk();
  const p = await h.staff('partner', 'Coder');
  await h.call('POST', '/v1/me/codes', { key: p.key, body: { site_id: 'mom', discount_bps: 500, code: 'ONCE', max_uses: 1 } });
  assert.equal((await h.sale('mom', { order_id: 'c1', code: 'ONCE' })).data.attribution, 'code');
  assert.equal((await h.sale('mom', { order_id: 'c2', code: 'ONCE' })).data.attribution, 'none');
  assert.equal((await h.db.first("SELECT used_count FROM codes WHERE code='ONCE'")).used_count, 1);
  // re-delivery of the first order must not consume another use
  assert.equal((await h.signed('mom', 'POST', '/v1/integration/sales', { order_id: 'c1', amount_minor: 100000, code: 'ONCE' })).data.duplicate, true);
  assert.equal((await h.db.first("SELECT used_count FROM codes WHERE code='ONCE'")).used_count, 1);
});

test('Razorpay confirmation gates payability: pending, mismatch and confirmed; capture before or after the sale both work', async () => {
  const h = await mk();
  const p = await h.staff('partner', 'Rzp');
  await h.verifyUser(p);
  const ck = await click(h, p);
  await h.call('PUT', '/v1/admin/policy', { key: h.owner, body: { min_payout_minor: 100 } });
  // sale with no capture yet
  await h.sale('mom', { order_id: 'r1', click_id: ck, amount_minor: 200000 }, { rzp: false });
  // capture arrives BEFORE the sale for r2
  await h.rzp({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_early', amount: 200000 } } } }, { eventId: 'evt_early' });
  const r2 = await h.sale('mom', { order_id: 'r2', click_id: ck, amount_minor: 200000, razorpay_payment_id: 'pay_early' }, { rzp: false });
  assert.equal(r2.data.rzp_status, 'confirmed');
  // mismatching amount
  await h.sale('mom', { order_id: 'r3', click_id: ck, amount_minor: 200000, razorpay_payment_id: 'pay_wrong' }, { rzp: false });
  await h.rzp({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_wrong', amount: 150000 } } } }, { eventId: 'evt_wrong' });
  h.advance(40 * DAY);
  const b = await bal(h, p);
  assert.equal(b.available_minor, 30000, 'only r2 is payable');
  assert.equal(b.awaiting_razorpay_minor, 60000, 'r1 (no capture) + r3 (amount mismatch) are held');
  const states = await h.db.all('SELECT order_id, rzp_status FROM sales ORDER BY order_id');
  assert.deepEqual(states.map((s) => s.rzp_status), ['pending', 'confirmed', 'mismatch']);
  // capture for r1 arrives late: webhook confirms it straight away
  await h.rzp({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_r1', amount: 200000 } } } }, { eventId: 'evt_r1' });
  assert.equal((await bal(h, p)).available_minor, 60000);
  assert.equal((await bal(h, p)).awaiting_razorpay_minor, 30000, 'r3 stays held for its amount mismatch');
  // a crossed-in-flight pair (event row stored, confirm step lost) is repaired by reconcile at payout time
  await h.sale('mom', { order_id: 'r4', click_id: await click(h, p), amount_minor: 200000 }, { rzp: false });
  await h.db.run("INSERT INTO razorpay_events (event_id,type,payment_id,amount_minor,ts) VALUES ('evt_r4','payment.captured','pay_r4',200000,?)", [h.clock.t]);
  assert.equal((await h.db.first("SELECT rzp_status FROM sales WHERE order_id='r4'")).rzp_status, 'pending');
  const rq = await h.call('POST', '/v1/me/payouts', { key: p.key });
  assert.equal(rq.status, 201);
  assert.equal((await h.db.first("SELECT rzp_status FROM sales WHERE order_id='r4'")).rzp_status, 'confirmed');
});

test('Razorpay webhook: bad signature rejected, duplicate event ignored, failures are retryable, unknown events harmless', async () => {
  const h = await mk();
  const evt = { event: 'payment.captured', payload: { payment: { entity: { id: 'pay_1', amount: 1000 } } } };
  assert.equal((await h.rzp(evt, { secret: 'wrong-secret-wrong-secret-wrong' })).status, 401);
  assert.equal((await h.call('POST', '/v1/webhooks/razorpay', { body: evt })).status, 401);
  assert.equal((await h.rzp(evt, { eventId: 'e1' })).status, 200);
  assert.equal((await h.rzp(evt, { eventId: 'e1' })).data.duplicate, true);
  assert.equal((await h.db.first('SELECT COUNT(*) AS n FROM razorpay_events')).n, 1);
  assert.equal((await h.rzp({ event: 'order.paid', payload: {} }, { eventId: 'e2' })).status, 200);
  assert.equal((await h.rzp({ nothing: true }, { eventId: 'e3' })).status, 422);
  // a payout event for a payout in the wrong state throws -> event is forgotten so the provider's retry is processed
  const bad = await h.rzp({ event: 'payout.processed', payload: { payout: { entity: { id: 'pout_x', reference_id: 'po_none' } } } }, { eventId: 'e4' });
  assert.equal(bad.status, 200);
  assert.equal(bad.data.payout, undefined);
});

test('refund before maturity voids the commission and every override; refund is idempotent', async () => {
  const h = await mk();
  const w = await world(h);
  const ck = await click(h, w.p);
  const s = await h.sale('mom', { order_id: 'rf1', click_id: ck, amount_minor: 100000 });
  const r = await h.signed('mom', 'POST', '/v1/integration/refunds', { order_id: 'rf1', reason: 'unused', usage_verified: false });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'refunded');
  assert.equal(r.data.refund_after_payout, false);
  for (const u of [w.p, w.e, w.l, w.m]) {
    const rows = await ledger(h, u.id);
    assert.equal(rows.reduce((a, x) => a + x.amount_minor, 0), 0, `${u.handle} nets to zero`);
    assert.equal(rows.length, 2);
  }
  assert.equal((await h.signed('mom', 'POST', '/v1/integration/refunds', { order_id: 'rf1' })).data.already_refunded, true);
  assert.equal((await h.db.first('SELECT COUNT(*) AS n FROM ledger')).n, 8);
  assert.equal((await h.signed('mom', 'POST', '/v1/integration/refunds', { order_id: 'missing' })).status, 404);
  assert.equal(s.status, 201);
});

test('Razorpay refund.processed auto-refunds a full refund and flags a partial one for review', async () => {
  const h = await mk();
  const p = await h.staff('partner', 'Rfd');
  const ck = await click(h, p);
  await h.sale('mom', { order_id: 'a1', click_id: ck, amount_minor: 100000, razorpay_payment_id: 'pay_a1' });
  await h.sale('mom', { order_id: 'a2', click_id: ck, amount_minor: 100000, razorpay_payment_id: 'pay_a2' });
  const full = await h.rzp({ event: 'refund.processed', payload: { refund: { entity: { id: 'rfnd_1', payment_id: 'pay_a1', amount: 100000 } } } }, { eventId: 'rf-a' });
  assert.equal(full.data.refunded, true);
  const part = await h.rzp({ event: 'refund.processed', payload: { refund: { entity: { id: 'rfnd_2', payment_id: 'pay_a2', amount: 40000 } } } }, { eventId: 'rf-b' });
  assert.equal(part.data.needs_review, true);
  assert.deepEqual((await h.db.all('SELECT order_id,status FROM sales ORDER BY order_id')).map((x) => x.status), ['refunded', 'recorded']);
});

test('timeline: nothing payable at 36 days, payable at 37 (Veridian); 7 days for a game', async () => {
  const h = await mk();
  const p = await h.staff('partner', 'Timer');
  const a = await click(h, p, 'mom');
  const b = await click(h, p, 'tam');
  await h.sale('mom', { order_id: 't1', click_id: a, amount_minor: 100000 });
  await h.sale('tam', { order_id: 't2', click_id: b, amount_minor: 100000 });
  assert.equal((await bal(h, p)).available_minor, 0);
  h.advance(7 * DAY);
  assert.equal((await bal(h, p)).available_minor, 12000);
  h.advance(29 * DAY);
  assert.equal((await bal(h, p)).available_minor, 12000);
  h.advance(1 * DAY + 1);
  assert.equal((await bal(h, p)).available_minor, 27000);
});

test('double-entry self-check: ledger total always equals available + pending, through sale, refund, payout and failure', async () => {
  const h = await mk();
  const p = await h.staff('partner', 'Dbl');
  await h.verifyUser(p);
  await h.call('PUT', '/v1/admin/policy', { key: h.owner, body: { min_payout_minor: 100 } });
  const check = async (label) => {
    const b = await bal(h, p);
    assert.equal(b.ledger_total_minor, b.available_minor + b.pending_minor, label);
    return b;
  };
  const ck = await click(h, p);
  for (const i of [1, 2, 3]) await h.sale('mom', { order_id: `d${i}`, click_id: ck, amount_minor: 100000 * i });
  await check('after sales');
  await h.signed('mom', 'POST', '/v1/integration/refunds', { order_id: 'd3' });
  await check('after refund');
  h.advance(38 * DAY);
  const b0 = await check('matured');
  assert.equal(b0.available_minor, 45000); // d1 15000 + d2 30000
  const po = await h.call('POST', '/v1/me/payouts', { key: p.key });
  assert.equal(po.status, 201);
  const b1 = await check('payout requested');
  assert.equal(b1.available_minor, 0);
  assert.equal(b1.in_payout_minor, 45000);
  const ap = await h.call('POST', `/v1/admin/payouts/${po.data.id}/approve`, { key: h.owner });
  assert.equal(ap.data.status, 'processing');
  await h.rzp({ event: 'payout.failed', payload: { payout: { entity: { id: ap.data.provider_ref, reference_id: po.data.id, failure_reason: 'bank down' } } } }, { eventId: 'pf1' });
  const b2 = await check('payout failed');
  assert.equal(b2.available_minor, 45000);
  assert.equal(b2.in_payout_minor, 0);
  assert.equal((await h.call('GET', '/v1/admin/verify', { key: h.owner })).data.ledger.ok, true);
});
