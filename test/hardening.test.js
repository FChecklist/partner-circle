// Regression tests for the findings of the 10-11 Nov independent review. Each test name says which hole it keeps closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mk, DAY, ENV } from './helpers.js';
import { handle } from '../src/app.js';
import { createKey, revokeKey } from '../src/auth.js';
import { razorpayXAdapter, adaptersFromEnv, unconfiguredMailer } from '../src/adapters.js';
import { makeCtx } from '../src/ctx.js';
import { encryptField } from '../src/util.js';
import { verifyLedger, verifyAudit, atomic, auditStmts } from '../src/chain.js';
import { DEFAULT_SITES } from '../src/policy.js';
import { openDb } from '../scripts/lib.mjs';
import { ownerKeySql } from '../scripts/mint-owner-key.mjs';

const click = async (h, user, siteId = 'mom') => {
  const l = await h.call('POST', '/v1/me/links', { key: user.key, body: { site_id: siteId, path: '/' } });
  const res = await handle(h.ctx, new Request(`https://pc.test${l.data.url}`));
  return new URL(res.headers.get('location')).searchParams.get('pc');
};
const bal = async (h, u) => (await h.call('GET', '/v1/me/balance', { key: u.key })).data;
const auditActions = async (h, like) => (await h.db.all('SELECT action, actor_type, key_id, target FROM audit_log WHERE action LIKE ? ORDER BY seq', [like]));

/** A verified partner with one matured, Razorpay-confirmed Rs 10,000 MOM sale (Rs 1,500 commission) and `extra` more orders if asked. */
async function funded(h, name = 'Pia', { sales = 1 } = {}) {
  const p = await h.staff('partner', name);
  await h.verifyUser(p, { pan: 'ABCDE1234F', upi_id: `${name.toLowerCase()}@okbank` });
  p.sales = [];
  for (let i = 1; i <= sales; i++) {
    const ck = await click(h, p);
    const order = `o-${name}-${i}`;
    await h.sale('mom', { order_id: order, click_id: ck, amount_minor: 1000000 });
    p.sales.push(order);
  }
  h.advance(38 * DAY);
  return p;
}
const saleId = async (h, order) => (await h.db.first('SELECT id FROM sales WHERE order_id=?', [order])).id;

// ---------------------------------------------------------------- BLOCKER: self-activation

test('BLOCKER: public register ignores status, parent_id and every other extra field; the partner starts pending and cannot earn', async () => {
  const h = await mk();
  const boss = await h.staff('manager', 'Bossy');
  const r = await h.call('POST', '/v1/register', { body: { role: 'partner', name: 'Sly', email: 'sly@example.test', phone: '9876500001', status: 'active', parent_id: boss.id, email_verified: 1, id: 'u_forced' } });
  assert.equal(r.status, 201);
  assert.equal(r.data.user.status, 'pending');
  assert.equal(r.data.user.parent_id, null);
  assert.notEqual(r.data.user.id, 'u_forced');
  const row = await h.db.first('SELECT * FROM users WHERE id=?', [r.data.user.id]);
  assert.equal(row.status, 'pending');
  assert.equal(row.email_verified, 0);
  assert.equal((await h.call('POST', '/v1/me/links', { key: r.data.api_key, body: { site_id: 'mom', path: '/' } })).status, 403, 'a pending partner cannot make links');
  assert.equal((await h.call('POST', '/v1/me/codes', { key: r.data.api_key, body: { site_id: 'mom', discount_bps: 500 } })).status, 403);
  // the refer role stays instantly active, but still cannot pick a status or a sponsor chain
  const f = await h.call('POST', '/v1/register', { body: { role: 'refer', name: 'Ref', status: 'suspended', parent_id: boss.id } });
  assert.equal(f.data.user.status, 'active');
  assert.equal(f.data.user.parent_id, null);
  // a body that is not an object is a clean 422
  assert.equal((await h.call('POST', '/v1/register', { rawBody: '[]' })).status, 422);
});

// ---------------------------------------------------------------- one payment, one sale

test('one Razorpay payment confirms exactly one sale: reuse is refused, commission posts once, the database enforces it too', async () => {
  const h = await mk();
  const p = await h.staff('partner', 'Dup');
  const ck = await click(h, p);
  const first = await h.sale('mom', { order_id: 'o1', click_id: ck, razorpay_payment_id: 'pay_same' });
  assert.equal(first.status, 201);
  for (const o of ['o2', 'o3']) {
    const again = await h.signed('mom', 'POST', '/v1/integration/sales', { order_id: o, amount_minor: 100000, click_id: ck, razorpay_payment_id: 'pay_same' });
    assert.equal(again.status, 409);
    assert.equal(again.data.error.code, 'payment_reused');
  }
  assert.equal((await h.db.first("SELECT COUNT(*) AS n FROM sales WHERE razorpay_payment_id='pay_same'")).n, 1);
  assert.equal((await h.db.first("SELECT COUNT(*) AS n FROM ledger WHERE kind='commission'")).n, 1);
  assert.equal((await h.db.first('SELECT COUNT(*) AS n FROM codes')).n, 0);
  // belt and braces: the unique index itself rejects a second row, whatever the application code does
  await assert.rejects(() => h.db.run("INSERT INTO sales (id,site_id,order_id,amount_minor,tax_minor,net_minor,currency,paid_at,hold_days,eligible_at,attribution,razorpay_payment_id,created_at) VALUES ('x','mom','ox',1,0,1,'INR',1,1,1,'none','pay_same',1)"), /UNIQUE/);
});

test('capture amount or Razorpay order id that does not match the sale never confirms it', async () => {
  const h = await mk();
  const p = await h.staff('partner', 'Mis');
  const ck = await click(h, p);
  // amount differs
  await h.signed('mom', 'POST', '/v1/integration/sales', { order_id: 'a1', amount_minor: 100000, click_id: ck, razorpay_payment_id: 'pay_a1' });
  await h.rzp({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_a1', amount: 50000 } } } }, { eventId: 'e-a1' });
  assert.equal((await h.db.first("SELECT rzp_status FROM sales WHERE order_id='a1'")).rzp_status, 'mismatch');
  // same amount, different Razorpay order
  await h.signed('mom', 'POST', '/v1/integration/sales', { order_id: 'a2', amount_minor: 100000, click_id: ck, razorpay_payment_id: 'pay_a2', razorpay_order_id: 'order_expected' });
  await h.rzp({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_a2', amount: 100000, order_id: 'order_other' } } } }, { eventId: 'e-a2' });
  assert.equal((await h.db.first("SELECT rzp_status FROM sales WHERE order_id='a2'")).rzp_status, 'mismatch');
  // capture first, then the sale with a wrong order id
  await h.rzp({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_a3', amount: 100000, order_id: 'order_real' } } } }, { eventId: 'e-a3' });
  await h.signed('mom', 'POST', '/v1/integration/sales', { order_id: 'a3', amount_minor: 100000, click_id: ck, razorpay_payment_id: 'pay_a3', razorpay_order_id: 'order_fake' });
  assert.equal((await h.db.first("SELECT rzp_status FROM sales WHERE order_id='a3'")).rzp_status, 'mismatch');
  h.advance(40 * DAY);
  assert.equal((await bal(h, p)).available_minor, 0);
});

// ---------------------------------------------------------------- payout destination

test('payout destination is frozen at request time: KYC edits are blocked while a payout is open, and a swap behind the API\'s back is NOT paid', async () => {
  const h = await mk();
  const p = await funded(h);
  const po = (await h.call('POST', '/v1/me/payouts', { key: p.key })).data;
  assert.match(po.destination_masked, /^pi\*+@okbank$/, 'the owner can recognise where the money goes');
  const edit = await h.call('PUT', '/v1/me/kyc', { key: p.key, body: { pan: 'ABCDE1234F', upi_id: 'attacker@okbank' } });
  assert.equal(edit.status, 409);
  assert.equal(edit.data.error.code, 'payout_open');
  // simulate someone with database access swapping the stored KYC after the request
  await h.db.run('UPDATE user_kyc SET upi_id=? WHERE user_id=?', [await encryptField(ENV.KYC_KEY, 'attacker@okbank'), p.id]);
  const ap = await h.call('POST', `/v1/admin/payouts/${po.id}/approve`, { key: h.owner });
  assert.equal(ap.status, 200);
  assert.equal(h.payouts.calls.length, 1);
  assert.equal(h.payouts.calls[0].destination.upi_id, 'pia@okbank', 'the provider was given the destination that existed when the payout was requested');
  // once the payout is settled the partner may change details again (and must be re-verified)
  await h.call('POST', `/v1/admin/payouts/${po.id}/mock-settle`, { key: h.owner });
  assert.equal((await h.call('PUT', '/v1/me/kyc', { key: p.key, body: { pan: 'ABCDE1234F', upi_id: 'new@okbank' } })).status, 200);
});

test('the owner sees what he is verifying: masked KYC in the queue, full values only on request and only for the owner, every reveal logged', async () => {
  const h = await mk();
  const p = await h.staff('partner', 'Seen');
  await h.call('POST', `/v1/admin/users/${p.id}/verify-email`, { key: h.owner });
  await h.call('PUT', '/v1/me/kyc', { key: p.key, body: { pan: 'ABCDE1234F', upi_id: 'seen@okbank' } });
  const q = (await h.call('GET', '/v1/admin/queue', { key: h.ai })).data;
  const d = q.kyc[0].details;
  assert.equal(d.pan, 'AB******4F');
  assert.equal(d.upi_id, 'se***@okbank');
  assert.ok(!JSON.stringify(q).includes('ABCDE1234F') && !JSON.stringify(q).includes('seen@okbank'), 'the queue never carries the full values');
  assert.equal((await h.call('GET', `/v1/admin/users/${p.id}/kyc`, { key: h.ai })).status, 403, 'the AI cannot reveal');
  const full = await h.call('GET', `/v1/admin/users/${p.id}/kyc`, { key: h.owner });
  assert.equal(full.data.pan, 'ABCDE1234F');
  assert.equal((await auditActions(h, 'kyc.revealed')).length, 1);
});

test('foreign partner: the owner can read the frozen bank destination (logged) to pay by hand, and can release a transfer that failed', async () => {
  const h = await mk();
  const r = await h.call('POST', '/v1/admin/users', { key: h.owner, body: { role: 'partner', name: 'Abroad', email: 'ab@example.test', phone: '+441234567890', country: 'GB' } });
  const p = { id: r.data.user.id, key: r.data.api_key };
  await h.verifyUser(p, { tax_id: 'GB123456', bank_account: '12345678', bank_ifsc_swift: 'BARCGB22', bank_name: 'Barclays' });
  const ck = await click(h, p);
  await h.sale('mom', { order_id: 'ab1', click_id: ck, amount_minor: 1000000 });
  h.advance(38 * DAY);
  const po = (await h.call('POST', '/v1/me/payouts', { key: p.key })).data;
  assert.equal(po.destination_masked, 'Barclays ****5678');
  await h.call('POST', `/v1/admin/payouts/${po.id}/approve`, { key: h.owner });
  assert.equal((await h.call('GET', `/v1/admin/payouts/${po.id}/destination`, { key: h.ai })).status, 403);
  const dest = (await h.call('GET', `/v1/admin/payouts/${po.id}/destination`, { key: h.owner })).data;
  assert.equal(dest.destination.bank_account, '12345678');
  assert.equal(dest.destination.bank_ifsc_swift, 'BARCGB22');
  assert.equal((await auditActions(h, 'payout.destination_revealed')).length, 1);
  // the transfer did not go through: the owner releases it from the console and the money is back
  const fail = await h.call('POST', `/v1/admin/payouts/${po.id}/mark-failed`, { key: h.owner, body: { reason: 'bank rejected', confirmed_not_sent: true } });
  assert.equal(fail.data.status, 'failed');
  assert.equal((await bal(h, p)).available_minor, 150000);
  assert.equal((await h.call('POST', `/v1/admin/payouts/${po.id}/mark-failed`, { key: h.ai })).status, 403);
});

// ---------------------------------------------------------------- webhooks: reversal and out-of-state events

test('payout.reversed after the payout was marked paid: acknowledged (no endless retries), money back to the partner, flagged reversed', async () => {
  const h = await mk();
  const p = await funded(h);
  const po = (await h.call('POST', '/v1/me/payouts', { key: p.key })).data;
  const ap = (await h.call('POST', `/v1/admin/payouts/${po.id}/approve`, { key: h.owner })).data;
  await h.rzp({ event: 'payout.processed', payload: { payout: { entity: { id: ap.provider_ref, reference_id: po.id, amount: po.net_minor, utr: 'UTR1' } } } }, { eventId: 'p1' });
  assert.equal((await h.db.first('SELECT status FROM payouts WHERE id=?', [po.id])).status, 'paid');
  const rev = await h.rzp({ event: 'payout.reversed', payload: { payout: { entity: { id: ap.provider_ref, reference_id: po.id, amount: po.net_minor, failure_reason: 'beneficiary bank down' } } } }, { eventId: 'p2' });
  assert.equal(rev.status, 200, 'never a 409 that makes Razorpay retry forever');
  const row = await h.db.first('SELECT * FROM payouts WHERE id=?', [po.id]);
  assert.equal(row.status, 'failed');
  assert.ok(row.reversed_at > 0);
  assert.equal(row.paid_ref, 'UTR1', 'the original payment reference stays as history');
  const b = await bal(h, p);
  assert.equal(b.available_minor, 150000);
  assert.equal(b.paid_minor, 0);
  assert.equal(b.ledger_total_minor, b.available_minor + b.pending_minor);
  assert.equal((await auditActions(h, 'payout.reversed')).length, 1);
  assert.equal((await h.rzp({ event: 'payout.reversed', payload: { payout: { entity: { id: ap.provider_ref } } } }, { eventId: 'p2' })).data.duplicate, true);
  // the partner can ask again
  assert.equal((await h.call('POST', '/v1/me/payouts', { key: p.key })).status, 201);
});

test('payout events that do not fit the payout\'s state are acknowledged and sent to review, never marked paid and never a retry loop', async () => {
  const h = await mk();
  const p = await funded(h);
  const po = (await h.call('POST', '/v1/me/payouts', { key: p.key })).data; // still pending_approval: the owner has not approved
  const early = await h.rzp({ event: 'payout.processed', payload: { payout: { entity: { id: 'pout_x', reference_id: po.id, amount: po.net_minor } } } }, { eventId: 'x1' });
  assert.equal(early.status, 200);
  assert.equal(early.data.needs_review, true);
  assert.equal((await h.db.first('SELECT status FROM payouts WHERE id=?', [po.id])).status, 'pending_approval', 'an unapproved payout is never turned into paid by an event');
  const ap = (await h.call('POST', `/v1/admin/payouts/${po.id}/approve`, { key: h.owner })).data;
  const wrong = await h.rzp({ event: 'payout.processed', payload: { payout: { entity: { id: ap.provider_ref, reference_id: po.id, amount: po.net_minor + 1 } } } }, { eventId: 'x2' });
  assert.equal(wrong.data.needs_review, true);
  assert.equal((await h.db.first('SELECT status FROM payouts WHERE id=?', [po.id])).status, 'processing', 'wrong amount does not mark it paid');
  assert.equal((await auditActions(h, 'payout.amount_mismatch')).length, 1);
  assert.equal((await auditActions(h, 'payout.event_unexpected')).length, 1);
  // a failure event for a payout the owner already rejected
  const p2 = await funded(h, 'Rex');
  const po2 = (await h.call('POST', '/v1/me/payouts', { key: p2.key })).data;
  await h.call('POST', `/v1/admin/payouts/${po2.id}/reject`, { key: h.owner });
  const late = await h.rzp({ event: 'payout.failed', payload: { payout: { entity: { id: 'pout_y', reference_id: po2.id } } } }, { eventId: 'x3' });
  assert.equal(late.status, 200);
  assert.equal(late.data.needs_review, true);
});

// ---------------------------------------------------------------- claims / chargebacks

test('a Razorpay dispute holds the commission until resolved: won releases it, lost refunds it, the ledger stays balanced', async () => {
  const h = await mk();
  const p = await funded(h, 'Dee', { sales: 2 });
  const [s1, s2] = p.sales;
  assert.equal((await bal(h, p)).available_minor, 300000);
  const ev = (type, order, extra = {}) => h.rzp({ event: type, payload: { dispute: { entity: { id: 'disp_' + order, payment_id: 'pay_' + order, amount: 1000000, ...extra } } } }, { eventId: `${type}:${order}` });
  assert.equal((await ev('payment.dispute.created', s1)).status, 200);
  let b = await bal(h, p);
  assert.equal(b.available_minor, 150000, 'the disputed sale is on hold');
  assert.equal(b.on_claim_minor, 150000);
  assert.equal((await h.call('GET', '/v1/admin/summary', { key: h.owner })).data.open_claims, 1);
  await ev('payment.dispute.won', s1);
  b = await bal(h, p);
  assert.equal(b.available_minor, 300000, 'claim cleared');
  await ev('payment.dispute.created', s2);
  await ev('payment.dispute.lost', s2);
  b = await bal(h, p);
  assert.equal(b.available_minor, 150000, 'the lost claim is refunded and its commission voided');
  assert.equal((await h.db.first('SELECT status FROM sales WHERE order_id=?', [s2])).status, 'refunded');
  assert.equal(b.ledger_total_minor, b.available_minor + b.pending_minor);
  assert.equal((await verifyLedger(h.db)).ok, true);
});

test('a claim on a sale already in a waiting payout cancels that payout; one raised before the sale is recorded is applied when it arrives', async () => {
  const h = await mk();
  const p = await funded(h, 'Cat', { sales: 2 });
  const po = (await h.call('POST', '/v1/me/payouts', { key: p.key })).data;
  assert.equal(po.gross_minor, 300000);
  await h.rzp({ event: 'payment.dispute.created', payload: { dispute: { entity: { id: 'd1', payment_id: 'pay_' + p.sales[0], amount: 1000000 } } } }, { eventId: 'd1' });
  assert.equal((await h.db.first('SELECT status FROM payouts WHERE id=?', [po.id])).status, 'rejected');
  const b = await bal(h, p);
  assert.equal(b.available_minor, 150000, 'the undisputed sale is free again; the disputed one is held');
  assert.equal(b.in_payout_minor, 0);
  assert.equal(b.ledger_total_minor, b.available_minor + b.pending_minor);
  // claim event BEFORE the site reports the sale
  await h.rzp({ event: 'payment.dispute.created', payload: { dispute: { entity: { id: 'd2', payment_id: 'pay_early', amount: 1000000 } } } }, { eventId: 'd2' });
  const ck = await click(h, p);
  await h.sale('mom', { order_id: 'early', click_id: ck, amount_minor: 1000000, razorpay_payment_id: 'pay_early' });
  assert.equal((await h.db.first("SELECT dispute_status FROM sales WHERE order_id='early'")).dispute_status, 'open');
});

test('claims by hand: only the owner can hold or resolve; an unclear "closed" dispute stays on hold for review', async () => {
  const h = await mk();
  const p = await funded(h, 'Hal');
  const sid = await saleId(h, p.sales[0]);
  assert.equal((await h.call('POST', `/v1/admin/sales/${sid}/claim`, { key: h.ai, body: { action: 'hold' } })).status, 403);
  assert.equal((await h.call('POST', `/v1/admin/sales/${sid}/claim`, { key: h.owner, body: { action: 'weird' } })).status, 422);
  assert.equal((await h.call('POST', `/v1/admin/sales/${sid}/claim`, { key: h.owner, body: { action: 'hold', note: 'customer called' } })).data.dispute_status, 'open');
  assert.equal((await bal(h, p)).available_minor, 0);
  const closed = await h.rzp({ event: 'payment.dispute.closed', payload: { dispute: { entity: { id: 'dz', payment_id: 'pay_' + p.sales[0], amount: 1000000 } } } }, { eventId: 'dz' });
  assert.equal(closed.data.needs_review, true);
  assert.equal((await bal(h, p)).available_minor, 0, 'still held');
  assert.equal((await h.call('POST', `/v1/admin/sales/${sid}/claim`, { key: h.owner, body: { action: 'won' } })).data.dispute_status, 'won');
  assert.equal((await bal(h, p)).available_minor, 150000);
  assert.equal((await h.call('GET', '/v1/admin/claims', { key: h.ai })).data.claims.length, 1);
});

// ---------------------------------------------------------------- refunds

test('a refund while the payout is still waiting for approval voids the commission and cancels that payout (no clawback applies before money is sent)', async () => {
  const h = await mk();
  const p = await funded(h, 'Ref', { sales: 2 });
  const po = (await h.call('POST', '/v1/me/payouts', { key: p.key })).data;
  const r = await h.signed('mom', 'POST', '/v1/integration/refunds', { order_id: p.sales[0], reason: 'changed mind', usage_verified: true });
  assert.equal(r.data.status, 'refunded');
  assert.equal(r.data.refund_after_payout, false, 'not "after payout": nothing had been sent');
  assert.equal((await h.db.first('SELECT status FROM payouts WHERE id=?', [po.id])).status, 'rejected');
  const b = await bal(h, p);
  assert.equal(b.available_minor, 150000, 'only the unrefunded sale is payable');
  assert.equal(b.ledger_total_minor, b.available_minor + b.pending_minor);
  assert.equal((await verifyLedger(h.db)).ok, true);
  // the owner can no longer approve the cancelled payout
  assert.equal((await h.call('POST', `/v1/admin/payouts/${po.id}/approve`, { key: h.owner })).status, 409);
  // the partner can request again for the right amount
  assert.equal((await h.call('POST', '/v1/me/payouts', { key: p.key })).data.gross_minor, 150000);
});

test('refunds record whether the buyer really used the product, and the owner is told when proof is missing', async () => {
  const h = await mk();
  const p = await funded(h, 'Use', { sales: 2 });
  await h.signed('mom', 'POST', '/v1/integration/refunds', { order_id: p.sales[0], usage_verified: true });
  await h.signed('mom', 'POST', '/v1/integration/refunds', { order_id: p.sales[1] });
  assert.equal((await h.db.first('SELECT usage_verified FROM sales WHERE order_id=?', [p.sales[0]])).usage_verified, 1);
  assert.equal((await h.db.first('SELECT usage_verified FROM sales WHERE order_id=?', [p.sales[1]])).usage_verified, null);
  assert.equal((await h.call('GET', '/v1/admin/summary', { key: h.ai })).data.refunds_without_usage_proof, 1);
});

test('a refund that Razorpay reports BEFORE the sale is recorded is applied when the sale arrives (and partial refunds add up)', async () => {
  const h = await mk();
  const p = await h.staff('partner', 'Ord');
  const ck = await click(h, p);
  await h.rzp({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_ord', amount: 1000000 } } } }, { eventId: 'o1' });
  await h.rzp({ event: 'refund.processed', payload: { refund: { entity: { id: 'rf1', payment_id: 'pay_ord', amount: 1000000 } } } }, { eventId: 'o2' });
  const sale = await h.signed('mom', 'POST', '/v1/integration/sales', { order_id: 'ord1', amount_minor: 1000000, click_id: ck, razorpay_payment_id: 'pay_ord' });
  assert.equal(sale.status, 201);
  assert.equal((await h.db.first("SELECT status FROM sales WHERE order_id='ord1'")).status, 'refunded');
  h.advance(40 * DAY);
  assert.equal((await bal(h, p)).available_minor, 0, 'nothing payable from a refunded sale');
  assert.equal((await bal(h, p)).ledger_total_minor, 0);
  // two partial refunds that together cover the payment
  await h.sale('mom', { order_id: 'part1', click_id: ck, amount_minor: 1000000 });
  const one = await h.rzp({ event: 'refund.processed', payload: { refund: { entity: { id: 'r1', payment_id: 'pay_part1', amount: 400000 } } } }, { eventId: 'pr1' });
  assert.equal(one.data.needs_review, true);
  const two = await h.rzp({ event: 'refund.processed', payload: { refund: { entity: { id: 'r2', payment_id: 'pay_part1', amount: 600000 } } } }, { eventId: 'pr2' });
  assert.equal(two.data.refunded, true);
});

// ---------------------------------------------------------------- hold clock, self-referral

test('a site cannot shorten the hold by back-dating paid_at beyond max_backdate_days', async () => {
  const h = await mk();
  const p = await h.staff('partner', 'Clock');
  const ck = await click(h, p);
  const r = await h.signed('mom', 'POST', '/v1/integration/sales', { order_id: 'bd1', amount_minor: 100000, click_id: ck, paid_at: h.clock.t - 29 * DAY });
  assert.equal(r.status, 201);
  assert.equal(r.data.eligible_at, h.clock.t - 1 * DAY + 37 * DAY, 'clock starts at most one day before we heard of it');
  assert.ok(r.data.eligible_at > h.clock.t + 35 * DAY);
  // the owner can change the allowance
  await h.call('PUT', '/v1/admin/policy', { key: h.owner, body: { max_backdate_days: 0 } });
  const r2 = await h.signed('mom', 'POST', '/v1/integration/sales', { order_id: 'bd2', amount_minor: 100000, click_id: ck, paid_at: h.clock.t - 5 * DAY });
  assert.equal(r2.data.eligible_at, h.clock.t + 37 * DAY);
});

test('self-referral is also caught by phone number when the site sends it', async () => {
  const h = await mk();
  const p = await h.staff('partner', 'Fone'); // phone 9876543210
  const ck = await click(h, p);
  const r = await h.signed('mom', 'POST', '/v1/integration/sales', { order_id: 'ph1', amount_minor: 100000, click_id: ck, customer_email: 'someone.else@example.test', customer_phone: '+91 98765 43210' });
  assert.equal(r.data.status, 'blocked');
  assert.equal(r.data.block_reason, 'self_referral');
  assert.equal((await h.db.first('SELECT COUNT(*) AS n FROM ledger')).n, 0);
});

// ---------------------------------------------------------------- audit completeness

test('key issue, revoke and secret rotation are audited in the SAME atomic batch (a failing audit row leaves no key behind)', async () => {
  const h = await mk();
  // happy paths leave exactly one entry each
  const k = await h.call('POST', '/v1/admin/keys', { key: h.owner, body: { kind: 'ai', label: 'x' } });
  await h.call('DELETE', `/v1/admin/keys/${k.data.id}`, { key: h.owner });
  await h.call('POST', '/v1/admin/sites/mom/rotate-secret', { key: h.owner });
  for (const a of ['key.create', 'key.revoke', 'site.secret_rotated']) assert.equal((await auditActions(h, a)).length, 1, a);
  // atomicity: an audit row that cannot be written means the key row is not written either
  const before = (await h.db.first('SELECT COUNT(*) AS n FROM api_keys')).n;
  await assert.rejects(() => createKey(h.ctx, { kind: 'ai' }, { audit: [{ action: null, target: 'key:x' }] }), /NOT NULL/);
  assert.equal((await h.db.first('SELECT COUNT(*) AS n FROM api_keys')).n, before);
  const live = await createKey(h.ctx, { kind: 'ai' });
  await assert.rejects(() => revokeKey(h.ctx, live.id, { audit: [{ action: null, target: 'key:x' }] }), /NOT NULL/);
  assert.equal((await h.db.first('SELECT revoked_at FROM api_keys WHERE id=?', [live.id])).revoked_at, null, 'not revoked without its log entry');
  // a failing audit entry also stops a secret rotation from taking effect
  const v = (await h.db.first("SELECT secret_version AS v FROM sites WHERE id='mom'")).v;
  await assert.rejects(() => atomic(h.ctx, async () => [
    { sql: 'UPDATE sites SET secret_version = secret_version + 1 WHERE id=?', params: ['mom'] },
    ...(await auditStmts(h.ctx, [{ action: null, target: 'site:mom' }])),
  ]), /NOT NULL/);
  assert.equal((await h.db.first("SELECT secret_version AS v FROM sites WHERE id='mom'")).v, v);
});

test('key issuance for people is audited (self-registration and owner-created staff)', async () => {
  const h = await mk();
  await h.call('POST', '/v1/register', { body: { role: 'refer', name: 'Rina' } });
  await h.staff('partner', 'Sam');
  const rows = await auditActions(h, 'key.issue');
  assert.equal(rows.length, 2);
});

test('refused attempts and AI reads are in the action log', async () => {
  const h = await mk();
  const po = { key: h.ai };
  await h.call('POST', '/v1/admin/payouts/po_nope/approve', po); // AI lacks the scope
  const denied = await auditActions(h, 'access.denied');
  assert.equal(denied.length, 1);
  assert.equal(denied[0].actor_type, 'ai');
  assert.ok(denied[0].key_id, 'attributed to the key that tried');
  await h.call('GET', '/v1/admin/users', { key: h.ai });
  await h.call('GET', '/v1/admin/queue', { key: h.ai });
  assert.equal((await auditActions(h, 'ai.read')).length, 2);
  await h.call('GET', '/v1/admin/users', { key: h.owner });
  assert.equal((await auditActions(h, 'ai.read')).length, 2, 'only the AI\'s reads are logged as AI reads');
  // junk requests with no key are logged, but at most 20 per IP per hour so they cannot flood the log
  for (let i = 0; i < 30; i++) await h.call('GET', '/v1/admin/users');
  const n = (await auditActions(h, 'access.denied')).length;
  assert.ok(n <= 21 && n >= 15, `bounded: ${n}`);
});

test('the first owner key is minted straight into the action log, only on a fresh database', async () => {
  const { raw, db } = openDb();
  const sql = ownerKeySql({ id: 'abc123def456', secret: 'f'.repeat(48), now: 1_800_000_000_000 });
  raw.exec(sql);
  assert.equal((await db.first("SELECT COUNT(*) AS n FROM api_keys WHERE kind='owner'")).n, 1);
  assert.equal((await db.first('SELECT action FROM audit_log')).action, 'key.bootstrap');
  assert.deepEqual(await verifyAudit(db), { ok: true, rows: 1 });
  raw.exec(ownerKeySql({ id: 'ffffffffffff', secret: 'a'.repeat(48), now: 1_800_000_001_000 })); // a second run is a no-op
  assert.equal((await db.first('SELECT COUNT(*) AS n FROM api_keys')).n, 1);
  assert.equal((await db.first('SELECT COUNT(*) AS n FROM audit_log')).n, 1);
});

// ---------------------------------------------------------------- sites and hosts

test('seeded sites: only hosts from the owner\'s domain map are live; every host is on an owned domain; none on townhall.com', async () => {
  const { db } = openDb();
  const { seedSites } = await import('../scripts/lib.mjs');
  await seedSites(db);
  const rows = await db.all('SELECT id, host, active, host_confirmed FROM sites ORDER BY id');
  assert.equal(rows.length, 9);
  assert.deepEqual(rows.filter((r) => r.active).map((r) => r.id).sort(), ['aios', 'dpdp', 'projexa', 'tam', 'th']);
  for (const r of rows) {
    assert.equal(r.active, r.host_confirmed, `${r.id}: live only if confirmed`);
    assert.ok(/(^|\.)(veridian-aios\.com|projexa-ai\.com|corporatetambola\.com|townhall-records\.com)$/.test(r.host), `${r.host} is on an owned domain`);
    assert.ok(!r.host.endsWith('townhall.com'));
  }
  assert.equal(DEFAULT_SITES.length, 9);
});

test('site hosts: the owner confirms before a site goes live; a host outside the owned domains is refused; redirects refuse a foreign host even if the table is edited', async () => {
  const h = await mk();
  await h.db.run("UPDATE sites SET active=0, host_confirmed=0 WHERE id='el'");
  const patch = (body, key = h.owner) => h.call('PATCH', '/v1/admin/sites/el', { key, body });
  assert.equal((await patch({ active: 1 })).data.error.code, 'host_unconfirmed');
  assert.equal((await patch({ host: 'elections.evil.example' })).status, 422);
  assert.equal((await patch({ host: 'townhall-records.com.evil.example' })).status, 422);
  assert.equal((await patch({ host: 'elections.townhall-records.com', host_confirmed: 1, active: 1 })).data.active, 1);
  // changing a live site's host switches it off until confirmed again
  const moved = (await patch({ host: 'vote.townhall-records.com' })).data;
  assert.equal(moved.host_confirmed, 0);
  assert.equal(moved.active, 0);
  assert.equal((await patch({ active: 1 }, h.ai)).status, 403);
  // refund terms editable by the owner, short text refused
  assert.equal((await patch({ refund_terms: 'no' })).status, 422);
  assert.match((await patch({ refund_terms: 'Refund only if you really used the product within 30 days.' })).data.refund_terms, /really used/);
  // defence in depth: even if the table is changed behind the API, a redirect never leaves the owned domains
  const p = await h.staff('partner', 'Redir');
  const l = await h.call('POST', '/v1/me/links', { key: p.key, body: { site_id: 'th', path: '/' } });
  await h.db.run("UPDATE sites SET host='phish.example.net' WHERE id='th'");
  const res = await handle(h.ctx, new Request(`https://pc.test${l.data.url}`));
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error.code, 'site_host_not_owned');
});

test('buyers can read the refund terms before paying (owner wording, or a marked draft default)', async () => {
  const h = await mk();
  const sites = (await h.call('GET', '/v1/public/sites')).data;
  const mom = sites.find((s) => s.id === 'mom');
  assert.match(mom.refund_terms, /30 days/);
  assert.match(mom.refund_terms, /genuinely used/);
  assert.match(sites.find((s) => s.id === 'tam').refund_terms, /checkout/);
  await h.call('PATCH', '/v1/admin/sites/mom', { key: h.owner, body: { refund_terms: 'Owner wording: refund after real use only.' } });
  assert.equal((await h.call('GET', '/v1/public/sites')).data.find((s) => s.id === 'mom').refund_terms, 'Owner wording: refund after real use only.');
});

// ---------------------------------------------------------------- RazorpayX mode is real

test('PAYOUT_MODE is enforced against the key prefix: test never takes a live key, live never takes a test key', async () => {
  const mkA = (keyId, mode) => () => razorpayXAdapter({ keyId, keySecret: 's'.repeat(16), accountNumber: '2323230000000000', fetchImpl: async () => ({}), mode });
  assert.throws(mkA('rzp_live_abc', 'test'), /rzp_test_/);
  assert.throws(mkA('rzp_test_abc', 'live'), /rzp_live_/);
  assert.throws(mkA('abc', 'test'), /rzp_test_/);
  assert.throws(mkA('rzp_test_abc', 'sandbox'), /PAYOUT_MODE/);
  assert.equal(mkA('rzp_test_abc', 'test')().mode, 'test');
  assert.equal(mkA('rzp_live_abc', 'live')().mode, 'live');
  const env = (mode, id) => ({ PAYOUT_MODE: mode, RAZORPAYX_KEY_ID: id, RAZORPAYX_KEY_SECRET: 'x'.repeat(16), RAZORPAYX_ACCOUNT_NUMBER: '2323230000000000' });
  assert.throws(() => adaptersFromEnv(env('test', 'rzp_live_zzz'), fetch), /refusing/);
  assert.equal(adaptersFromEnv(env('live', 'rzp_live_zzz'), fetch).payouts.mode, 'live');
  // the Pages Function answers a bad pairing with a JSON error, not a crash page
  const { onRequest } = await import('../functions/[[path]].js');
  const res = await onRequest({ request: new Request('https://pc.test/v1/health'), env: { ...env('test', 'rzp_live_zzz') } });
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error.code, 'server_misconfigured');
});

test('the mode that really sent a payout is recorded on it', async () => {
  const h = await mk({ payouts: { mode: 'test', async createPayout() { return { provider: 'razorpayx', provider_ref: 'pout_1', status: 'processing', mode: 'test' }; } } });
  const p = await funded(h, 'Mode');
  const po = (await h.call('POST', '/v1/me/payouts', { key: p.key })).data;
  const ap = (await h.call('POST', `/v1/admin/payouts/${po.id}/approve`, { key: h.owner })).data;
  assert.equal(ap.provider_mode, 'test');
  assert.equal((await h.call('GET', '/v1/admin/summary', { key: h.owner })).data.payout_mode, 'test');
});

// ---------------------------------------------------------------- e-mail

test('without a configured mailer a verification request says so (503) instead of pretending; the owner can verify the address by hand and payouts can proceed', async () => {
  const h = await mk();
  const bare = makeCtx({ db: h.db, env: ENV, now: () => h.clock.t }); // no mailer given: the production default
  assert.equal(typeof bare.mailer.send, 'function');
  await assert.rejects(() => bare.mailer.send({}), /not set up/);
  const p = await h.staff('partner', 'Mail');
  const r = await handle(bare, new Request('https://pc.test/v1/me/email/send-code', { method: 'POST', headers: { authorization: `Bearer ${p.key}` } }));
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error.code, 'mail_not_configured');
  assert.equal((await h.db.first('SELECT COUNT(*) AS n FROM email_codes')).n, 0, 'no orphan code stored');
  // owner fallback; AI cannot do it; an address that is not on file cannot be vouched for
  assert.equal((await h.call('POST', `/v1/admin/users/${p.id}/verify-email`, { key: h.ai })).status, 403);
  assert.equal((await h.call('POST', `/v1/admin/users/${p.id}/verify-email`, { key: h.owner })).data.email_verified, true);
  assert.equal((await auditActions(h, 'user.email_verified_by_owner')).length, 1);
  assert.equal((await h.call('PUT', '/v1/me/kyc', { key: p.key, body: { pan: 'ABCDE1234F', upi_id: 'mail@okbank' } })).status, 200);
  const ref = await h.call('POST', '/v1/register', { body: { role: 'refer', name: 'NoMail' } });
  assert.equal((await h.call('POST', `/v1/admin/users/${ref.data.user.id}/verify-email`, { key: h.owner })).status, 422);
  assert.equal(unconfiguredMailer().send.length, 0);
});

test('e-mail code attempts cannot exceed the cap even with parallel guesses', async () => {
  const h = await mk();
  const p = await h.staff('partner', 'Race');
  await h.call('POST', '/v1/me/email/send-code', { key: p.key });
  const good = h.mailer.outbox.at(-1)._code;
  const wrong = good === '000000' ? '111111' : '000000';
  const results = await Promise.all(Array.from({ length: 12 }, () => h.call('POST', '/v1/me/email/verify', { key: p.key, body: { code: wrong } })));
  assert.equal((await h.db.first('SELECT attempts FROM email_codes WHERE user_id=?', [p.id])).attempts, 5, 'exactly five guesses were counted');
  assert.equal(results.filter((r) => r.data.error.code === 'wrong_code').length, 5);
  const late = await h.call('POST', '/v1/me/email/verify', { key: p.key, body: { code: good } });
  assert.equal(late.status, 429, 'the right code no longer works after five wrong guesses');
});

test('approvals and payout outcomes are e-mailed to partners with a verified address', async () => {
  const h = await mk();
  const r = await h.call('POST', '/v1/register', { body: { role: 'partner', name: 'Nora', email: 'nora@example.test', phone: '9876500777' } });
  const key = r.data.api_key;
  await h.call('POST', '/v1/me/email/send-code', { key });
  await h.call('POST', '/v1/me/email/verify', { key, body: { code: h.mailer.outbox.at(-1)._code } });
  const before = h.mailer.outbox.length;
  await h.call('POST', `/v1/admin/users/${r.data.user.id}/approve`, { key: h.owner });
  assert.match(h.mailer.outbox[before].subject, /approved/);
  assert.equal(h.mailer.outbox[before].to, 'nora@example.test');
  // an unverified partner gets nothing
  const u = await h.staff('partner', 'Quiet');
  const n = h.mailer.outbox.length;
  await h.call('POST', `/v1/admin/users/${u.id}/suspend`, { key: h.owner });
  await h.call('POST', `/v1/admin/users/${u.id}/reinstate`, { key: h.owner });
  assert.equal(h.mailer.outbox.length, n);
  // payout paid
  const p = await funded(h, 'Paid');
  const po = (await h.call('POST', '/v1/me/payouts', { key: p.key })).data;
  const m = h.mailer.outbox.length;
  await h.call('POST', `/v1/admin/payouts/${po.id}/approve`, { key: h.owner });
  await h.call('POST', `/v1/admin/payouts/${po.id}/mock-settle`, { key: h.owner });
  assert.ok(h.mailer.outbox.slice(m).some((x) => /sent/.test(x.subject)));
});

// ---------------------------------------------------------------- keys, suspension, hierarchy

test('a non-array scopes value is a clean 422, not a 500', async () => {
  const h = await mk();
  for (const scopes of ['admin.read', { a: 1 }, 5, [1]]) {
    const r = await h.call('POST', '/v1/admin/keys', { key: h.owner, body: { kind: 'ai', scopes } });
    assert.equal(r.status, 422, JSON.stringify(scopes));
  }
});

test('a suspended partner\'s key stops working at once and works again when reinstated', async () => {
  const h = await mk();
  const p = await h.staff('partner', 'Sus');
  assert.equal((await h.call('GET', '/v1/me', { key: p.key })).status, 200);
  await h.call('POST', `/v1/admin/users/${p.id}/suspend`, { key: h.owner });
  for (const [m, path] of [['GET', '/v1/me'], ['GET', '/v1/me/summary'], ['POST', '/v1/me/email/send-code'], ['PUT', '/v1/me/kyc']]) {
    const r = await h.call(m, path, { key: p.key, body: m === 'PUT' ? {} : undefined });
    assert.equal(r.status, 403, path);
    assert.equal(r.data.error.code, 'account_suspended');
  }
  await h.call('POST', `/v1/admin/users/${p.id}/reinstate`, { key: h.owner });
  assert.equal((await h.call('GET', '/v1/me', { key: p.key })).status, 200);
});

test('promotion and moving a team: owner only, no loops, children stay valid, effective for future sales, audited', async () => {
  const h = await mk();
  const mgr = await h.staff('manager', 'Mgr');
  const lead = await h.staff('leader', 'Lead', mgr);
  const exec = await h.staff('exec', 'Exec', lead);
  const part = await h.staff('partner', 'Part', exec);
  const place = (id, body, key = h.owner) => h.call('POST', `/v1/admin/users/${id}/placement`, { key, body });
  assert.equal((await place(exec.id, { role: 'leader' }, h.ai)).status, 403);
  assert.equal((await place(exec.id, {})).status, 422);
  assert.equal((await place(lead.id, { parent_id: part.id })).data.error.code, 'invalid_parent', 'a leader cannot report to a partner');
  assert.equal((await place(mgr.id, { parent_id: part.id })).status, 422, 'no loop through own team');
  assert.equal((await place(exec.id, { role: 'partner' })).data.error.code, 'children_conflict', 'a partner below could not report to another partner');
  // before: part's sale pays exec 1.0%, lead 0.75%, mgr 0.5%
  const ck = await click(h, part);
  await h.sale('mom', { order_id: 'pl1', click_id: ck, amount_minor: 1000000 });
  assert.deepEqual((await h.db.all("SELECT account_id FROM ledger WHERE kind='override'")).map((r) => r.account_id).sort(), [exec.id, lead.id, mgr.id].sort());
  // promote exec to leader (reports to the manager directly): the new overrides follow
  const done = await place(exec.id, { role: 'leader', parent_id: mgr.id });
  assert.equal(done.status, 200);
  assert.equal(done.data.role, 'leader');
  await h.sale('mom', { order_id: 'pl2', click_id: ck, amount_minor: 1000000 });
  const over2 = await h.db.all("SELECT account_id FROM ledger WHERE kind='override' AND memo LIKE '%' ORDER BY seq");
  assert.equal(over2.length, 3 + 2, 'the old team lead no longer earns on the moved branch: manager + exec(now leader)');
  assert.equal((await auditActions(h, 'user.placement')).length, 1);
  assert.equal((await verifyLedger(h.db)).ok, true);
});

test('a test-only AI key holding an owner-only scope is still refused by the route (defence in depth behind the scope check)', async () => {
  const h = await mk();
  const p = await funded(h, 'Def');
  const po = (await h.call('POST', '/v1/me/payouts', { key: p.key })).data;
  const bad = await createKey(h.ctx, { kind: 'ai' });
  await h.db.run('UPDATE api_keys SET scopes=? WHERE id=?', [JSON.stringify(['payouts.approve', 'kyc.verify', '*']), bad.id]);
  for (const path of [`/v1/admin/payouts/${po.id}/approve`, `/v1/admin/users/${p.id}/kyc/review`]) {
    const r = await h.call('POST', path, { key: bad.token, body: {} });
    assert.equal(r.status, 403, path);
    assert.equal(r.data.error.message, 'only the owner can do this');
  }
});

// ---------------------------------------------------------------- shared context, verification, retention

test('requests never share an acting identity: the base context is untouched by an authenticated call', async () => {
  const h = await mk();
  assert.equal(h.ctx.actor, null);
  await h.call('PUT', '/v1/admin/policy', { key: h.owner, body: { min_payout_minor: 5000 } });
  assert.equal(h.ctx.actor, null, 'no actor leaks onto the shared ctx');
  // concurrent owner and public requests keep their own attribution
  await Promise.all([
    h.call('PUT', '/v1/admin/policy', { key: h.owner, body: { min_payout_minor: 6000 } }),
    h.call('POST', '/v1/register', { body: { role: 'refer', name: 'Conc1' } }),
    h.call('POST', '/v1/register', { body: { role: 'refer', name: 'Conc2' } }),
  ]);
  const regs = await h.db.all("SELECT actor_type, actor_id FROM audit_log WHERE action='user.create'");
  assert.ok(regs.every((r) => r.actor_type === 'system' && r.actor_id === null), 'public sign-ups are never attributed to the concurrent owner call');
  assert.equal((await h.db.first("SELECT actor_type FROM audit_log WHERE action='policy.update' ORDER BY seq DESC")).actor_type, 'owner');
});

test('chain verification is incremental and resumable, detects tampering behind a checkpoint, and ?full=1 re-hashes everything', async () => {
  const h = await mk();
  for (let i = 0; i < 6; i++) await h.call('PUT', '/v1/admin/policy', { key: h.owner, body: { min_payout_minor: 1000 + i } });
  const total = (await h.db.first('SELECT COUNT(*) AS n FROM audit_log')).n;
  const a = await verifyAudit(h.db, { incremental: true, max: 4, now: 1 });
  assert.equal(a.ok, true);
  assert.equal(a.checked, 4);
  assert.equal(a.complete, false);
  const b = await verifyAudit(h.db, { incremental: true, max: 4, now: 2 });
  assert.equal(b.checked, total - 4);
  assert.equal(b.complete, true);
  const c = await verifyAudit(h.db, { incremental: true, now: 3 });
  assert.equal(c.checked, 0, 'nothing new to read');
  const viaApi = (await h.call('GET', '/v1/admin/verify', { key: h.ai })).data;
  assert.equal(viaApi.audit.ok, true);
  assert.equal(viaApi.ledger.ok, true);
  // tamper with an old row (drop the trigger like an attacker with raw access would)
  h.raw.exec('DROP TRIGGER audit_no_update');
  h.raw.exec("UPDATE audit_log SET hash='deadbeef' WHERE seq=2");
  assert.equal((await verifyAudit(h.db)).ok, false, 'a full pass catches an edit anywhere in history');
  // the cheap incremental pass only re-checks the checkpoint row, so a deep edit is what ?full=1 is for (documented trade-off)
  const last = (await h.db.first('SELECT MAX(seq) AS s FROM audit_log')).s;
  h.raw.exec(`UPDATE audit_log SET hash='cafebabe' WHERE seq=${last}`);
  const caught = await verifyAudit(h.db, { incremental: true, now: 4 });
  assert.equal(caught.ok, false, 'an edit to the checkpoint row itself is caught by the incremental pass');
  const full = (await h.call('GET', '/v1/admin/verify?full=1', { key: h.owner })).data;
  assert.equal(full.audit.ok, false);
});

test('retention: the purge removes only expired transient data, can be run by the AI or the owner, and never touches money or the audit chain', async () => {
  const h = await mk();
  const p = await funded(h, 'Old');
  await h.call('POST', '/v1/me/email/send-code', { key: p.key }); // already verified in funded(): returns already_verified, no row
  await h.db.run("INSERT INTO idempotency (scope,req_hash,status,body,created_at) VALUES ('old','h',200,'{}',?)", [h.clock.t - 9 * DAY]);
  await h.db.run("INSERT INTO idempotency (scope,req_hash,status,body,created_at) VALUES ('new','h',200,'{}',?)", [h.clock.t - 1 * DAY]);
  await h.db.run("INSERT INTO email_codes (user_id,code_hash,expires_at,attempts,sent_at) VALUES (?,?,?,0,?)", [p.id, 'x', h.clock.t - 3 * DAY, h.clock.t - 3 * DAY]);
  const ledgerBefore = (await h.db.first('SELECT COUNT(*) AS n FROM ledger')).n;
  const clicksBefore = (await h.db.first('SELECT COUNT(*) AS n FROM clicks')).n;
  assert.equal((await h.call('POST', '/v1/admin/maintenance/purge', { key: p.key })).status, 403);
  assert.equal((await h.call('POST', '/v1/admin/maintenance/purge')).status, 401);
  h.advance(200 * DAY); // clicks and leads from 238 days ago are past the 180-day retention
  const r = await h.call('POST', '/v1/admin/maintenance/purge', { key: h.ai });
  assert.equal(r.status, 200);
  assert.equal(r.data.clicks, clicksBefore);
  assert.equal(r.data.idempotency >= 2, true);
  assert.equal(r.data.email_codes, 1);
  assert.equal((await h.db.first('SELECT COUNT(*) AS n FROM ledger')).n, ledgerBefore, 'ledger untouched');
  assert.equal((await verifyAudit(h.db)).ok, true);
  assert.equal((await auditActions(h, 'maintenance.purge')).length, 1);
});

test('erasure (DPDP): personal details go, the money trail stays; refused while money is owed or a payout is open', async () => {
  const h = await mk();
  const p = await funded(h, 'Gone');
  const erase = (key = h.owner) => h.call('POST', `/v1/admin/users/${p.id}/erase`, { key });
  assert.equal((await erase(h.ai)).status, 403);
  assert.equal((await erase()).data.error.code, 'balance_not_zero');
  const po = (await h.call('POST', '/v1/me/payouts', { key: p.key })).data;
  assert.equal((await erase()).data.error.code, 'payout_open');
  await h.call('POST', `/v1/admin/payouts/${po.id}/approve`, { key: h.owner });
  await h.call('POST', `/v1/admin/payouts/${po.id}/mock-settle`, { key: h.owner });
  // paid in full: reserve and commission net to zero
  const ledgerRows = (await h.db.first('SELECT COUNT(*) AS n FROM ledger WHERE account_id=?', [p.id])).n;
  assert.equal((await bal(h, p)).ledger_total_minor, 0);
  assert.equal((await erase()).data.erased, true);
  const u = await h.db.first('SELECT * FROM users WHERE id=?', [p.id]);
  assert.equal(u.name, 'Erased user');
  assert.equal(u.email, null);
  assert.equal(u.email_hash, null);
  assert.equal(u.phone, null);
  assert.equal((await h.db.first('SELECT COUNT(*) AS n FROM user_kyc WHERE user_id=?', [p.id])).n, 0);
  assert.equal((await h.db.first('SELECT dest_enc, destination_masked FROM payouts WHERE id=?', [po.id])).dest_enc, null);
  assert.equal((await h.call('GET', '/v1/me', { key: p.key })).status, 401, 'its keys are revoked');
  assert.equal((await h.db.first('SELECT COUNT(*) AS n FROM ledger WHERE account_id=?', [p.id])).n, ledgerRows, 'ledger entries stay');
  assert.equal((await verifyLedger(h.db)).ok, true);
  assert.equal((await erase()).data.already, true);
});

// ---------------------------------------------------------------- D1 limits, static CSP checks

test('/v1/me/summary works for a team of 130 under D1\'s 100-bound-variable limit', async () => {
  const h = await mk();
  const mgr = await h.staff('manager', 'Big');
  // quick bulk insert of 130 direct reports (partners) below the manager
  for (let i = 0; i < 130; i++) {
    await h.db.run("INSERT INTO users (id,role,name,status,parent_id,created_at) VALUES (?,?,?,?,?,?)", [`u_bulk${i}`, 'partner', `P${i}`, 'active', mgr.id, h.clock.t]);
  }
  const strict = (fn) => (sql, params = []) => { if (params.length > 100) throw new Error('D1_ERROR: too many SQL variables (limit 100)'); return fn(sql, params); };
  for (const m of ['all', 'first', 'run']) h.ctx.db[m] = strict(h.ctx.db[m].bind(h.ctx.db));
  const r = await h.call('GET', '/v1/me/summary', { key: mgr.key });
  assert.equal(r.status, 200);
  assert.equal(JSON.stringify(r.data).includes('too many'), false);
});

import { readFileSync } from 'node:fs';
test('static CSP check: style-src stays strict and the UI never emits an inline style attribute, inline script or inline handler', () => {
  const headers = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8');
  assert.match(headers, /style-src 'self'(;|\s*$|\r?\n)/);
  assert.ok(!/unsafe-inline/.test(headers));
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.ok(!/\sstyle\s*=/.test(html), 'no style attributes in index.html');
  assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>/.test(html), 'no inline scripts');
  assert.ok(!/\son[a-z]+\s*=/.test(html), 'no inline event handlers');
  const js = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8').split(/\r?\n/).filter((l) => !l.trim().startsWith('//')).join(' ');
  assert.ok(!/setAttribute\(\s*['"]style['"]/.test(js));
  assert.ok(!/style\s*:\s*['"][a-z-]+\s*:/i.test(js), 'no string style values left that would become attributes');
});
