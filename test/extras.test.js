import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mk, DAY } from './helpers.js';
import { handle } from '../src/app.js';

const click = async (h, user, siteId = 'mom') => {
  const l = await h.call('POST', '/v1/me/links', { key: user.key, body: { site_id: siteId, path: '/' } });
  const res = await handle(h.ctx, new Request(`https://pc.test${l.data.url}`));
  return new URL(res.headers.get('location')).searchParams.get('pc');
};

async function funded(h, name) {
  const p = await h.staff('partner', name);
  await h.verifyUser(p);
  await h.sale('mom', { order_id: `o-${name}`, click_id: await click(h, p), amount_minor: 1000000 });
  h.advance(38 * DAY);
  return p;
}

test('deal registration: a registered prospect is protected from a later click by another partner, within the window only', async () => {
  const h = await mk();
  const a = await h.staff('partner', 'Registrar');
  const b = await h.staff('partner', 'Clicker');
  const reg = await h.call('POST', '/v1/me/prospects', { key: a.key, body: { site_id: 'mom', customer_email: 'Prospect@Example.test' } });
  assert.equal(reg.status, 201);
  assert.equal(reg.data.protected_until, h.clock.t + 14 * DAY);
  const dup = await h.call('POST', '/v1/me/prospects', { key: b.key, body: { site_id: 'mom', customer_email: 'prospect@example.test' } });
  assert.equal(dup.data.error, undefined, 'no leak: a held e-mail is answered like a fresh one');
  assert.equal((await h.ctx.db.first("SELECT COUNT(*) AS n FROM leads WHERE user_id=? AND source='registered'", [b.id])).n, 0, 'but nothing was registered for the second partner');
  assert.equal((await h.call('POST', '/v1/me/prospects', { key: a.key, body: { site_id: 'mom', customer_email: 'prospect@example.test' } })).data.already_yours, true);
  assert.equal((await h.call('POST', '/v1/me/prospects', { key: a.key, body: { site_id: 'mom', customer_email: a.email } })).data.error.code, 'self_referral');
  const ckB = await click(h, b);
  h.advance(10 * DAY);
  const s1 = await h.sale('mom', { order_id: 'p1', click_id: ckB, customer_email: 'prospect@example.test' });
  assert.equal(s1.data.attribution, 'prospect');
  assert.equal(s1.data.partner_handle, a.handle);
  h.advance(10 * DAY); // 20 days after registration: protection (14d) is over, the click (30d window) wins
  const s2 = await h.sale('mom', { order_id: 'p2', click_id: ckB, customer_email: 'prospect@example.test' });
  assert.equal(s2.data.attribution, 'click');
  assert.equal(s2.data.partner_handle, b.handle);
  assert.equal((await h.call('GET', '/v1/me/prospects', { key: a.key })).data.prospects.length, 1);
  const r = (await h.call('POST', '/v1/register', { body: { role: 'refer', name: 'Rita' } })).data;
  assert.equal((await h.call('POST', '/v1/me/prospects', { key: r.api_key, body: { site_id: 'mom', customer_email: 'x@example.test' } })).status, 403);
});

test('partners outside India: payout is recorded, the API provider is NOT called, owner marks it paid by hand with a reference', async () => {
  const h = await mk();
  const w = await h.call('POST', '/v1/admin/users', { key: h.owner, body: { role: 'partner', name: 'Wei', email: 'wei@example.test', phone: '+6598765432', country: 'SG' } });
  const wk = { id: w.data.user.id, key: w.data.api_key };
  await h.call('POST', '/v1/me/email/send-code', { key: wk.key });
  await h.call('POST', '/v1/me/email/verify', { key: wk.key, body: { code: h.mailer.outbox.at(-1)._code } });
  await h.call('PUT', '/v1/me/kyc', { key: wk.key, body: { tax_id: 'S1234567A', bank_account: '0012345678', bank_ifsc_swift: 'DBSSSGSG', bank_name: 'DBS' } });
  await h.call('POST', `/v1/admin/users/${wk.id}/kyc/review`, { key: h.owner, body: { approve: true } });
  await h.call('POST', '/v1/me/codes', { key: wk.key, body: { site_id: 'mom', discount_bps: 100, code: 'WEI1' } });
  await h.sale('mom', { order_id: 'sg1', code: 'WEI1', amount_minor: 1000000 });
  h.advance(38 * DAY);
  const po = await h.call('POST', '/v1/me/payouts', { key: wk.key });
  assert.equal(po.data.method, 'bank');
  assert.equal(po.data.tds_minor, 0, 'no India TDS on a non-India payee (CA to confirm treaty/withholding)');
  const ap = await h.call('POST', `/v1/admin/payouts/${po.data.id}/approve`, { key: h.owner });
  assert.equal(ap.data.status, 'processing');
  assert.equal(ap.data.provider, 'manual');
  assert.equal(h.payouts.calls.length, 0);
  assert.equal((await h.call('POST', `/v1/admin/payouts/${po.data.id}/mark-paid`, { key: h.ai, body: { reference: 'WIRE-1' } })).status, 403);
  assert.equal((await h.call('POST', `/v1/admin/payouts/${po.data.id}/mark-paid`, { key: h.owner, body: {} })).status, 422);
  const done = await h.call('POST', `/v1/admin/payouts/${po.data.id}/mark-paid`, { key: h.owner, body: { reference: 'WIRE-1' } });
  assert.equal(done.data.status, 'paid');
  assert.equal(done.data.paid_ref, 'WIRE-1');
  // an Indian provider payout cannot be marked paid by hand
  const p2 = await funded(h, 'Indy');
  const po2 = (await h.call('POST', '/v1/me/payouts', { key: p2.key })).data;
  await h.call('POST', `/v1/admin/payouts/${po2.id}/approve`, { key: h.owner });
  assert.equal((await h.call('POST', `/v1/admin/payouts/${po2.id}/mark-paid`, { key: h.owner, body: { reference: 'X' } })).data.error.code, 'not_manual');
});

test('key minting is strict: user/site keys only hold their own scope; bad rate limits and unknown kinds refused', async () => {
  const h = await mk();
  const p = await h.staff('partner', 'KeyUser');
  for (const body of [{ kind: 'user', user_id: p.id, scopes: ['*'] }, { kind: 'site', site_id: 'mom', scopes: ['admin.read'] }, { kind: 'ai', rate_per_min: 0 }, { kind: 'root' }, { kind: 'site' }]) {
    assert.equal((await h.call('POST', '/v1/admin/keys', { key: h.owner, body })).status, 422, JSON.stringify(body));
  }
  assert.equal((await h.call('POST', '/v1/admin/keys', { key: h.owner, body: { kind: 'user', user_id: p.id } })).status, 201);
});

test('the signing recipe in docs/INTEGRATION.md works with plain node:crypto, and sites-sql output seeds the nine sites', async () => {
  const { createHmac } = await import('node:crypto');
  const { siteSecret } = await import('../src/auth.js');
  const { execFileSync } = await import('node:child_process');
  const { DatabaseSync } = await import('node:sqlite');
  const { migrationFiles } = await import('../scripts/lib.mjs');
  const h = await mk();
  const site = await h.db.first("SELECT * FROM sites WHERE id='mom'");
  const secret = await siteSecret(h.ctx, site);
  const body = JSON.stringify({ order_id: 'MOM-10432', amount_minor: 49900, tax_minor: 7612 });
  const ts = String(h.clock.t);
  const sig = createHmac('sha256', secret).update(`${ts}.POST./v1/integration/sales.${body}`).digest('hex');
  const r = await h.call('POST', '/v1/integration/sales', { rawBody: body, headers: { 'x-pc-site': 'mom', 'x-pc-timestamp': ts, 'x-pc-signature': sig } });
  assert.equal(r.status, 201);
  assert.equal(r.data.net_minor, 42288);
  const sql = execFileSync(process.execPath, ['scripts/sites-sql.mjs'], { encoding: 'utf8' });
  const raw = new DatabaseSync(':memory:');
  for (const m of migrationFiles()) raw.exec(m.sql);
  raw.exec(sql);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM sites').get().n, 9);
});
