import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mk, DAY } from './helpers.js';
import { handle } from '../src/app.js';
import { razorpayXAdapter, adaptersFromEnv, mockPayoutAdapter, resendMailer } from '../src/adapters.js';
import { verifyLedger, verifyAudit } from '../src/chain.js';

const click = async (h, user, siteId = 'mom') => {
  const l = await h.call('POST', '/v1/me/links', { key: user.key, body: { site_id: siteId, path: '/' } });
  const res = await handle(h.ctx, new Request(`https://pc.test${l.data.url}`));
  return new URL(res.headers.get('location')).searchParams.get('pc');
};
const bal = async (h, u) => (await h.call('GET', '/v1/me/balance', { key: u.key })).data;

/** A verified partner with Rs 1,500 payable (one Rs 10,000 MOM sale, 15%), 38 days after the sale. */
async function funded(h, name = 'Pia') {
  const p = await h.staff('partner', name);
  await h.verifyUser(p);
  const ck = await click(h, p);
  await h.sale('mom', { order_id: `o-${name}`, click_id: ck, amount_minor: 1000000 });
  h.advance(38 * DAY);
  return p;
}

test('payout gating: active, e-mail verified, KYC verified, above the minimum, one open payout at a time', async () => {
  const h = await mk();
  const p = await h.staff('partner', 'Gate');
  assert.equal((await h.call('POST', '/v1/me/payouts', { key: p.key })).data.error.code, 'email_unverified');
  await h.call('POST', '/v1/me/email/send-code', { key: p.key });
  await h.call('POST', '/v1/me/email/verify', { key: p.key, body: { code: h.mailer.outbox.at(-1)._code } });
  assert.equal((await h.call('POST', '/v1/me/payouts', { key: p.key })).data.error.code, 'kyc_required');
  await h.call('PUT', '/v1/me/kyc', { key: p.key, body: { pan: 'ABCDE1234F', upi_id: 'gate@okbank' } });
  assert.equal((await h.call('POST', '/v1/me/payouts', { key: p.key })).data.error.code, 'kyc_required', 'submitted is not verified');
  await h.call('POST', `/v1/admin/users/${p.id}/kyc/review`, { key: h.owner, body: { approve: true } });
  const below = await h.call('POST', '/v1/me/payouts', { key: p.key });
  assert.equal(below.data.error.code, 'below_minimum');
  assert.equal(below.data.error.min_payout_minor, 100000);
  const ck = await click(h, p);
  await h.sale('mom', { order_id: 'g1', click_id: ck, amount_minor: 1000000 });
  assert.equal((await h.call('POST', '/v1/me/payouts', { key: p.key })).data.error.code, 'below_minimum', 'not matured yet');
  h.advance(38 * DAY);
  const ok = await h.call('POST', '/v1/me/payouts', { key: p.key });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.gross_minor, 150000);
  assert.equal(ok.data.status, 'pending_approval');
  assert.ok(!ok.data.destination_masked.includes('gate@'), 'destination is masked');
  assert.equal((await h.call('POST', '/v1/me/payouts', { key: p.key })).data.error.code, 'payout_open');
});

test('only the owner can approve; AI can see the queue but not approve; approval hands the net amount to the provider adapter', async () => {
  const h = await mk();
  await h.call('PUT', '/v1/admin/policy', { key: h.owner, body: { tds_bps_default: 1000 } });
  const p = await funded(h);
  const po = (await h.call('POST', '/v1/me/payouts', { key: p.key })).data;
  assert.equal(po.tds_minor, 15000);
  assert.equal(po.net_minor, 135000);
  const q = await h.call('GET', '/v1/admin/queue', { key: h.ai });
  assert.equal(q.data.payouts.length, 1);
  assert.equal(q.data.payouts[0].handle, p.handle);
  for (const act of ['approve', 'reject', 'execute', 'mock-settle']) assert.equal((await h.call('POST', `/v1/admin/payouts/${po.id}/${act}`, { key: h.ai })).status, 403, act);
  assert.equal((await h.call('POST', `/v1/admin/payouts/${po.id}/approve`, { key: p.key })).status, 403);
  const ap = await h.call('POST', `/v1/admin/payouts/${po.id}/approve`, { key: h.owner });
  assert.equal(ap.status, 200);
  assert.equal(ap.data.status, 'processing');
  assert.equal(ap.data.provider, 'mock');
  assert.equal(h.payouts.calls.length, 1);
  const call = h.payouts.calls[0];
  assert.equal(call.amount_minor, 135000, 'provider receives the amount after TDS');
  assert.equal(call.destination.upi_id, 'partner@okbank');
  assert.equal(call.payout_id, po.id);
  assert.equal((await h.call('POST', `/v1/admin/payouts/${po.id}/approve`, { key: h.owner })).status, 409, 'cannot approve twice');
  assert.equal((await h.call('POST', `/v1/admin/payouts/${po.id}/execute`, { key: h.owner })).status, 409, 'cannot submit twice');
  assert.equal(h.payouts.calls.length, 1);
});

test('provider confirms via signed webhook: payout becomes paid, balances move from in-payout to paid', async () => {
  const h = await mk();
  const p = await funded(h);
  const po = (await h.call('POST', '/v1/me/payouts', { key: p.key })).data;
  const ap = (await h.call('POST', `/v1/admin/payouts/${po.id}/approve`, { key: h.owner })).data;
  assert.equal((await h.rzp({ event: 'payout.processed', payload: { payout: { entity: { id: ap.provider_ref, reference_id: po.id, utr: 'UTR123456' } } } }, { eventId: 'pp1' })).status, 200);
  const done = (await h.call('GET', '/v1/me/payouts', { key: p.key })).data.payouts[0];
  assert.equal(done.status, 'paid');
  assert.equal(done.paid_ref, 'UTR123456');
  const b = await bal(h, p);
  assert.equal(b.paid_minor, 150000);
  assert.equal(b.in_payout_minor, 0);
  assert.equal(b.available_minor, 0);
  // replayed event is ignored, a second payout cannot be requested against the same money
  assert.equal((await h.rzp({ event: 'payout.processed', payload: { payout: { entity: { id: ap.provider_ref, utr: 'OTHER' } } } }, { eventId: 'pp1' })).data.duplicate, true);
  assert.equal((await h.call('GET', '/v1/me/payouts', { key: p.key })).data.payouts[0].paid_ref, 'UTR123456');
  assert.equal((await h.call('POST', '/v1/me/payouts', { key: p.key })).data.error.code, 'below_minimum');
});

test('reject releases the reserve; failed provider call stays approved and is retryable; money never double-counts', async () => {
  const h = await mk();
  const p = await funded(h);
  const po = (await h.call('POST', '/v1/me/payouts', { key: p.key })).data;
  const rej = await h.call('POST', `/v1/admin/payouts/${po.id}/reject`, { key: h.owner, body: { note: 'check PAN again' } });
  assert.equal(rej.data.status, 'rejected');
  assert.equal((await bal(h, p)).available_minor, 150000);
  assert.equal((await h.db.first('SELECT COUNT(*) AS n FROM payout_items')).n, 0);
  // request again; provider throws on the first execute
  const po2 = (await h.call('POST', '/v1/me/payouts', { key: p.key })).data;
  let fail = true;
  h.ctx.payouts = { mode: 'test', async createPayout(r) { if (fail) throw new Error('provider timeout'); return { provider: 'mock', provider_ref: 'pout_ok', status: 'processing' }; } };
  const first = await h.call('POST', `/v1/admin/payouts/${po2.id}/approve`, { key: h.owner });
  assert.equal(first.status, 502);
  assert.equal((await h.db.first('SELECT status FROM payouts WHERE id=?', [po2.id])).status, 'approved');
  fail = false;
  const retry = await h.call('POST', `/v1/admin/payouts/${po2.id}/execute`, { key: h.owner });
  assert.equal(retry.data.status, 'processing');
  assert.equal((await h.call('POST', `/v1/admin/payouts/${po2.id}/reject`, { key: h.owner })).status, 409, 'cannot reject once submitted');
});

test('mock-settle works only in mock mode', async () => {
  const h = await mk();
  const p = await funded(h);
  const po = (await h.call('POST', '/v1/me/payouts', { key: p.key })).data;
  await h.call('POST', `/v1/admin/payouts/${po.id}/approve`, { key: h.owner });
  assert.equal((await h.call('POST', `/v1/admin/payouts/${po.id}/mock-settle`, { key: h.owner })).data.status, 'paid');
  const h2 = await mk({ payouts: { mode: 'test', async createPayout() { return { provider: 'x', provider_ref: 'p', status: 'processing' }; } } });
  const p2 = await funded(h2, 'Quinn');
  const po2 = (await h2.call('POST', '/v1/me/payouts', { key: p2.key })).data;
  await h2.call('POST', `/v1/admin/payouts/${po2.id}/approve`, { key: h2.owner });
  assert.equal((await h2.call('POST', `/v1/admin/payouts/${po2.id}/mock-settle`, { key: h2.owner })).status, 403);
});

test('NO CLAWBACK: a refund after the commission was swept into a payout keeps the payout intact and flags it for the owner', async () => {
  const h = await mk();
  const p = await funded(h);
  const po = (await h.call('POST', '/v1/me/payouts', { key: p.key })).data;
  const r = await h.signed('mom', 'POST', '/v1/integration/refunds', { order_id: 'o-Pia', reason: 'late chargeback' });
  assert.equal(r.data.status, 'refunded');
  assert.equal(r.data.refund_after_payout, true);
  assert.equal((await h.db.first("SELECT COUNT(*) AS n FROM ledger WHERE kind='void'")).n, 0, 'nothing is clawed back');
  const q = await h.call('GET', '/v1/admin/queue', { key: h.owner });
  assert.equal(q.data.payouts[0].flagged_refunds, 1);
  const ap = (await h.call('POST', `/v1/admin/payouts/${po.id}/approve`, { key: h.owner })).data;
  assert.equal(ap.status, 'processing');
  assert.equal((await h.call('GET', '/v1/admin/summary', { key: h.owner })).data.flagged_refunds, 1);
});

test('a refunded sale whose payout later FAILS does not become payable again (voided on release)', async () => {
  const h = await mk();
  const p = await funded(h);
  const po = (await h.call('POST', '/v1/me/payouts', { key: p.key })).data;
  await h.signed('mom', 'POST', '/v1/integration/refunds', { order_id: 'o-Pia' });
  const ap = (await h.call('POST', `/v1/admin/payouts/${po.id}/approve`, { key: h.owner })).data;
  await h.rzp({ event: 'payout.reversed', payload: { payout: { entity: { id: ap.provider_ref, reference_id: po.id } } } }, { eventId: 'rev1' });
  const b = await bal(h, p);
  assert.equal(b.available_minor, 0);
  assert.equal(b.ledger_total_minor, 0);
  assert.equal((await h.db.first("SELECT COUNT(*) AS n FROM ledger WHERE kind='void'")).n, 1);
});

test('overrides are payable to upline staff the same way (their own KYC, own payout)', async () => {
  const h = await mk();
  const m = await h.staff('manager', 'Boss');
  const p = await h.staff('partner', 'Under', m);
  await h.verifyUser(m);
  const ck = await click(h, p);
  await h.sale('mom', { order_id: 'ov1', click_id: ck, amount_minor: 100000000 }); // Rs 10 lakh -> manager override 50 bps = Rs 5,000
  h.advance(38 * DAY);
  assert.equal((await bal(h, m)).available_minor, 500000);
  const po = await h.call('POST', '/v1/me/payouts', { key: m.key });
  assert.equal(po.data.gross_minor, 500000);
});

test('minimum payout is policy-driven and TDS is recorded per payout (India only)', async () => {
  const h = await mk();
  const p = await funded(h);
  await h.call('PUT', '/v1/admin/policy', { key: h.owner, body: { min_payout_minor: 200000 } });
  assert.equal((await h.call('POST', '/v1/me/payouts', { key: p.key })).data.error.code, 'below_minimum');
  await h.call('PUT', '/v1/admin/policy', { key: h.owner, body: { min_payout_minor: 100000, tds_bps_default: 500 } });
  const po = await h.call('POST', '/v1/me/payouts', { key: p.key });
  assert.deepEqual([po.data.tds_bps, po.data.tds_minor, po.data.net_minor], [500, 7500, 142500]);
});

test('audit trail records every step with the acting key; chains verify at the end', async () => {
  const h = await mk();
  const p = await funded(h);
  const po = (await h.call('POST', '/v1/me/payouts', { key: p.key })).data;
  await h.call('POST', `/v1/admin/payouts/${po.id}/approve`, { key: h.owner });
  await h.call('POST', `/v1/admin/payouts/${po.id}/mock-settle`, { key: h.owner });
  const a = (await h.call('GET', '/v1/admin/audit?limit=200', { key: h.owner })).data.entries;
  const actions = a.map((x) => x.action);
  for (const need of ['user.create', 'kyc.submit', 'kyc.verified', 'sale.recorded', 'payout.request', 'payout.approve', 'payout.submitted', 'payout.paid']) assert.ok(actions.includes(need), need);
  const approve = a.find((x) => x.action === 'payout.approve');
  assert.equal(approve.actor_type, 'owner');
  assert.ok(approve.key_id);
  assert.equal(a.find((x) => x.action === 'payout.request').actor_id, p.id);
  assert.equal(a.find((x) => x.action === 'sale.recorded').actor_type, 'site');
  assert.equal((await verifyLedger(h.db)).ok, true);
  assert.equal((await verifyAudit(h.db)).ok, true);
  const logs = (await h.call('GET', '/v1/me/logs', { key: p.key })).data.logs;
  assert.ok(logs.some((l) => l.type === 'payout' && l.result === 'paid'));
});

// ------------------------------------------------------------------ adapters (no network: injected fetch)

test('RazorpayX adapter builds the documented request (UPI and bank), sends an idempotency header, maps errors', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ id: 'pout_abc', status: 'processing' }) };
  };
  const a = razorpayXAdapter({ keyId: 'rzp_test_x', keySecret: 'secretsecretsecret', accountNumber: '2323230000000000', fetchImpl });
  const r = await a.createPayout({ payout_id: 'po_1', amount_minor: 135000, method: 'upi', destination: { upi_id: 'a@okbank' }, name: 'Pia' });
  assert.deepEqual(r, { provider: 'razorpayx', provider_ref: 'pout_abc', status: 'processing' });
  assert.equal(seen[0].url, 'https://api.razorpay.com/v1/payouts');
  assert.equal(seen[0].init.headers['X-Payout-Idempotency'], 'po_1');
  assert.match(seen[0].init.headers.authorization, /^Basic /);
  assert.equal(seen[0].body.amount, 135000);
  assert.equal(seen[0].body.mode, 'UPI');
  assert.equal(seen[0].body.fund_account.vpa.address, 'a@okbank');
  await a.createPayout({ payout_id: 'po_2', amount_minor: 5000, method: 'bank', destination: { bank_account: '123456', bank_ifsc_swift: 'HDFC0000001' }, name: 'Pia' });
  assert.equal(seen[1].body.fund_account.account_type, 'bank_account');
  const bad = razorpayXAdapter({ keyId: 'k', keySecret: 's', accountNumber: 'n', fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: { description: 'insufficient balance' } }) }) });
  await assert.rejects(() => bad.createPayout({ payout_id: 'po_3', amount_minor: 1, method: 'upi', destination: { upi_id: 'a@b' }, name: 'x' }), /insufficient balance/);
  assert.throws(() => razorpayXAdapter({ keyId: 'k' }), /incomplete/);
});

test('adapters from env: mock by default; RazorpayX only when PAYOUT_MODE is set on purpose; mail only with Resend configured', async () => {
  assert.equal(adaptersFromEnv({}, fetch).payouts.mode, 'mock');
  assert.equal(adaptersFromEnv({}, fetch).mailer, undefined);
  assert.throws(() => adaptersFromEnv({ PAYOUT_MODE: 'live' }, fetch), /incomplete/);
  const t = adaptersFromEnv({ PAYOUT_MODE: 'test', RAZORPAYX_KEY_ID: 'a', RAZORPAYX_KEY_SECRET: 'b', RAZORPAYX_ACCOUNT_NUMBER: 'c' }, fetch);
  assert.equal(t.payouts.mode, 'test');
  const sent = [];
  const m = resendMailer({ apiKey: 're_x', from: 'Partner Circle <no-reply@example.test>', fetchImpl: async (u, i) => (sent.push([u, JSON.parse(i.body)]), { ok: true, status: 200 }) });
  await m.send({ to: 'a@example.test', subject: 's', text: 't', _code: '123456' });
  assert.equal(sent[0][0], 'https://api.resend.com/emails');
  assert.ok(!JSON.stringify(sent[0][1]).includes('_code'), 'internal test field never leaves the process');
  assert.equal(mockPayoutAdapter().mode, 'mock');
});
