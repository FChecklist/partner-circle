// Migration 0007 on a database that ALREADY HOLDS ROWS (the first thing an auditor asks: "what happens to the money data that is already there?").
// The database is built the way the previous build (1.0.6) left it: migrations 0001 to 0006 and rows written with the OLD column lists. Then 0007 is
// applied exactly as scripts/lib.mjs applies it, and the real handler runs on top. In memory only: nothing here touches a real database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrationFiles } from '../scripts/lib.mjs';
import { sqliteDb } from '../src/db.js';
import { ledgerStmts, verifyLedger, verifyAudit } from '../src/chain.js';
import { createKey } from '../src/auth.js';
import { handle } from '../src/app.js';
import { nextPayDay } from '../src/policy.js';
import { mk, T0, DAY } from './helpers.js';

const OLD_PAID = T0 - 40 * DAY; // the old sale was paid 40 days before the test clock, so its commission is already payable
const OLD_ELIGIBLE = T0 - 3 * DAY; // 40 - 37 days
const OLD_COMMISSION = 60000; // 10% of 6,000 rupees

/** A database exactly as the previous build left it, not yet migrated. `upgrade()` applies 0007 the way the runner does. */
async function legacy() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const apply = (m) => { raw.exec(m.sql); raw.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(m.name, T0); };
  const files = migrationFiles();
  files.filter((m) => m.name < '0007').forEach(apply);
  const db = sqliteDb(raw);

  // sites as 1.0.6 wrote them: no early_release_bps column yet
  const site = (id, host, name, ret, comm, refer) => db.run(
    'INSERT INTO sites (id,host,name,return_days,buffer_days,commission_bps,refer_bps,discount_allowed,max_discount_bps,active,host_confirmed,created_at) VALUES (?,?,?,?,7,?,?,0,0,1,1,?)',
    [id, host, name, ret, comm, refer, OLD_PAID]);
  await site('aios', 'veridian-aios.com', 'Veridian AI OS', 30, 1000, 300);
  await site('tam', 'home.corporatetambola.com', 'Corporate Tambola', 0, 1200, 400);

  // people as 1.0.6 wrote them: no approved_at column yet
  const user = (id, handle, status, created) => db.run(
    "INSERT INTO users (id,role,name,handle,email,phone,country,email_verified,status,created_at) VALUES (?, 'partner', ?, ?, ?, '9876543210', 'IN', 0, ?, ?)",
    [id, handle, handle, `${handle}@example.test`, status, created]);
  await user('us_old', 'oldp', 'active', T0 - 90 * DAY); // approved long ago: the 30 day joining-bonus window has long closed
  await user('us_fresh', 'freshp', 'active', T0 - 5 * DAY); // approved 5 days ago: still inside the window
  await user('us_susp', 'suspp', 'suspended', T0 - 60 * DAY);
  await user('us_wait', 'waitp', 'pending', T0 - 1 * DAY); // never approved

  // an old, matured, confirmed sale of 6,000 rupees with its single commission entry, written through the real ledger builder
  await db.run(
    `INSERT INTO sales (id,site_id,order_id,amount_minor,tax_minor,net_minor,currency,paid_at,hold_days,eligible_at,user_id,attribution,razorpay_payment_id,rzp_status,status,created_at)
     VALUES ('sl_old','aios','old-1',600000,0,600000,'INR',?,37,?,'us_old','click','pay_old-1','confirmed','recorded',?)`, [OLD_PAID, OLD_ELIGIBLE, OLD_PAID]);
  await db.batch(await ledgerStmts({ db, now: () => OLD_PAID }, [
    { account_id: 'us_old', kind: 'commission', amount_minor: OLD_COMMISSION, sale_id: 'sl_old', eligible_at: OLD_ELIGIBLE, ref: 'commission:sl_old:us_old', memo: 'aios order old-1' },
  ]));
  // an old payout that was already paid out
  await db.run(
    "INSERT INTO payouts (id,user_id,gross_minor,tds_bps,tds_minor,net_minor,status,requested_by_key,method,destination_masked,created_at) VALUES ('po_old','us_susp',100000,0,0,100000,'paid','k1','upi','ab***@okbank',?)",
    [OLD_PAID]);

  return {
    raw, db,
    upgrade() {
      const m7 = files.find((m) => m.name.startsWith('0007_'));
      assert.ok(m7, 'migration 0007 exists');
      apply(m7);
      return { raw, db };
    },
  };
}

/** The upgraded database with the real handler on top, genuine seeded defaults, and API keys for the two old active partners. */
async function upgraded() {
  const L = await legacy();
  const h = await mk({ realDefaults: true, dbPair: L.upgrade() });
  const key = async (id) => ({ id, key: (await createKey(h.ctx, { kind: 'user', user_id: id })).token });
  return { h, raw: L.raw, old: await key('us_old'), fresh: await key('us_fresh') };
}

let ip = 10;
const click = async (h, user, siteId) => {
  const l = await h.call('POST', '/v1/me/links', { key: user.key, body: { site_id: siteId, path: '/' } });
  assert.equal(l.status, 201, JSON.stringify(l.data));
  const res = await handle(h.ctx, new Request(`https://pc.test${l.data.url}`, { headers: { 'cf-connecting-ip': `198.51.100.${ip += 1}` } }));
  return new URL(res.headers.get('location')).searchParams.get('pc');
};
const entries = (h, userId) => h.db.all('SELECT kind, amount_minor, eligible_at, ref FROM ledger WHERE account_id=? ORDER BY seq', [userId]);

// ------------------------------------------------------------------ what the migration does to the rows that exist

test('0007 on a database with rows keeps every row, fills the new columns sensibly and leaves the money chain untouched', async () => {
  const L = await legacy();
  const tables = ['sites', 'users', 'sales', 'ledger', 'payouts', 'tenant_profile', 'api_keys'];
  const count = (t) => L.raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  const before = Object.fromEntries(tables.map((t) => [t, count(t)]));
  const ledgerBefore = await L.db.all('SELECT seq,id,ts,account_id,kind,amount_minor,sale_id,eligible_at,ref,memo,prev_hash,hash FROM ledger ORDER BY seq');
  assert.equal(before.sales, 1);
  assert.equal(before.ledger, 1);

  L.upgrade();
  assert.deepEqual(Object.fromEntries(tables.map((t) => [t, count(t)])), before, 'no row was added or lost');
  assert.deepEqual(await L.db.all('SELECT seq,id,ts,account_id,kind,amount_minor,sale_id,eligible_at,ref,memo,prev_hash,hash FROM ledger ORDER BY seq'), ledgerBefore, 'the money ledger is byte for byte what it was');

  const sites = Object.fromEntries((await L.db.all('SELECT id, early_release_bps FROM sites')).map((r) => [r.id, r.early_release_bps]));
  assert.deepEqual(sites, { aios: 8000, tam: 0 }, 'a product with a money-back window gets the 80/20 split, one without gets none');
  const users = Object.fromEntries((await L.db.all('SELECT id, approved_at, created_at FROM users')).map((r) => [r.id, r]));
  for (const id of ['us_old', 'us_fresh', 'us_susp']) assert.equal(users[id].approved_at, users[id].created_at, `${id} counts as approved on the day the account was made`);
  assert.equal(users.us_wait.approved_at, null, 'a person who was never approved stays without an approval moment');
  const sale = await L.db.first('SELECT early_release_bps, early_eligible_at, eligible_at FROM sales WHERE id=?', ['sl_old']);
  assert.deepEqual(sale, { early_release_bps: 0, early_eligible_at: null, eligible_at: OLD_ELIGIBLE }, 'the old sale keeps its single release date');
  assert.equal((await L.db.first('SELECT pay_on FROM payouts WHERE id=?', ['po_old'])).pay_on, null);
  assert.equal((await L.db.first('SELECT payee_name FROM tenant_profile')).payee_name, 'IT Services by Rajat Agarwal');
  assert.equal((await L.db.first('SELECT name FROM _migrations WHERE name LIKE ?', ['0007_%'])).name, '0007_money_recheck.sql');
});

test('on the upgraded database the chains verify, the brand carries the payee record, and the seeded sites sit beside the old ones', async () => {
  const { h } = await upgraded();
  assert.equal((await verifyLedger(h.db)).ok, true);
  assert.equal((await verifyAudit(h.db)).ok, true);
  assert.equal((await h.call('GET', '/v1/public/brand')).data.payee_name, 'IT Services by Rajat Agarwal');
  const by = Object.fromEntries((await h.call('GET', '/v1/admin/sites', { key: h.owner })).data.sites.map((s) => [s.id, s]));
  assert.equal(Object.keys(by).length, 9, 'the other seven products were seeded next to the two old ones');
  assert.equal(by.aios.early_release_bps, 8000, 'the old Veridian AI OS row got the split from the migration');
  assert.equal(by.dpdp.early_release_bps, 8000);
  assert.equal(by.tam.early_release_bps, 0);
  assert.equal(by.tam.commission_bps, 1200, 'the old rate card of an existing product is left exactly as the owner had it');
});

// ------------------------------------------------------------------ old and new side by side

test('an old sale keeps its one-piece release while a new sale of the same product splits 80/20, and one payout carries the old entry', async () => {
  const { h, raw, old } = await upgraded();
  const ck = await click(h, old, 'aios');
  const sale = await h.sale('aios', { order_id: 'new-1', click_id: ck, amount_minor: 100000 });
  assert.equal(sale.status, 201, JSON.stringify(sale.data));
  assert.equal(sale.data.commission_minor, 10000);
  assert.equal(sale.data.early_release_bps, 8000);
  assert.equal(sale.data.early_eligible_at, T0 + 7 * DAY);
  assert.equal(sale.data.eligible_at, T0 + 37 * DAY);
  assert.equal(sale.data.bonus_minor, 0, 'approved 90 days ago: the joining bonus window is long closed');

  const e = await entries(h, 'us_old');
  assert.deepEqual(e.map((x) => [x.kind, x.amount_minor, x.eligible_at]), [
    ['commission', OLD_COMMISSION, OLD_ELIGIBLE],
    ['commission', 8000, T0 + 7 * DAY],
    ['commission', 2000, T0 + 37 * DAY],
  ], 'old entry first, then the new two parts');
  assert.match(e[2].ref, /^commission-final:/);

  const b = (await h.call('GET', '/v1/me/balance', { key: old.key })).data;
  assert.equal(b.available_minor, OLD_COMMISSION, 'only the old, matured entry is payable today');
  assert.equal(b.pending_minor, 10000, 'both parts of the new sale are still waiting');
  assert.equal(b.ledger_total_minor, b.available_minor + b.pending_minor);

  await h.verifyUser(old);
  const po = await h.call('POST', '/v1/me/payouts', { key: old.key });
  assert.equal(po.status, 201, JSON.stringify(po.data));
  assert.equal(po.data.gross_minor, OLD_COMMISSION, 'the payout is exactly the old entry');
  assert.equal(po.data.pay_on, nextPayDay(T0, [15, 31]), 'a payout asked after the migration carries its pay day');
  const early = await h.call('POST', `/v1/admin/payouts/${po.data.id}/approve`, { key: h.owner });
  assert.equal(early.status, 409);
  assert.equal(early.data.error.code, 'before_pay_day');

  // a payout that was already waiting before the migration has no pay day: it is approved exactly as before
  raw.prepare('UPDATE payouts SET pay_on = NULL WHERE id = ?').run(po.data.id);
  const ok = await h.call('POST', `/v1/admin/payouts/${po.data.id}/approve`, { key: h.owner });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.ok(['processing', 'paid'].includes(ok.data.status), ok.data.status);
  assert.equal((await verifyLedger(h.db)).ok, true);
  assert.equal((await verifyAudit(h.db)).ok, true);
});

test('refunds on the upgraded database: the old sale voids its one entry, the new sale voids both parts, nothing is left over', async () => {
  const { h, old } = await upgraded();
  const ck = await click(h, old, 'aios');
  assert.equal((await h.sale('aios', { order_id: 'new-1', click_id: ck, amount_minor: 100000 })).status, 201);

  const r1 = await h.signed('aios', 'POST', '/v1/integration/refunds', { order_id: 'old-1', reason: 'test refund of the old sale' });
  assert.equal(r1.status, 200, JSON.stringify(r1.data));
  let e = await entries(h, 'us_old');
  assert.deepEqual(e.filter((x) => x.kind === 'void').map((x) => x.amount_minor), [-OLD_COMMISSION], 'one void for the one old entry');
  assert.deepEqual(await h.db.first('SELECT status, refund_after_payout FROM sales WHERE id=?', ['sl_old']), { status: 'refunded', refund_after_payout: 0 });

  const r2 = await h.signed('aios', 'POST', '/v1/integration/refunds', { order_id: 'new-1', reason: 'test refund of the new sale' });
  assert.equal(r2.status, 200, JSON.stringify(r2.data));
  e = await entries(h, 'us_old');
  assert.deepEqual(e.filter((x) => x.kind === 'void').map((x) => x.amount_minor), [-OLD_COMMISSION, -8000, -2000]);
  assert.equal(e.reduce((a, x) => a + x.amount_minor, 0), 0, 'the partner is left with exactly nothing');
  const b = (await h.call('GET', '/v1/me/balance', { key: old.key })).data;
  assert.deepEqual([b.available_minor, b.pending_minor, b.ledger_total_minor], [0, 0, 0]);
  assert.equal((await verifyLedger(h.db)).ok, true);
});

// ------------------------------------------------------------------ the joining bonus follows the back-filled approval moment

test('people approved before the migration count from their sign-up day: no surprise bonus for the old partner, the bonus still arrives for the recent one', async () => {
  const { h, old, fresh } = await upgraded();
  const ckOld = await click(h, old, 'aios');
  const ckFresh = await click(h, fresh, 'aios');
  const a = await h.sale('aios', { order_id: 'bonus-old', click_id: ckOld, amount_minor: 100000 });
  const b = await h.sale('aios', { order_id: 'bonus-fresh', click_id: ckFresh, amount_minor: 100000 });
  assert.equal(a.data.bonus_minor, 0);
  assert.equal(b.data.bonus_minor, 50000, 'approved 5 days before: 500 rupees with the first sale');
  assert.ok((await entries(h, 'us_fresh')).some((x) => x.ref === 'bonus:us_fresh' && x.amount_minor === 50000));
  assert.ok(!(await entries(h, 'us_old')).some((x) => x.ref.startsWith('bonus:')));
  assert.equal((await h.call('GET', '/v1/me/summary', { key: fresh.key })).data.joining_bonus.state, 'earned');
  assert.equal((await h.call('GET', '/v1/me/summary', { key: old.key })).data.joining_bonus.state, 'gone');
});
