// Cloudflare-facing pieces tested without Cloudflare: the D1 adapter against a faithful fake, the Pages Function entry,
// migration replay, and concurrency on the money paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openDb, seedSites, migrationFiles } from '../scripts/lib.mjs';
import { onRequest } from '../functions/[[path]].js';
import { d1Db } from '../src/db.js';
import { createKey, siteSecret, signBody } from '../src/auth.js';
import { makeCtx } from '../src/ctx.js';
import { verifyLedger, verifyAudit } from '../src/chain.js';
import { ENV, mk } from './helpers.js';

/** Minimal D1 look-alike: prepare().bind().all()/first()/run() and batch() as one transaction, over node:sqlite. */
function fakeD1(raw) {
  // Real D1 rejects a statement with more than 100 bound values; node:sqlite would accept ~32k. Model the stricter limit.
  const mkStmt = (sql, params = []) => ({
    sql, params,
    bind: (...p) => { if (p.length > 100) throw new Error('D1_ERROR: too many SQL variables (limit 100)'); return mkStmt(sql, p); },
    all: async () => ({ results: raw.prepare(sql).all(...params).map((r) => ({ ...r })) }),
    first: async () => { const r = raw.prepare(sql).get(...params); return r ? { ...r } : null; },
    run: async () => { const r = raw.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
  });
  return {
    prepare: (sql) => mkStmt(sql),
    batch: async (stmts) => {
      raw.exec('BEGIN');
      try { for (const s of stmts) raw.prepare(s.sql).run(...s.params); raw.exec('COMMIT'); } catch (e) { raw.exec('ROLLBACK'); throw e; }
      return [];
    },
  };
}

test('Pages Function on the D1 adapter: register, link, signed sale, owner approval, chains intact', async () => {
  const { raw, db } = openDb();
  await seedSites(db);
  await db.run('UPDATE sites SET active=1, host_confirmed=1');
  const d1 = fakeD1(raw);
  const env = { DB: d1, ...ENV };
  const seedCtx = makeCtx({ db: d1Db(d1), env });
  const owner = await createKey(seedCtx, { kind: 'owner' });
  const call = async (method, path, { body, key, headers } = {}) => {
    const req = new Request(`https://pc.test${path}`, { method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const res = await onRequest({ request: req, env });
    const t = await res.text();
    return { status: res.status, data: t ? JSON.parse(t) : null, headers: res.headers };
  };
  assert.equal((await call('GET', '/v1/health')).status, 200);
  const staff = await call('POST', '/v1/admin/users', { key: owner.token, body: { role: 'partner', name: 'D One', email: 'done@example.test', phone: '9876543210' } });
  assert.equal(staff.status, 201);
  const link = await call('POST', '/v1/me/links', { key: staff.data.api_key, body: { site_id: 'mom', path: '/' } });
  const go = await onRequest({ request: new Request(`https://pc.test${link.data.url}`, { headers: { 'cf-connecting-ip': '192.0.2.1' } }), env });
  assert.equal(go.status, 302);
  const pc = new URL(go.headers.get('location')).searchParams.get('pc');
  const site = await db.first("SELECT * FROM sites WHERE id='mom'");
  const body = JSON.stringify({ order_id: 'd1-1', amount_minor: 100000, click_id: pc });
  const ts = String(Date.now());
  const sig = await signBody(await siteSecret(seedCtx, site), ts, body);
  const sale = await onRequest({ request: new Request('https://pc.test/v1/integration/sales', { method: 'POST', body, headers: { 'x-pc-site': 'mom', 'x-pc-timestamp': ts, 'x-pc-signature': sig } }), env });
  const sj = await sale.json();
  assert.equal(sale.status, 201);
  assert.equal(sj.commission_minor, 15000);
  assert.equal((await verifyLedger(db)).ok, true);
  assert.equal((await verifyAudit(db)).ok, true);
  // a failing batch rolls back everything (duplicate ledger ref inside one batch)
  await assert.rejects(() => d1Db(d1).batch([
    { sql: "INSERT INTO policy (key,value,updated_at) VALUES ('zz','1',1)", params: [] },
    { sql: "INSERT INTO policy (key,value,updated_at) VALUES ('zz','2',1)", params: [] },
  ]), /UNIQUE|constraint/);
  assert.equal((await db.first("SELECT COUNT(*) AS n FROM policy WHERE key='zz'")).n, 0, 'batch is all-or-nothing');
});

test('Pages Function fails closed when secrets are missing (never runs with an empty pepper or signing master)', async () => {
  const { raw, db } = openDb();
  await seedSites(db);
  const env = { DB: fakeD1(raw) }; // no secrets at all
  const res = await onRequest({ request: new Request('https://pc.test/v1/register', { method: 'POST', body: JSON.stringify({ role: 'partner', name: 'Zed', email: 'zed@example.test', phone: '9876543210' }) }), env });
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error.code, 'server_misconfigured');
  assert.equal((await db.first('SELECT COUNT(*) AS n FROM users')).n, 0);
});

test('migrations: apply cleanly to an empty database, in order, once; tables and append-only triggers exist', () => {
  const files = migrationFiles();
  assert.deepEqual(files.map((f) => f.name), ['0001_init.sql', '0002_payout_items_schemes.sql', '0003_hardening.sql']);
  const raw = new DatabaseSync(':memory:');
  for (const f of files) raw.exec(f.sql);
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const t of ['sites', 'users', 'user_kyc', 'api_keys', 'links', 'codes', 'clicks', 'leads', 'sales', 'razorpay_events', 'payouts', 'payout_items', 'ledger', 'audit_log', 'policy', 'idempotency', 'rate_limits', 'email_codes', 'schemes', 'chain_checkpoints']) {
    assert.ok(tables.includes(t), `table ${t}`);
  }
  const triggers = raw.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map((r) => r.name).sort();
  assert.deepEqual(triggers, ['audit_no_delete', 'audit_no_update', 'ledger_no_delete', 'ledger_no_update']);
  // re-opening an already-migrated file database does not re-run migrations
  const again = openDb();
  assert.ok(again.raw.prepare('SELECT COUNT(*) AS n FROM _migrations').get().n === 3);
});

test('schema constraints: one open payout per user, unique order per site, sales amounts and roles checked by the database itself', async () => {
  const h = await mk();
  const p = await h.staff('partner', 'Cons');
  const ins = (st) => h.db.run(`INSERT INTO payouts (id,user_id,gross_minor,status,requested_by_key,created_at) VALUES (?,?,?,?,?,?)`, [`po_${Math.random()}`, p.id, 1, st, 'k', 1]);
  await ins('pending_approval');
  await assert.rejects(() => ins('approved'), /UNIQUE/);
  await ins('paid');
  await ins('rejected');
  await assert.rejects(() => h.db.run("INSERT INTO users (id,role,status,created_at) VALUES ('x','godmode','active',1)"), /CHECK/);
  await assert.rejects(() => h.db.run("INSERT INTO ledger (seq,id,ts,account_id,kind,amount_minor,eligible_at,ref,prev_hash,hash) VALUES (99,'a',1,'a','bogus',1,1,'r','p','h')"), /CHECK/);
});

test('concurrency: the same sale delivered 6 times at once creates one sale and one set of ledger entries', async () => {
  const h = await mk();
  const p = await h.staff('partner', 'Racer');
  await h.call('POST', '/v1/me/codes', { key: p.key, body: { site_id: 'mom', discount_bps: 500, code: 'RACE5', max_uses: 10 } });
  const send = () => h.signed('mom', 'POST', '/v1/integration/sales', { order_id: 'race-1', amount_minor: 100000, code: 'RACE5' });
  const rs = await Promise.all([1, 2, 3, 4, 5, 6].map(send));
  assert.ok(rs.every((r) => r.status === 200 || r.status === 201), JSON.stringify(rs.map((r) => r.status)));
  assert.equal(rs.filter((r) => r.status === 201).length, 1);
  assert.equal((await h.db.first('SELECT COUNT(*) AS n FROM sales')).n, 1);
  assert.equal((await h.db.first("SELECT COUNT(*) AS n FROM ledger WHERE kind='commission'")).n, 1);
  assert.equal((await h.db.first("SELECT used_count FROM codes WHERE code='RACE5'")).used_count, 1);
  assert.equal((await verifyLedger(h.db)).ok, true);
});

test('concurrency: many different sales at once all land and the chains stay valid', async () => {
  const h = await mk();
  const p = await h.staff('partner', 'Burst');
  await h.call('POST', '/v1/me/codes', { key: p.key, body: { site_id: 'mom', discount_bps: 500, code: 'BURST5', max_uses: 50 } });
  const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => h.signed('mom', 'POST', '/v1/integration/sales', { order_id: `b${i}`, amount_minor: 100000, code: 'BURST5' })));
  assert.ok(rs.every((r) => r.status === 201), JSON.stringify(rs.map((r) => r.status)));
  assert.equal((await h.db.first("SELECT COUNT(*) AS n FROM ledger WHERE kind='commission'")).n, 12);
  assert.deepEqual(await verifyLedger(h.db), { ok: true, rows: 12 });
  assert.equal((await verifyAudit(h.db)).ok, true);
});

test('concurrency: two simultaneous payout requests reserve the balance once', async () => {
  const h = await mk();
  const p = await h.staff('partner', 'Twin');
  await h.verifyUser(p);
  await h.call('POST', '/v1/me/codes', { key: p.key, body: { site_id: 'mom', discount_bps: 500, code: 'TWIN5', max_uses: 5 } });
  await h.sale('mom', { order_id: 'tw1', code: 'TWIN5', amount_minor: 1000000 });
  h.advance(38 * 86400000);
  const rs = await Promise.all([h.call('POST', '/v1/me/payouts', { key: p.key }), h.call('POST', '/v1/me/payouts', { key: p.key })]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409]);
  assert.equal((await h.db.first("SELECT COUNT(*) AS n FROM ledger WHERE kind='payout_reserve'")).n, 1);
  const b = (await h.call('GET', '/v1/me/balance', { key: p.key })).data;
  assert.equal(b.ledger_total_minor, b.available_minor + b.pending_minor);
});
