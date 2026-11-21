import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mk, DAY } from './helpers.js';

test('Refer and Earn: register with no e-mail, active at once, can create a link, cannot create a code', async () => {
  const h = await mk();
  const r = await h.call('POST', '/v1/register', { body: { consent: true, role: 'refer', name: 'Rita Refer' } });
  assert.equal(r.status, 201);
  assert.equal(r.data.user.status, 'active');
  assert.equal(r.data.user.email_masked, null);
  const key = r.data.api_key;
  const link = await h.call('POST', '/v1/me/links', { key, body: { site_id: 'mom', path: '/pricing' } });
  assert.equal(link.status, 201);
  assert.match(link.data.url, /^\/r\/[a-z0-9]{8}$/);
  const code = await h.call('POST', '/v1/me/codes', { key, body: { site_id: 'mom', discount_bps: 500 } });
  assert.equal(code.status, 403);
});

test('Growth Partner registration: contact details mandatory, duplicate e-mail refused, starts pending, owner approval needed', async () => {
  const h = await mk();
  const base = { role: 'partner', name: 'Imran', email: 'imran@example.test', phone: '+91 98765 43210' };
  assert.equal((await h.call('POST', '/v1/register', { body: { consent: true, ...base, email: undefined } })).status, 422);
  assert.equal((await h.call('POST', '/v1/register', { body: { consent: true, ...base, phone: '12' } })).status, 422);
  assert.equal((await h.call('POST', '/v1/register', { body: { consent: true, ...base, email: 'not-an-email' } })).status, 422);
  const ok = await h.call('POST', '/v1/register', { body: { consent: true, ...base } });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.user.status, 'pending');
  assert.equal(ok.data.user.email_masked, 'i***@example.test');
  assert.ok(!JSON.stringify(ok.data).includes('imran@example.test'), 'raw e-mail never echoed');
  assert.equal((await h.call('POST', '/v1/register', { body: { consent: true, ...base, email: 'IMRAN@example.test' } })).status, 409);
  // pending partner cannot make links yet
  assert.equal((await h.call('POST', '/v1/me/links', { key: ok.data.api_key, body: { site_id: 'mom' } })).status, 403);
  // AI cannot approve; owner can
  const id = ok.data.user.id;
  assert.equal((await h.call('POST', `/v1/admin/users/${id}/approve`, { key: h.ai })).status, 403);
  assert.equal((await h.call('POST', `/v1/admin/users/${id}/approve`, { key: h.owner })).data.status, 'active');
  assert.equal((await h.call('POST', '/v1/me/links', { key: ok.data.api_key, body: { site_id: 'mom' } })).status, 201);
  // raw e-mail is not stored in clear anywhere except the user's own contact column; the lookup uses a keyed hash
  const row = await h.db.first('SELECT email_hash FROM users WHERE id=?', [id]);
  assert.match(row.email_hash, /^[0-9a-f]{64}$/);
});

test('hierarchy rules: manager > leader > exec > partner; invalid reporting lines refused; sponsor handle works; team tree', async () => {
  const h = await mk();
  const m = await h.staff('manager', 'Anita');
  const l = await h.staff('leader', 'Ravi', m);
  const e = await h.staff('exec', 'Sonal', l);
  const p = await h.staff('partner', 'Imran', e);
  const bad = await h.call('POST', '/v1/admin/users', { key: h.owner, body: { role: 'manager', name: 'X', email: 'x@example.test', phone: '9876543210', parent_id: l.id } });
  assert.equal(bad.data.error.code, 'invalid_parent');
  const bad2 = await h.call('POST', '/v1/admin/users', { key: h.owner, body: { role: 'leader', name: 'Y', email: 'y@example.test', phone: '9876543210', parent_id: p.id } });
  assert.equal(bad2.status, 422);
  // partner self-registers under an exec's sponsor handle
  const reg = await h.call('POST', '/v1/register', { body: { consent: true, role: 'partner', name: 'Julie', email: 'julie@example.test', phone: '9876500000', sponsor: e.handle } });
  assert.equal(reg.status, 201);
  assert.equal((await h.call('GET', '/v1/me', { key: reg.data.api_key })).data.sponsor.handle, e.handle);
  const team = await h.call('GET', '/v1/me/team', { key: m.key });
  assert.deepEqual(team.data.members.map((x) => [x.role, x.depth]), [['leader', 1], ['exec', 2], ['partner', 3], ['partner', 3]]);
  assert.equal((await h.call('GET', '/v1/me/team', { key: p.key })).data.members.length, 0);
  assert.equal((await h.call('POST', '/v1/register', { body: { consent: true, role: 'partner', name: 'Z', email: 'z@example.test', phone: '9876500001', sponsor: 'nonexist' } })).status, 422);
});

test('AI-created staff are pending until the owner approves (AI proposes, owner approves)', async () => {
  const h = await mk();
  const r = await h.call('POST', '/v1/admin/users', { key: h.ai, body: { role: 'manager', name: 'Proposed', email: 'prop@example.test', phone: '9876543210' } });
  assert.equal(r.status, 201);
  assert.equal(r.data.user.status, 'pending');
  assert.equal(r.data.api_key, undefined);
  const q = await h.call('GET', '/v1/admin/queue', { key: h.owner });
  assert.equal(q.data.partners.length, 1);
  const audit = await h.call('GET', '/v1/admin/audit?actor_type=ai', { key: h.owner });
  assert.ok(audit.data.entries.some((x) => x.action === 'user.create' && x.key_id));
});

test('e-mail verification: wrong code, expiry, attempts cap, rate limit; success flips the flag', async () => {
  const h = await mk();
  const u = await h.staff('partner', 'Verity');
  assert.equal((await h.call('POST', '/v1/me/email/verify', { key: u.key, body: { code: '123456' } })).data.error.code, 'code_expired');
  await h.call('POST', '/v1/me/email/send-code', { key: u.key });
  const code = h.mailer.outbox.at(-1)._code;
  const wrong = code === '111111' ? '222222' : '111111';
  assert.equal((await h.call('POST', '/v1/me/email/verify', { key: u.key, body: { code: wrong } })).data.error.code, 'wrong_code');
  h.advance(16 * 60000);
  assert.equal((await h.call('POST', '/v1/me/email/verify', { key: u.key, body: { code } })).data.error.code, 'code_expired');
  await h.call('POST', '/v1/me/email/send-code', { key: u.key });
  const code2 = h.mailer.outbox.at(-1)._code;
  for (let i = 0; i < 5; i++) await h.call('POST', '/v1/me/email/verify', { key: u.key, body: { code: wrong } });
  assert.equal((await h.call('POST', '/v1/me/email/verify', { key: u.key, body: { code: code2 } })).data.error.code, 'too_many_attempts');
  await h.call('POST', '/v1/me/email/send-code', { key: u.key });
  const code3 = h.mailer.outbox.at(-1)._code;
  assert.equal((await h.call('POST', '/v1/me/email/verify', { key: u.key, body: { code: code3 } })).status, 200);
  assert.equal((await h.call('GET', '/v1/me', { key: u.key })).data.email_verified, true);
  assert.equal((await h.db.first('SELECT COUNT(*) AS n FROM email_codes')).n, 0);
});

test('e-mail codes are hashed at rest and sends are rate limited', async () => {
  const h = await mk();
  const u = await h.staff('partner', 'Spammy');
  for (let i = 0; i < 5; i++) assert.equal((await h.call('POST', '/v1/me/email/send-code', { key: u.key })).status, 200);
  assert.equal((await h.call('POST', '/v1/me/email/send-code', { key: u.key })).status, 429);
  const code = h.mailer.outbox.at(-1)._code;
  const row = await h.db.first('SELECT * FROM email_codes');
  assert.ok(!JSON.stringify(row).includes(code));
});

test('KYC: needs verified e-mail; India needs PAN+UPI; abroad needs tax id + bank; stored encrypted, shown masked; owner reviews', async () => {
  const h = await mk();
  const u = await h.staff('partner', 'Kay');
  const body = { pan: 'ABCDE1234F', upi_id: 'kay@okbank' };
  assert.equal((await h.call('PUT', '/v1/me/kyc', { key: u.key, body })).data.error.code, 'email_unverified');
  await h.verifyUser(u, body);
  const view = await h.call('GET', '/v1/me/kyc', { key: u.key });
  assert.equal(view.data.status, 'verified');
  assert.equal(view.data.pan_masked, '******234F');
  const raw = JSON.stringify(await h.db.all('SELECT * FROM user_kyc'));
  assert.ok(!raw.includes('ABCDE1234F') && !raw.includes('kay@okbank'), 'KYC values must be encrypted at rest');
  assert.equal((await h.call('PUT', '/v1/me/kyc', { key: u.key, body: { pan: 'bad', upi_id: 'kay@okbank' } })).status, 422);
  // resubmitting resets to submitted (needs a fresh review)
  assert.equal((await h.call('PUT', '/v1/me/kyc', { key: u.key, body })).data.status, 'submitted');
  assert.equal((await h.call('POST', `/v1/admin/users/${u.id}/kyc/review`, { key: h.ai, body: { approve: true } })).status, 403);
  assert.equal((await h.call('POST', `/v1/admin/users/${u.id}/kyc/review`, { key: h.owner, body: { approve: false, note: 'blurry' } })).data.status, 'rejected');
  // abroad
  const w = await h.call('POST', '/v1/admin/users', { key: h.owner, body: { role: 'partner', name: 'Wei', email: 'wei@example.test', phone: '+6598765432', country: 'SG' } });
  const wk = w.data.api_key;
  await h.call('POST', '/v1/me/email/send-code', { key: wk });
  await h.call('POST', '/v1/me/email/verify', { key: wk, body: { code: h.mailer.outbox.at(-1)._code } });
  assert.equal((await h.call('PUT', '/v1/me/kyc', { key: wk, body })).status, 422);
  const ok = await h.call('PUT', '/v1/me/kyc', { key: wk, body: { tax_id: 'S1234567A', bank_account: '0012345678', bank_ifsc_swift: 'DBSSSGSG', bank_name: 'DBS' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.tax_id_masked, '*****567A');
});

test('links: path safety (no open redirect), idempotent per user/site/path, redirect logs a click and carries ?pc=', async () => {
  const h = await mk();
  const p = await h.staff('partner', 'Linda');
  for (const bad of ['//evil.com', 'https://evil.com', '/a b', '\\evil', 'evil.com']) {
    assert.equal((await h.call('POST', '/v1/me/links', { key: p.key, body: { site_id: 'mom', path: bad } })).status, 422, bad);
  }
  assert.equal((await h.call('POST', '/v1/me/links', { key: p.key, body: { site_id: 'nope' } })).status, 404);
  const a = await h.call('POST', '/v1/me/links', { key: p.key, body: { site_id: 'mom', path: '/plans?x=1' } });
  const b = await h.call('POST', '/v1/me/links', { key: p.key, body: { site_id: 'mom', path: '/plans?x=1' } });
  assert.equal(a.data.slug, b.data.slug);
  const res = await (await import('../src/app.js')).handle(h.ctx, new Request(`https://pc.test${a.data.url}`, { headers: { 'cf-connecting-ip': '203.0.113.7' } }));
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get('location'));
  assert.equal(loc.host, 'mom.veridian-aios.com');
  assert.equal(loc.searchParams.get('x'), '1');
  assert.match(loc.searchParams.get('pc'), /^ck_[0-9a-f]{16}$/);
  const click = await h.db.first('SELECT * FROM clicks');
  assert.equal(click.user_id, p.id);
  assert.ok(!click.ip_hash.includes('203.0.113.7'), 'raw IP never stored');
  assert.equal((await h.call('GET', '/v1/me/links', { key: p.key })).data.links[0].clicks, 1);
  const missing = await (await import('../src/app.js')).handle(h.ctx, new Request('https://pc.test/r/zzzzzzzz'));
  assert.equal(missing.status, 404);
});

test('site integration: resolve a link slug; wrong site gets 404', async () => {
  const h = await mk();
  const p = await h.staff('partner', 'Rex');
  const l = await h.call('POST', '/v1/me/links', { key: p.key, body: { site_id: 'mom', path: '/' } });
  const k = (await h.call('POST', '/v1/admin/keys', { key: h.owner, body: { kind: 'site', site_id: 'mom' } })).data.token;
  const k2 = (await h.call('POST', '/v1/admin/keys', { key: h.owner, body: { kind: 'site', site_id: 'dpdp' } })).data.token;
  const r = await h.call('GET', `/v1/integration/links/${l.data.slug}`, { key: k });
  assert.equal(r.data.partner_handle, p.handle);
  assert.equal((await h.call('GET', `/v1/integration/links/${l.data.slug}`, { key: k2 })).status, 404);
});

test('codes: only where the site allows discounts, capped at the site maximum, per-user limit, unique, expiry, deactivate', async () => {
  const h = await mk();
  const p = await h.staff('partner', 'Cody');
  // aios does not allow discounts at all
  assert.equal((await h.call('POST', '/v1/me/codes', { key: p.key, body: { site_id: 'aios', discount_bps: 100 } })).data.error.code, 'discount_not_allowed');
  // mom allows up to 1000 bps
  assert.equal((await h.call('POST', '/v1/me/codes', { key: p.key, body: { site_id: 'mom', discount_bps: 1001 } })).data.error.code, 'discount_too_high');
  const c = await h.call('POST', '/v1/me/codes', { key: p.key, body: { site_id: 'mom', discount_bps: 1000, max_uses: 2, code: 'cody10' } });
  assert.equal(c.status, 201);
  assert.equal(c.data.code, 'CODY10');
  assert.equal((await h.call('POST', '/v1/me/codes', { key: p.key, body: { site_id: 'mom', discount_bps: 100, code: 'CODY10' } })).data.error.code, 'code_taken');
  assert.equal((await h.call('POST', '/v1/me/codes', { key: p.key, body: { site_id: 'mom', discount_bps: 100, code: 'bad code!' } })).status, 422);
  const k = (await h.call('POST', '/v1/admin/keys', { key: h.owner, body: { kind: 'site', site_id: 'mom' } })).data.token;
  const val = (code) => h.call('POST', '/v1/integration/codes/validate', { key: k, body: { code } });
  assert.deepEqual((await val('cody10')).data, { valid: true, code: 'CODY10', discount_bps: 1000, partner_handle: p.handle, uses_left: 2 });
  assert.equal((await val('NOPE')).data.reason, 'unknown_code');
  h.advance(31 * DAY);
  assert.equal((await val('CODY10')).data.reason, 'expired');
  const d = await h.call('POST', '/v1/me/codes', { key: p.key, body: { site_id: 'mom', discount_bps: 100, code: 'SHORT' } });
  assert.equal((await h.call('DELETE', '/v1/me/codes/SHORT', { key: p.key })).status, 200);
  assert.equal((await val('SHORT')).data.reason, 'inactive');
  assert.equal(d.status, 201);
  // owner tightening the site maximum invalidates existing richer codes
  const c2 = await h.call('POST', '/v1/me/codes', { key: p.key, body: { site_id: 'mom', discount_bps: 900, code: 'RICH9' } });
  assert.equal(c2.status, 201);
  assert.equal((await h.call('PATCH', '/v1/admin/sites/mom', { key: h.owner, body: { max_discount_bps: 500 } })).status, 200);
  assert.equal((await val('RICH9')).data.reason, 'discount_not_allowed');
  // AI can create a code on a partner's behalf (codes.write), but within the same policy
  assert.equal((await h.call('POST', `/v1/admin/users/${p.id}/codes`, { key: h.ai, body: { site_id: 'mom', discount_bps: 900 } })).status, 422);
  assert.equal((await h.call('POST', `/v1/admin/users/${p.id}/codes`, { key: h.ai, body: { site_id: 'mom', discount_bps: 400, code: 'AIMADE4' } })).status, 201);
});

test('code count limit per user comes from policy', async () => {
  const h = await mk();
  const p = await h.staff('partner', 'Many');
  assert.equal((await h.call('PUT', '/v1/admin/policy', { key: h.owner, body: { max_codes_per_user: 2 } })).data.max_codes_per_user, 2);
  for (let i = 0; i < 2; i++) assert.equal((await h.call('POST', '/v1/me/codes', { key: p.key, body: { site_id: 'mom', discount_bps: 100 } })).status, 201);
  assert.equal((await h.call('POST', '/v1/me/codes', { key: p.key, body: { site_id: 'mom', discount_bps: 100 } })).data.error.code, 'too_many_codes');
});

test('policy: validated, owner-only writes, audited', async () => {
  const h = await mk();
  assert.equal((await h.call('PUT', '/v1/admin/policy', { key: h.owner, body: { nonsense: 1 } })).data.error.code, 'unknown_policy');
  assert.equal((await h.call('PUT', '/v1/admin/policy', { key: h.owner, body: { min_payout_minor: -5 } })).data.error.code, 'invalid_policy');
  assert.equal((await h.call('PUT', '/v1/admin/policy', { key: h.owner, body: { override_bps: { exec: 1 } } })).status, 422);
  assert.equal((await h.call('PUT', '/v1/admin/policy', { key: h.owner, body: { min_payout_minor: 50000, tds_bps_default: 1000 } })).data.min_payout_minor, 50000);
  const a = await h.call('GET', '/v1/admin/audit', { key: h.owner });
  assert.ok(a.data.entries.some((e) => e.action === 'policy.update' && e.meta.min_payout_minor === 50000));
  assert.equal((await h.call('PATCH', '/v1/admin/sites/mom', { key: h.owner, body: { commission_bps: 99999 } })).status, 422);
  assert.equal((await h.call('PATCH', '/v1/admin/sites/mom', { key: h.owner, body: { hacked: 1 } })).status, 422);
});
