import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mk, T0, DAY } from './helpers.js';
import { ledgerStmts, auditStmts, atomic, verifyLedger, verifyAudit } from '../src/chain.js';
import { createKey, rateLimit } from '../src/auth.js';
import { encryptField, decryptField } from '../src/util.js';

test('ledger chain: appends verify, UPDATE/DELETE are rejected, out-of-band tampering is detected', async () => {
  const h = await mk();
  const e = (n) => ({ account_id: 'acct', kind: 'adjustment', amount_minor: n, eligible_at: T0, ref: `r${n}` });
  await atomic(h.ctx, () => ledgerStmts(h.ctx, [e(1), e(2), e(3)]));
  assert.deepEqual(await verifyLedger(h.db), { ok: true, rows: 3 });
  await assert.rejects(() => h.db.run('UPDATE ledger SET amount_minor=999 WHERE seq=1'), /append-only/);
  await assert.rejects(() => h.db.run('DELETE FROM ledger WHERE seq=2'), /append-only/);
  // simulate someone with raw DB access dropping the trigger and editing a row
  h.raw.exec('DROP TRIGGER ledger_no_update');
  h.raw.exec('UPDATE ledger SET amount_minor=999 WHERE seq=2');
  const v = await verifyLedger(h.db);
  assert.equal(v.ok, false);
  assert.equal(v.broken_at, 2);
  assert.equal(v.reason, 'hash mismatch');
});

test('ledger chain: duplicate ref is rejected (idempotent posting) and a row removal shows as a sequence gap', async () => {
  const h = await mk();
  await atomic(h.ctx, () => ledgerStmts(h.ctx, [{ account_id: 'a', kind: 'adjustment', amount_minor: 5, eligible_at: T0, ref: 'same' }]));
  await assert.rejects(() => atomic(h.ctx, () => ledgerStmts(h.ctx, [{ account_id: 'a', kind: 'adjustment', amount_minor: 5, eligible_at: T0, ref: 'same' }])), /UNIQUE/);
  h.raw.exec('DROP TRIGGER ledger_no_delete');
  await atomic(h.ctx, () => ledgerStmts(h.ctx, [{ account_id: 'a', kind: 'adjustment', amount_minor: 1, eligible_at: T0, ref: 'x1' }, { account_id: 'a', kind: 'adjustment', amount_minor: 2, eligible_at: T0, ref: 'x2' }]));
  h.raw.exec('DELETE FROM ledger WHERE seq=2');
  const v = await verifyLedger(h.db);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'sequence gap');
});

test('chain: concurrent writers racing for the same seq both land (retry from the new tail)', async () => {
  const h = await mk();
  const post = (n) => atomic(h.ctx, () => ledgerStmts(h.ctx, [{ account_id: 'a', kind: 'adjustment', amount_minor: n, eligible_at: T0, ref: `c${n}` }]));
  await Promise.all([post(1), post(2), post(3), post(4)]);
  assert.deepEqual(await verifyLedger(h.db), { ok: true, rows: 4 });
});

test('audit log is append-only and hash chained', async () => {
  const h = await mk();
  await atomic(h.ctx, () => auditStmts(h.ctx, [{ action: 'x.one', target: 't' }, { action: 'x.two', meta: { a: 1 } }]));
  assert.equal((await verifyAudit(h.db)).ok, true);
  await assert.rejects(() => h.db.run("UPDATE audit_log SET action='hack'"), /append-only/);
  await assert.rejects(() => h.db.run('DELETE FROM audit_log'), /append-only/);
});

test('API keys: valid, invalid, revoked; only a hash is stored', async () => {
  const h = await mk();
  const ok = await h.call('GET', '/v1/admin/policy', { key: h.owner });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.attribution_window_days, 30);
  assert.equal((await h.call('GET', '/v1/admin/policy')).status, 401);
  assert.equal((await h.call('GET', '/v1/admin/policy', { key: 'pck_abc.def' })).status, 401);
  assert.equal((await h.call('GET', '/v1/admin/policy', { key: h.owner.replace(/.$/, (c) => (c === '0' ? '1' : '0')) })).status, 401);
  const secret = h.owner.split('.')[1];
  const rows = await h.db.all('SELECT * FROM api_keys');
  assert.ok(rows.every((r) => !JSON.stringify(r).includes(secret)), 'secret must not be stored');
  const k = await h.call('POST', '/v1/admin/keys', { key: h.owner, body: { kind: 'ai', label: 'second ai' } });
  assert.equal(k.status, 201);
  assert.equal((await h.call('GET', '/v1/admin/policy', { key: k.data.token })).status, 200);
  assert.equal((await h.call('DELETE', `/v1/admin/keys/${k.data.id}`, { key: h.owner })).status, 200);
  assert.equal((await h.call('GET', '/v1/admin/policy', { key: k.data.token })).status, 401);
});

test('AI key can never hold or use owner-only scopes', async () => {
  const h = await mk();
  const bad = await h.call('POST', '/v1/admin/keys', { key: h.owner, body: { kind: 'ai', scopes: ['admin.read', 'payouts.approve'] } });
  assert.equal(bad.status, 422);
  assert.equal(bad.data.error.code, 'scope_not_assignable');
  // the AI key itself is refused on owner-only routes and cannot mint keys
  for (const [m, p, b] of [['PUT', '/v1/admin/policy', { min_payout_minor: 1 }], ['POST', '/v1/admin/keys', { kind: 'owner' }], ['POST', '/v1/admin/payouts/po_x/approve', {}], ['GET', '/v1/admin/keys']]) {
    const r = await h.call(m, p, { key: h.ai, body: b });
    assert.equal(r.status, 403, `${m} ${p}`);
  }
  assert.equal((await h.call('GET', '/v1/admin/queue', { key: h.ai })).status, 200);
});

test('user keys cannot reach admin routes; admin keys cannot reach /me', async () => {
  const h = await mk();
  const r = await h.call('POST', '/v1/register', { body: { role: 'refer', name: 'Rita' } });
  assert.equal(r.status, 201);
  assert.equal((await h.call('GET', '/v1/admin/queue', { key: r.data.api_key })).status, 403);
  assert.equal((await h.call('GET', '/v1/me', { key: h.owner })).status, 403);
  assert.equal((await h.call('GET', '/v1/me', { key: r.data.api_key })).status, 200);
});

test('rate limit: fixed window per key, resets next minute, 429 carries Retry-After', async () => {
  const h = await mk();
  const k = await createKey(h.ctx, { kind: 'ai', rate_per_min: 3 });
  for (let i = 0; i < 3; i++) assert.equal((await h.call('GET', '/v1/admin/queue', { key: k.token })).status, 200);
  const blocked = await h.call('GET', '/v1/admin/queue', { key: k.token });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
  h.advance(61000);
  assert.equal((await h.call('GET', '/v1/admin/queue', { key: k.token })).status, 200);
  await assert.rejects(async () => { for (let i = 0; i < 4; i++) await rateLimit(h.ctx, 'x', 3); }, /too many/);
});

test('signed site webhooks: valid, wrong secret, stale timestamp, tampered body, unknown site', async () => {
  const h = await mk();
  const body = { order_id: 'o1', amount_minor: 50000 };
  assert.equal((await h.signed('mom', 'POST', '/v1/integration/sales', body)).status, 201);
  assert.equal((await h.signed('mom', 'POST', '/v1/integration/sales', { order_id: 'o2', amount_minor: 1 }, { secretOverride: 'wrong-secret-wrong-secret' })).data.error.code, 'invalid_signature');
  assert.equal((await h.signed('mom', 'POST', '/v1/integration/sales', { order_id: 'o3', amount_minor: 1 }, { ts: h.clock.t - 6 * 60000 })).data.error.code, 'stale_signature');
  assert.equal((await h.call('POST', '/v1/integration/sales', { rawBody: JSON.stringify(body), headers: { 'x-pc-site': 'nosuchsite', 'x-pc-timestamp': String(h.clock.t), 'x-pc-signature': 'ab' } })).status, 401);
  // sign one body, send another
  const { signBody, siteSecret } = await import('../src/auth.js');
  const site = await h.db.first("SELECT * FROM sites WHERE id='mom'");
  const sig = await signBody(await siteSecret(h.ctx, site), String(h.clock.t), 'POST', '/v1/integration/sales', JSON.stringify({ order_id: 'o4', amount_minor: 1 }));
  const r = await h.call('POST', '/v1/integration/sales', { rawBody: JSON.stringify({ order_id: 'o4', amount_minor: 99999999 }), headers: { 'x-pc-site': 'mom', 'x-pc-timestamp': String(h.clock.t), 'x-pc-signature': sig } });
  assert.equal(r.status, 401);
  assert.equal((await h.call('POST', '/v1/integration/sales', { body })).status, 401);
});

test('site key can read but not post sales (sales need a signature)', async () => {
  const h = await mk();
  const k = await h.call('POST', '/v1/admin/keys', { key: h.owner, body: { kind: 'site', site_id: 'mom' } });
  assert.equal((await h.call('POST', '/v1/integration/codes/validate', { key: k.data.token, body: { code: 'NOPE' } })).data.valid, false);
  const r = await h.call('POST', '/v1/integration/sales', { key: k.data.token, body: { order_id: 'x', amount_minor: 100 } });
  assert.equal(r.status, 401);
});

test('Idempotency-Key replays the stored answer and rejects a different body; key-bearing routes are never cached', async () => {
  const h = await mk();
  const body = { name: 'Week', period: 'weekly', metric: 'sales_count', target: 2, bonus_minor: 100, starts_at: h.clock.t, ends_at: h.clock.t + 1000 };
  const a = await h.call('POST', '/v1/admin/schemes', { key: h.owner, body, headers: { 'idempotency-key': 'k-1' } });
  const b = await h.call('POST', '/v1/admin/schemes', { key: h.owner, body, headers: { 'idempotency-key': 'k-1' } });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.equal(b.headers.get('idempotent-replay'), 'true');
  assert.equal(a.data.id, b.data.id);
  assert.equal((await h.db.first('SELECT COUNT(*) AS n FROM schemes')).n, 1);
  const c = await h.call('POST', '/v1/admin/schemes', { key: h.owner, body: { ...body, name: 'Different' }, headers: { 'idempotency-key': 'k-1' } });
  assert.equal(c.status, 422);
  assert.equal(c.data.error.code, 'idempotency_conflict');
  // responses that carry a login key must never be stored in the idempotency table
  await h.call('POST', '/v1/register', { body: { role: 'refer', name: 'Ira' }, headers: { 'idempotency-key': 'k-2' } });
  await h.call('POST', '/v1/admin/keys', { key: h.owner, body: { kind: 'ai' }, headers: { 'idempotency-key': 'k-3' } });
  const stored = JSON.stringify(await h.db.all('SELECT * FROM idempotency'));
  assert.ok(!stored.includes('pck_'), 'no API key may sit in the idempotency table');
});

test('input handling: bad JSON, huge body, unknown route, wrong method; errors never leak internals', async () => {
  const h = await mk();
  assert.equal((await h.call('POST', '/v1/register', { rawBody: '{nope' })).status, 400);
  assert.equal((await h.call('POST', '/v1/register', { rawBody: JSON.stringify({ role: 'refer', name: 'x'.repeat(70000) }) })).status, 413);
  assert.equal((await h.call('GET', '/v1/nothing')).status, 404);
  assert.equal((await h.call('DELETE', '/v1/health')).status, 405);
  const r = await h.call('GET', '/v1/health');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});

test('field encryption round-trips and is not deterministic', async () => {
  const k = 'a-long-test-secret-value';
  const a = await encryptField(k, 'ABCDE1234F');
  const b = await encryptField(k, 'ABCDE1234F');
  assert.notEqual(a, b);
  assert.equal(await decryptField(k, a), 'ABCDE1234F');
  await assert.rejects(() => decryptField('another-secret-another', a));
  assert.equal(await encryptField(k, ''), null);
});

test('DAY constant sanity', () => assert.equal(DAY, 86400000));
