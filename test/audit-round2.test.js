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
