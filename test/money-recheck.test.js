// Money rules rechecked against the owner decisions of 14 Nov 2026 (full table: docs/MONEY-RULES-RECHECK-2026-11-25.md).
// Every test here opens the harness with { realDefaults: true }, so it runs on the genuinely seeded values (the older tests keep the plain
// behaviour they were written for). Each test names the decision it protects and fails if that behaviour is broken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mk, DAY } from './helpers.js';
import { handle } from '../src/app.js';
import { stubEngines } from '../src/engines.js';
import { nextPayDay, splitAmount, earlyShareBps, payoutWaitText, POLICY_DEFAULTS } from '../src/policy.js';
import { postingSaleRef } from '../src/suite.js';
import { verifyLedger, verifyAudit } from '../src/chain.js';
import { openDb } from '../scripts/lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const click = async (h, user, siteId = 'mom') => {
  const l = await h.call('POST', '/v1/me/links', { key: user.key, body: { site_id: siteId, path: '/' } });
  const res = await handle(h.ctx, new Request(`https://pc.test${l.data.url}`, { headers: { 'cf-connecting-ip': '198.51.100.9' } }));
  return new URL(res.headers.get('location')).searchParams.get('pc');
};
const ledger = (h, userId) => h.db.all('SELECT kind, amount_minor, eligible_at, ref, sale_id FROM ledger WHERE account_id=? ORDER BY seq', [userId]);
const bal = async (h, u) => (await h.call('GET', '/v1/me/balance', { key: u.key })).data;
/** A moment in India time (UTC+5:30), as epoch ms. */
const ist = (y, m, d, hh = 0, mm = 0) => Date.UTC(y, m - 1, d, hh, mm) - 330 * 60000;
/** The genuine seeded rates, minimum and split, with pay days and the joining bonus off so a test looks at one rule at a time. */
const fresh = (extra = {}) => mk({ realDefaults: true, payDays: [], joiningBonus: 0, ...extra });
const sourceFiles = (dir, exts) => readdirSync(join(ROOT, dir)).flatMap((f) => {
  const rel = `${dir}/${f}`;
  if (statSync(join(ROOT, rel)).isDirectory()) return sourceFiles(rel, exts);
  return exts.some((e) => f.endsWith(e)) ? [rel] : [];
});
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// ------------------------------------------------------------------ the seeded defaults

test('seeded defaults follow the owner decisions: minimum 500 rupees, team share off, 500 rupee joining bonus for 30 days, pay days 15 and the last day', async () => {
  const h = await mk({ realDefaults: true });
  const pol = (await h.call('GET', '/v1/admin/policy', { key: h.owner })).data;
  assert.equal(pol.min_payout_minor, 50000);
  assert.deepEqual(pol.override_bps, { exec: 0, leader: 0, manager: 0 });
  assert.equal(pol.joining_bonus_minor, 50000);
  assert.equal(pol.joining_bonus_valid_days, 30);
  assert.deepEqual(pol.pay_days, [15, 31]);
  assert.equal(POLICY_DEFAULTS.min_payout_minor, 50000);
});

test('Corporate Tambola pays Growth Partners 25% and Refer and Earn 25%; the games have no discount codes (review items 1 and 8)', async () => {
  const h = await mk({ realDefaults: true, payDays: [], joiningBonus: 0 });
  const by = Object.fromEntries((await h.call('GET', '/v1/admin/sites', { key: h.owner })).data.sites.map((s) => [s.id, s]));
  assert.deepEqual([by.tam.commission_bps, by.tam.refer_bps, by.tam.discount_allowed, by.tam.max_discount_bps], [2500, 2500, 0, 0]);
  for (const id of ['tam', 'voter', 'th', 'el', 'mt']) assert.equal(by[id].discount_allowed, 0, `${id} has no discount codes`);
  const p = await h.staff('partner', 'Gia');
  const code = await h.call('POST', '/v1/me/codes', { key: p.key, body: { site_id: 'tam', discount_bps: 500, code: 'GIA5', max_uses: 5 } });
  assert.ok(code.status >= 400, `a discount code for a game is refused (got ${code.status})`);
  const ck = await click(h, p, 'tam');
  const r = await h.sale('tam', { order_id: 't1', click_id: ck, amount_minor: 400000 });
  assert.equal(r.data.commission_minor, 100000, '25% of the net sale');
});

test('each product shows its own payout wait in plain words, and it follows what the rate card really does', async () => {
  const h = await mk({ realDefaults: true });
  const sites = Object.fromEntries((await h.call('GET', '/v1/public/sites')).data.map((s) => [s.id, s]));
  for (const id of ['mom', 'dpdp', 'aios', 'projexa']) assert.equal(sites[id].payout_wait, '80% is paid 7 days after the sale and the rest after 37 days, once the payment is confirmed. A joining bonus is held until it is eligible, like the commission on that first sale.', id);
  for (const id of ['tam', 'th', 'voter', 'el', 'mt']) assert.equal(sites[id].payout_wait, 'Paid 7 days after the sale, once the payment is confirmed. A joining bonus is held until it is eligible, like the commission on that first sale.', id);
  // the sentence is computed from the site's own numbers: change the split and the sentence changes with it
  assert.equal((await h.call('PATCH', '/v1/admin/sites/mom', { key: h.owner, body: { early_release_bps: 5000 } })).status, 200);
  assert.equal((await h.call('GET', '/v1/public/sites')).data.find((s) => s.id === 'mom').payout_wait, '50% is paid 7 days after the sale and the rest after 37 days, once the payment is confirmed. A joining bonus is held until it is eligible, like the commission on that first sale.');
  for (const bad of [10000, -1, 12.5, '80']) assert.equal((await h.call('PATCH', '/v1/admin/sites/mom', { key: h.owner, body: { early_release_bps: bad } })).status, 422, `early_release_bps ${bad}`);
  assert.equal(payoutWaitText({ return_days: 0, buffer_days: 7, early_release_bps: 8000 }), 'Paid 7 days after the sale, once the payment is confirmed. A joining bonus is held until it is eligible, like the commission on that first sale.', 'no money-back window, nothing to split');
  assert.equal(earlyShareBps({ return_days: 30, buffer_days: 7, early_release_bps: 10000 }), 0, 'a share of 100% is not a split');
});

test('new policy keys are validated: pay days, bonus amount and bonus window', async () => {
  const h = await mk({ realDefaults: true });
  const put = (body) => h.call('PUT', '/v1/admin/policy', { key: h.owner, body });
  assert.equal((await put({ pay_days: [10, 25], joining_bonus_minor: 0, joining_bonus_valid_days: 45 })).status, 200);
  for (const bad of [{ pay_days: [0] }, { pay_days: [32] }, { pay_days: [15, 15] }, { pay_days: [1, 2, 3, 4, 5] }, { pay_days: '15' }, { joining_bonus_minor: -1 }, { joining_bonus_valid_days: 0 }, { joining_bonus_valid_days: 366 }]) {
    assert.equal((await put(bad)).status, 422, JSON.stringify(bad));
  }
});

// ------------------------------------------------------------------ minimum payout

test('minimum payout is 500 rupees: 499.99 is refused, exactly 500.00 is accepted (owner, 14 Nov 2026)', async () => {
  const h = await fresh();
  const p = await h.staff('partner', 'Mina');
  await h.verifyUser(p);
  const ck = await click(h, p, 'tam');
  await h.sale('tam', { order_id: 'm1', click_id: ck, amount_minor: 199996 }); // 25% = 49,999 paise
  h.advance(8 * DAY);
  const below = await h.call('POST', '/v1/me/payouts', { key: p.key });
  assert.equal(below.data.error.code, 'below_minimum');
  assert.equal(below.data.error.min_payout_minor, 50000);
  assert.equal(below.data.error.available_minor, 49999);
  await h.sale('tam', { order_id: 'm2', click_id: ck, amount_minor: 4 }); // 25% of 4 paise = 1 paisa: the balance is now exactly 500.00
  h.advance(8 * DAY);
  const ok = await h.call('POST', '/v1/me/payouts', { key: p.key });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(ok.data.gross_minor, 50000);
});

// ------------------------------------------------------------------ split release (80% after 7 days, the rest after the money-back days)

test('split release: a money-back product pays 80% after 7 days and the rest after 37 (owner, 14 Nov 2026)', async () => {
  const h = await fresh();
  const p = await h.staff('partner', 'Sia');
  const ck = await click(h, p);
  const paidAt = h.clock.t;
  const r = await h.sale('mom', { order_id: 's1', click_id: ck, amount_minor: 1000000 }); // 15% of 10,000 rupees = 1,500 rupees
  assert.equal(r.status, 201);
  assert.equal(r.data.commission_minor, 150000);
  assert.equal(r.data.early_release_bps, 8000);
  assert.equal(r.data.early_eligible_at, paidAt + 7 * DAY);
  assert.equal(r.data.eligible_at, paidAt + 37 * DAY);
  const rows = await ledger(h, p.id);
  assert.deepEqual(rows.map((x) => [x.kind, x.amount_minor, x.eligible_at]), [['commission', 120000, paidAt + 7 * DAY], ['commission', 30000, paidAt + 37 * DAY]]);
  h.advance(7 * DAY - 1);
  assert.equal((await bal(h, p)).available_minor, 0, 'one millisecond before day 7 nothing is payable');
  h.advance(1);
  let b = await bal(h, p);
  assert.deepEqual([b.available_minor, b.pending_minor], [120000, 30000], 'day 7: 80% payable, 20% still waiting');
  h.advance(29 * DAY);
  assert.equal((await bal(h, p)).available_minor, 120000, 'day 36: the last part still waits');
  h.advance(DAY);
  b = await bal(h, p);
  assert.deepEqual([b.available_minor, b.pending_minor, b.ledger_total_minor], [150000, 0, 150000], 'day 37: everything payable');
  assert.equal((await verifyLedger(h.db)).ok, true);
});

test('split release: the two parts always add up to the commission, to the paisa; a one-paisa commission is one entry', async () => {
  const h = await fresh();
  const p = await h.staff('partner', 'Rio');
  const ck = await click(h, p);
  const r = await h.sale('mom', { order_id: 'odd', click_id: ck, amount_minor: 1000010 }); // 15% = 150,001.5 -> 150,001
  assert.equal(r.data.commission_minor, 150001);
  assert.deepEqual((await ledger(h, p.id)).map((x) => x.amount_minor), [120000, 30001]);
  const tiny = await h.sale('mom', { order_id: 'tiny', click_id: ck, amount_minor: 7 }); // 15% of 7 paise = 1 paisa; 80% of 1 rounds down to 0, so only the last part exists
  assert.equal(tiny.data.commission_minor, 1);
  const rows = (await ledger(h, p.id)).slice(2);
  assert.deepEqual(rows.map((x) => [x.amount_minor, x.ref.startsWith('commission-final:')]), [[1, true]]);
  for (const bps of [1, 5000, 8000, 9999]) {
    for (let t = 0; t <= 3000; t += 7) {
      const [a, b] = splitAmount(t, bps);
      assert.equal(a + b, t, `${t} at ${bps}`);
      assert.ok(a >= 0 && b >= 0);
    }
  }
  assert.deepEqual(splitAmount(150001, 0), [150001, 0]);
});

test('split release: a refund before payment cancels both parts; a refund after the first part was sent keeps what was sent, cancels the rest and flags it', async () => {
  const h = await fresh();
  // (a) refund on day 3: nothing sent, both parts are cancelled
  const a = await h.staff('partner', 'Rue');
  const ckA = await click(h, a);
  await h.sale('mom', { order_id: 'ra', click_id: ckA, amount_minor: 1000000 });
  h.advance(3 * DAY);
  const rfA = await h.signed('mom', 'POST', '/v1/integration/refunds', { order_id: 'ra' });
  assert.equal(rfA.data.status, 'refunded');
  assert.equal(rfA.data.refund_after_payout, false);
  assert.deepEqual((await ledger(h, a.id)).map((x) => [x.kind, x.amount_minor]), [['commission', 120000], ['commission', 30000], ['void', -120000], ['void', -30000]]);
  const ba = await bal(h, a);
  assert.deepEqual([ba.available_minor, ba.pending_minor, ba.ledger_total_minor], [0, 0, 0]);
  // (b) the first part was paid out, then the sale was refunded: no clawback of the sent part, the last part is cancelled, the owner is told
  const b = await h.staff('partner', 'Rob');
  await h.verifyUser(b);
  const ckB = await click(h, b);
  await h.sale('mom', { order_id: 'rb', click_id: ckB, amount_minor: 1000000 });
  h.advance(8 * DAY);
  const po = (await h.call('POST', '/v1/me/payouts', { key: b.key })).data;
  assert.equal(po.gross_minor, 120000, 'only the first part was payable');
  const ap = (await h.call('POST', `/v1/admin/payouts/${po.id}/approve`, { key: h.owner })).data;
  assert.equal(ap.status, 'processing');
  const rfB = await h.signed('mom', 'POST', '/v1/integration/refunds', { order_id: 'rb', reason: 'asked for money back on day 20' });
  assert.equal(rfB.data.status, 'refunded');
  assert.equal(rfB.data.refund_after_payout, true);
  const voids = await h.db.all("SELECT amount_minor FROM ledger WHERE kind='void' AND account_id=?", [b.id]);
  assert.deepEqual(voids.map((v) => v.amount_minor), [-30000], 'only the part that was not sent is cancelled');
  assert.equal((await h.db.first('SELECT status FROM payouts WHERE id=?', [po.id])).status, 'processing', 'the payout that was sent stays as it is');
  assert.equal((await h.call('GET', '/v1/admin/summary', { key: h.owner })).data.flagged_refunds, 1);
  const bb = await bal(h, b);
  assert.deepEqual([bb.available_minor, bb.pending_minor, bb.ledger_total_minor], [0, 0, 0]);
  assert.equal((await verifyLedger(h.db)).ok, true);
  assert.equal((await verifyAudit(h.db)).ok, true);
});

test('the owner queue counts flagged sales, not the ledger parts of one sale', async () => {
  const h = await fresh();
  const p = await h.staff('partner', 'Fia');
  await h.verifyUser(p);
  const ck = await click(h, p);
  await h.sale('mom', { order_id: 'f1', click_id: ck, amount_minor: 1000000 });
  h.advance(38 * DAY);
  const po = (await h.call('POST', '/v1/me/payouts', { key: p.key })).data;
  assert.equal(po.gross_minor, 150000);
  assert.equal((await h.db.first('SELECT COUNT(*) AS n FROM payout_items WHERE payout_id=?', [po.id])).n, 2, 'the one sale sits in the payout as two parts');
  await h.ctx.db.run("UPDATE sales SET status='refunded' WHERE order_id='f1'");
  const q = (await h.call('GET', '/v1/admin/queue', { key: h.owner })).data;
  assert.equal(q.payouts.find((x) => x.id === po.id).flagged_refunds, 1);
});

// ------------------------------------------------------------------ team share (override) is off until the owner decides

test('team share is off by default and, once switched on, follows the same split', async () => {
  const h = await fresh();
  const m = await h.staff('manager', 'Anita');
  const l = await h.staff('leader', 'Ravi', m);
  const e = await h.staff('exec', 'Sonal', l);
  const p = await h.staff('partner', 'Imran', e);
  const ck = await click(h, p);
  const r = await h.sale('mom', { order_id: 'o1', click_id: ck, amount_minor: 118000, tax_minor: 18000 });
  assert.equal(r.data.commission_minor, 15000);
  assert.deepEqual(r.data.overrides, []);
  for (const u of [m, l, e]) assert.deepEqual(await ledger(h, u.id), [], 'nobody above earns a team share until the owner decides');
  assert.equal((await h.call('PUT', '/v1/admin/policy', { key: h.owner, body: { override_bps: { exec: 100, leader: 75, manager: 50 } } })).status, 200);
  const r2 = await h.sale('mom', { order_id: 'o2', click_id: ck, amount_minor: 118000, tax_minor: 18000 });
  assert.equal(r2.data.overrides.length, 3);
  assert.deepEqual((await ledger(h, e.id)).map((x) => [x.kind, x.amount_minor]), [['override', 800], ['override', 200]], '1% of 1,000 rupees = 10 rupees, paid 80/20 like the commission');
});

// ------------------------------------------------------------------ joining bonus

test('joining bonus: 500 rupees with the first sale, once; the second sale gets none', async () => {
  const h = await fresh({ joiningBonus: 50000 });
  const p = await h.staff('partner', 'Bea');
  const ck = await click(h, p, 'tam');
  const r1 = await h.sale('tam', { order_id: 'b1', click_id: ck, amount_minor: 400000 });
  assert.equal(r1.data.bonus_minor, 50000);
  assert.equal(r1.data.commission_minor, 100000);
  const r2 = await h.sale('tam', { order_id: 'b2', click_id: ck, amount_minor: 400000 });
  assert.equal(r2.data.bonus_minor, 0);
  const rows = await ledger(h, p.id);
  assert.equal(rows.filter((x) => x.ref.startsWith('bonus:')).length, 1, 'one bonus per person');
  assert.equal(rows.find((x) => x.ref.startsWith('bonus:')).sale_id, r1.data.id, 'the bonus belongs to the first sale');
  h.advance(8 * DAY);
  assert.equal((await bal(h, p)).available_minor, 250000, 'two commissions plus one bonus');
  const sum = (await h.call('GET', '/v1/me/summary', { key: p.key })).data;
  assert.deepEqual([sum.joining_bonus.state, sum.joining_bonus.amount_minor], ['earned', 50000]);
});

test('joining bonus: the first sale must be paid within 30 days of approval (day 30 counts, a moment later does not)', async () => {
  const on30 = await fresh({ joiningBonus: 50000 });
  const a = await on30.staff('partner', 'Ann');
  on30.advance(30 * DAY);
  const ckA = await click(on30, a, 'tam'); // the click is made late on purpose, so the 30-day attribution window is not what is being tested
  assert.equal((await on30.sale('tam', { order_id: 'a1', click_id: ckA, amount_minor: 400000 })).data.bonus_minor, 50000, 'exactly 30 days after approval');
  const late = await fresh({ joiningBonus: 50000 });
  const c = await late.staff('partner', 'Cid');
  late.advance(30 * DAY + 1);
  const ckC = await click(late, c, 'tam');
  const lateSale = await late.sale('tam', { order_id: 'c1', click_id: ckC, amount_minor: 400000 });
  assert.equal(lateSale.data.commission_minor, 100000, 'the partner is credited with the sale...');
  assert.equal(lateSale.data.bonus_minor, 0, '...but one millisecond after the window there is no bonus');
  assert.equal((await late.call('GET', '/v1/me/summary', { key: c.key })).data.joining_bonus.state, 'gone');
  assert.equal((await late.db.first("SELECT COUNT(*) AS n FROM ledger WHERE ref LIKE 'bonus:%'")).n, 0);
});

test('joining bonus: it belongs to the first sale, so a refund of that sale takes it back and it is not given again', async () => {
  const h = await fresh({ joiningBonus: 50000 });
  const p = await h.staff('partner', 'Rex');
  const ck = await click(h, p, 'tam');
  await h.sale('tam', { order_id: 'x1', click_id: ck, amount_minor: 400000 });
  assert.equal((await h.signed('tam', 'POST', '/v1/integration/refunds', { order_id: 'x1' })).data.status, 'refunded');
  assert.deepEqual((await ledger(h, p.id)).map((x) => [x.kind, x.amount_minor]), [['commission', 100000], ['commission', 50000], ['void', -100000], ['void', -50000]]);
  assert.equal((await h.call('GET', '/v1/me/summary', { key: p.key })).data.joining_bonus.state, 'voided');
  const again = await h.sale('tam', { order_id: 'x2', click_id: ck, amount_minor: 400000 });
  assert.equal(again.data.bonus_minor, 0, 'one bonus per person, even after a refund');
  assert.equal((await bal(h, p)).ledger_total_minor, 100000);
});

test('joining bonus: Refer and Earn people get none; approval (not sign-up) starts the 30 days; reinstating does not restart them', async () => {
  const h = await fresh({ joiningBonus: 50000 });
  // Refer and Earn: active at sign-up, never "approved" by the owner
  const reg = await h.call('POST', '/v1/register', { body: { role: 'refer', name: 'Rae' } });
  assert.equal(reg.status, 201, JSON.stringify(reg.data));
  const rae = { id: reg.data.user.id, key: reg.data.api_key };
  const ckR = await click(h, rae, 'tam');
  const rs = await h.sale('tam', { order_id: 'r1', click_id: ckR, amount_minor: 400000 });
  assert.equal(rs.data.bonus_minor, 0);
  assert.equal(rs.data.commission_minor, 100000, 'Refer and Earn is paid 25% too');
  // a partner who signs up and waits for approval
  const reg2 = await h.call('POST', '/v1/register', { body: { role: 'partner', name: 'Pat Pending', email: 'pat.pending@example.test', phone: '9876543210' } });
  assert.equal(reg2.status, 201, JSON.stringify(reg2.data));
  const pat = reg2.data.user.id;
  assert.equal((await h.db.first('SELECT approved_at FROM users WHERE id=?', [pat])).approved_at, null, 'not approved yet, so the clock has not started');
  h.advance(10 * DAY);
  assert.equal((await h.call('POST', `/v1/admin/users/${pat}/approve`, { key: h.owner })).status, 200);
  const approvedAt = h.clock.t;
  assert.equal((await h.db.first('SELECT approved_at FROM users WHERE id=?', [pat])).approved_at, approvedAt);
  h.advance(5 * DAY);
  await h.call('POST', `/v1/admin/users/${pat}/suspend`, { key: h.owner, body: { why: 'check' } });
  h.advance(5 * DAY);
  await h.call('POST', `/v1/admin/users/${pat}/reinstate`, { key: h.owner });
  assert.equal((await h.db.first('SELECT approved_at FROM users WHERE id=?', [pat])).approved_at, approvedAt, 'reinstating keeps the first approval moment');
});

test('joining bonus on a money-back product waits for the last part: it is released with the first sale\'s final maturity', async () => {
  const h = await fresh({ joiningBonus: 50000 });
  const p = await h.staff('partner', 'Bo');
  const ck = await click(h, p);
  const t0 = h.clock.t;
  const r = await h.sale('mom', { order_id: 'bm1', click_id: ck, amount_minor: 1000000 });
  assert.equal(r.data.bonus_minor, 50000);
  const rows = await ledger(h, p.id);
  assert.deepEqual(rows.map((x) => [x.amount_minor, x.eligible_at]), [[120000, t0 + 7 * DAY], [30000, t0 + 37 * DAY], [50000, t0 + 37 * DAY]]);
  h.advance(8 * DAY);
  assert.equal((await bal(h, p)).available_minor, 120000, 'the bonus is not paid while the sale can still be refunded');
  h.advance(30 * DAY);
  assert.equal((await bal(h, p)).available_minor, 200000);
});

// ------------------------------------------------------------------ pay days: the 15th and the last day of the month

test('nextPayDay: the first pay day on or after today, in India time, with short months and year ends handled', () => {
  const days = [15, 31];
  assert.equal(nextPayDay(ist(2026, 11, 1, 11, 30), days), ist(2026, 11, 15));
  assert.equal(nextPayDay(ist(2026, 11, 15, 0, 0), days), ist(2026, 11, 15), 'the pay day itself counts');
  assert.equal(nextPayDay(ist(2026, 11, 14, 23, 59), days), ist(2026, 11, 15));
  assert.equal(nextPayDay(ist(2026, 11, 16, 0, 30), days), ist(2026, 11, 30), 'a number above the month length means its last day (November has 30)');
  assert.equal(nextPayDay(Date.UTC(2026, 10, 15, 19, 0), days), ist(2026, 11, 30), '19:00 UTC on the 15th is already the 16th in India');
  assert.equal(nextPayDay(ist(2026, 11, 30, 12, 0), days), ist(2026, 11, 30));
  assert.equal(nextPayDay(ist(2026, 12, 1, 9, 0), days), ist(2026, 12, 15));
  assert.equal(nextPayDay(ist(2026, 12, 20), days), ist(2026, 12, 31));
  assert.equal(nextPayDay(ist(2026, 12, 31, 22, 0), days), ist(2026, 12, 31));
  assert.equal(nextPayDay(ist(2027, 1, 1), days), ist(2027, 1, 15));
  assert.equal(nextPayDay(ist(2027, 2, 16), days), ist(2027, 2, 28), 'February 2027 has 28 days');
  assert.equal(nextPayDay(ist(2028, 2, 16), days), ist(2028, 2, 29), 'February 2028 has 29 days');
  assert.equal(nextPayDay(ist(2026, 11, 1), [31]), ist(2026, 11, 30));
  assert.equal(nextPayDay(ist(2026, 11, 1), []), null);
  assert.equal(nextPayDay(ist(2026, 11, 1), undefined), null);
});

test('pay days: a payout cannot be approved before its pay day unless the owner chooses early on purpose (and that is written in the action log)', async () => {
  const h = await mk({ realDefaults: true, joiningBonus: 0 }); // real pay days 15 and the last day
  const p = await h.staff('partner', 'Pam');
  await h.verifyUser(p);
  const ck = await click(h, p, 'tam');
  await h.sale('tam', { order_id: 'pd1', click_id: ck, amount_minor: 400000 });
  h.advance(8 * DAY); // 9 Nov
  const po = (await h.call('POST', '/v1/me/payouts', { key: p.key })).data;
  assert.equal(po.pay_on, ist(2026, 11, 15));
  assert.equal((await h.call('GET', '/v1/me/summary', { key: p.key })).data.next_pay_day, ist(2026, 11, 15));
  const early = await h.call('POST', `/v1/admin/payouts/${po.id}/approve`, { key: h.owner });
  assert.equal(early.status, 409);
  assert.equal(early.data.error.code, 'before_pay_day');
  assert.match(early.data.error.message, /2026-11-15/);
  assert.equal((await h.call('POST', `/v1/admin/payouts/${po.id}/approve`, { key: h.owner, body: { early: 'yes' } })).status, 409, 'only a real true counts as choosing early');
  const row = await h.db.first('SELECT status, sent_at FROM payouts WHERE id=?', [po.id]);
  assert.deepEqual([row.status, row.sent_at], ['pending_approval', null], 'nothing was approved or sent');
  assert.equal((await h.db.first("SELECT COUNT(*) AS n FROM audit_log WHERE action='payout.approve'")).n, 0);
  const ok = await h.call('POST', `/v1/admin/payouts/${po.id}/approve`, { key: h.owner, body: { early: true } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.status, 'processing');
  const meta = JSON.parse((await h.db.first("SELECT meta FROM audit_log WHERE action='payout.approve'")).meta);
  assert.equal(meta.early_approval, true);
  assert.equal(meta.pay_on, ist(2026, 11, 15));
});

test('pay days: on the pay day the owner approves normally; a request on the 16th waits for the last day of the month', async () => {
  const h = await mk({ realDefaults: true, joiningBonus: 0 });
  const p = await h.staff('partner', 'Pia');
  await h.verifyUser(p);
  const ck = await click(h, p, 'tam');
  await h.sale('tam', { order_id: 'pp1', click_id: ck, amount_minor: 400000 });
  h.clock.t = ist(2026, 11, 15, 1, 0); // 15 Nov, 01:00 in India
  const po1 = (await h.call('POST', '/v1/me/payouts', { key: p.key })).data;
  assert.equal(po1.pay_on, ist(2026, 11, 15), 'asked on the pay day itself: this day');
  assert.equal((await h.call('POST', `/v1/admin/payouts/${po1.id}/approve`, { key: h.owner })).status, 200, 'approved on the pay day without any special step');
  await h.sale('tam', { order_id: 'pp2', click_id: ck, amount_minor: 400000, paid_at: ist(2026, 11, 15, 1, 0) });
  h.clock.t = ist(2026, 11, 16, 10, 0);
  await h.call('POST', `/v1/admin/payouts/${po1.id}/mock-settle`, { key: h.owner });
  h.clock.t = ist(2026, 11, 24, 10, 0); // the second sale is mature
  const po2 = (await h.call('POST', '/v1/me/payouts', { key: p.key })).data;
  assert.equal(po2.pay_on, ist(2026, 11, 30), 'the 31st does not exist in November: the last day is the 30th');
  assert.equal((await h.call('POST', `/v1/admin/payouts/${po2.id}/approve`, { key: h.owner })).data.error.code, 'before_pay_day');
  h.clock.t = ist(2026, 11, 30, 0, 5);
  assert.equal((await h.call('POST', `/v1/admin/payouts/${po2.id}/approve`, { key: h.owner })).status, 200);
});

// ------------------------------------------------------------------ who is paid, and how it is worded

test('the payee is read from the payee record and shown from there, never written into the pages (owner rule, 29 Oct 2026)', async () => {
  const h = await mk({ realDefaults: true });
  const first = (await h.call('GET', '/v1/public/brand')).data;
  assert.equal(typeof first.payee_name, 'string');
  assert.ok(first.payee_name.length >= 2);
  const put = await h.call('PUT', '/v1/admin/tenant', { key: h.owner, body: { payee_name: 'Example Payee Private Limited' } });
  assert.equal(put.status, 200);
  assert.equal((await h.call('GET', '/v1/public/brand')).data.payee_name, 'Example Payee Private Limited');
  for (const bad of ['<b>x</b>', 'x', '', 'a\nb']) assert.equal((await h.call('PUT', '/v1/admin/tenant', { key: h.owner, body: { payee_name: bad } })).status, 422, JSON.stringify(bad));
  // the shipped code and pages carry no payee name
  const shipped = [...sourceFiles('src', ['.js']), ...sourceFiles('public', ['.html', '.js', '.css'])];
  for (const f of shipped) assert.doesNotMatch(read(f), /IT\s+SERVICES\s+BY/i, `${f} must not hard-code the payee`);
  // the pages that name the payee do it through the record
  for (const page of ['public/index.html', 'public/terms.html']) {
    assert.match(read(page), /data-payee/, `${page} fills the payee from the record`);
    assert.match(read(page), /<script src="\/?js\/payee\.js"><\/script>/, `${page} loads the filler`);
  }
  assert.match(read('public/js/payee.js'), /payee_name/);
});

test('words people see: rupee sign, one gateway name, no provider product names', async () => {
  const shipped = [...sourceFiles('public', ['.html', '.js'])];
  for (const f of shipped) {
    assert.doesNotMatch(read(f), /RazorpayX/, `${f} names the gateway as Razorpay only`);
    assert.doesNotMatch(read(f), /['"]Rs ?['"]/, `${f} writes money with the rupee sign`);
  }
  assert.match(read('public/js/app.js'), /₹/);
  const h = await mk({ realDefaults: true });
  const p = await h.staff('partner', 'Wen');
  const ex = (await h.call('GET', '/v1/me/export', { key: p.key })).data;
  assert.ok(ex.shared_with.some((s) => /Razorpay/.test(s)));
  assert.ok(!ex.shared_with.some((s) => /RazorpayX/.test(s)), 'the export names the gateway as Razorpay');
});

// ------------------------------------------------------------------ commissions sent to Moneypenny: each part is its own credit

test('Moneypenny takes each part of a split sale (and the joining bonus) as its own credit: one sale reference per credit', async () => {
  const e = stubEngines();
  const h = await fresh({ joiningBonus: 50000, engines: { mnp: e.mnp, mono: e.mono }, env: { MNP_COMMISSION_ENABLED: '1' } });
  const p = await h.staff('partner', 'Moe');
  await h.verifyUser(p);
  const ck = await click(h, p);
  await h.sale('mom', { order_id: 'mp1', click_id: ck, amount_minor: 1000000 });
  h.advance(38 * DAY);
  assert.equal((await h.call('PUT', '/v1/admin/tenant', { key: h.owner, body: { commission_dest: 'moneypenny' } })).status, 200);
  const sw = await h.call('POST', '/v1/admin/suite/sweep', { key: h.owner });
  assert.deepEqual([sw.data.claimed, sw.data.posted, sw.data.rejected], [3, 3, 0], 'early part, last part and bonus are three credits');
  assert.equal(e.fakes.mnp.state.granted.length, 3);
  assert.equal(e.fakes.mnp.state.saleRefs.size, 3);
  const refs = [...e.fakes.mnp.state.saleRefs];
  assert.deepEqual(refs.map((r) => r.replace(/^pay_\S+?(?=$|:)/, 'PAY')).sort(), ['PAY', 'PAY:bonus', 'PAY:final']);
  const b = (await h.call('GET', '/v1/me/balance', { key: p.key })).data;
  assert.equal(b.ledger_total_minor, 0, 'everything moved to Moneypenny, nothing is left to pay twice');
});

test('postingSaleRef: the first part keeps the payment id, the later parts add a suffix', () => {
  assert.equal(postingSaleRef({ kind: 'commission', pid: 'pay_1', account_id: 'u1', ref: 'commission:sl_1:u1' }), 'pay_1');
  assert.equal(postingSaleRef({ kind: 'commission', pid: 'pay_1', account_id: 'u1', ref: 'commission-final:sl_1:u1' }), 'pay_1:final');
  assert.equal(postingSaleRef({ kind: 'commission', pid: 'pay_1', account_id: 'u1', ref: 'bonus:u1' }), 'pay_1:bonus');
  assert.equal(postingSaleRef({ kind: 'override', pid: 'pay_1', account_id: 'u9', ref: 'override:sl_1:u9' }), 'pay_1:override:u9');
  assert.equal(postingSaleRef({ kind: 'override', pid: 'pay_1', account_id: 'u9', ref: 'override-final:sl_1:u9' }), 'pay_1:override:u9:final');
});

test('the SQL that seeds the sites on a real database carries the split too (scripts/sites-sql.mjs)', () => {
  const sql = execFileSync(process.execPath, [join(ROOT, 'scripts', 'sites-sql.mjs')], { encoding: 'utf8' });
  const { raw } = openDb();
  raw.exec('DELETE FROM sites');
  raw.exec(sql);
  const rows = Object.fromEntries(raw.prepare('SELECT id, early_release_bps, commission_bps, discount_allowed FROM sites').all().map((r) => [r.id, r]));
  assert.equal(Object.keys(rows).length, 9);
  for (const id of ['dpdp', 'mom', 'aios', 'projexa']) assert.equal(rows[id].early_release_bps, 8000, id);
  for (const id of ['tam', 'voter', 'th', 'el', 'mt']) assert.equal(rows[id].early_release_bps, 0, id);
  assert.deepEqual([rows.tam.commission_bps, rows.tam.discount_allowed], [2500, 0]);
});
