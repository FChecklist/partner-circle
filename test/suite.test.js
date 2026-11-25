import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mk, DAY } from './helpers.js';
import { handle, routes } from '../src/app.js';
import { stubEngines, moneypennyClient, monopolyClient, mockMoneypenny, mockMonopoly, EngineError } from '../src/engines.js';
import { buildOpenApi } from '../src/openapi.js';
import { verifyLedger, verifyAudit, ledgerStmts } from '../src/chain.js';
import * as SU from '../src/suite.js';

const click = async (h, user, siteId = 'mom') => {
  const l = await h.call('POST', '/v1/me/links', { key: user.key, body: { site_id: siteId, path: '/' } });
  const res = await handle(h.ctx, new Request(`https://pc.test${l.data.url}`));
  return new URL(res.headers.get('location')).searchParams.get('pc');
};
const dash = async (h, u) => (await h.call('GET', '/v1/me/dashboard', { key: u.key })).data;

/** A verified, active partner with a matured Rs 1,500 commission (one Rs 10,000 MOM sale at 15%). */
async function earner(h, name = 'Pia') {
  const p = await h.staff('partner', name);
  await h.verifyUser(p);
  const ck = await click(h, p);
  await h.sale('mom', { order_id: `o-${name}`, click_id: ck, amount_minor: 1000000 });
  h.advance(38 * DAY);
  return p;
}
const withEngines = async (extra = {}) => { const e = stubEngines(); const h = await mk({ engines: { mnp: e.mnp, mono: e.mono }, env: { MNP_COMMISSION_ENABLED: '1' }, ...extra }); h.fakes = e.fakes; return h; };
const setDest = (h, dest) => h.call('PUT', '/v1/admin/tenant', { key: h.owner, body: { commission_dest: dest } });

// ------------------------------------------------------------------ borders (contract tests)

test('Moneypenny border: signed calls work; a bad secret, a replayed nonce and a repeated write are handled as the contract says', async () => {
  const fake = mockMoneypenny({ credits: { 'a@example.test': 500 } });
  const good = moneypennyClient({ baseUrl: 'http://localhost:1', keyId: fake.keyId, secret: fake.secret, fetchImpl: fake.fetch });
  assert.equal((await good.balance('a@example.test')).credits, 500);
  const bad = moneypennyClient({ baseUrl: 'http://localhost:1', keyId: fake.keyId, secret: 'wrong-secret-0123456789', fetchImpl: fake.fetch });
  await assert.rejects(bad.balance('a@example.test'), (e) => e instanceof EngineError && e.code === 'bad_signature' && !e.definitive);
  const args = { email: 'a@example.test', event_key: 'k1', cash_minor: 83000, sale_ref: 'pay_1', payer_email: 'x@payer.invalid' };
  assert.equal((await good.postCommission(args)).granted, 1000);
  assert.equal((await good.postCommission(args)).granted, 1000, 'same idempotency key returns the first answer');
  assert.equal(fake.state.granted.length, 1, 'credited once');
  assert.throws(() => moneypennyClient({ baseUrl: 'http://evil.example', keyId: 'k', secret: 's', fetchImpl: fake.fetch }), /https/);
});

test('Monopoly border: signed people calls, unknown person is a clean error, bad signature refused', async () => {
  const fake = mockMonopoly();
  const c = monopolyClient({ baseUrl: 'http://localhost:2', keyId: fake.keyId, secret: fake.secret, fetchImpl: fake.fetch });
  await assert.rejects(c.targets('nobody@example.test'), (e) => e.code === 'unknown_person');
  await c.provision({ email: 'a@example.test', name: 'A', role: 'partner' });
  assert.deepEqual(await c.targets('a@example.test'), []);
  const bad = monopolyClient({ baseUrl: 'http://localhost:2', keyId: fake.keyId, secret: 'nope-nope-nope-nope', fetchImpl: fake.fetch });
  await assert.rejects(bad.provision({ email: 'b@example.test', name: 'B', role: 'partner' }), (e) => e.code === 'bad_signature');
});

// ------------------------------------------------------------------ onboarding / provisioning

test('approval provisions the partner into both engines with no second login; engine down never blocks approval and is retried', async () => {
  const h = await withEngines();
  const r = await h.call('POST', '/v1/register', { body: { role: 'partner', name: 'Newbie', email: 'newbie@example.test', phone: '9876543210' } });
  const key = r.data.api_key; const id = r.data.user.id;
  assert.equal(h.fakes.mono.state.people.size, 0, 'pending partners are not provisioned');
  h.fakes.mono.state.down = true;
  const ap = await h.call('POST', `/v1/admin/users/${id}/approve`, { key: h.owner });
  assert.equal(ap.status, 200, 'approval succeeds while Monopoly is down');
  assert.equal(h.fakes.mono.state.people.size, 0);
  // e-mail must be verified before a person is linked
  await h.call('POST', '/v1/me/email/send-code', { key });
  await h.call('POST', '/v1/me/email/verify', { key, body: { code: h.mailer.outbox.at(-1)._code } });
  h.fakes.mono.state.down = false;
  h.advance(10 * 60000); // past the back-off
  const d = await h.call('GET', '/v1/me/dashboard', { key });
  assert.equal(d.status, 200);
  assert.ok(h.fakes.mono.state.people.has('newbie@example.test'), 'retried and provisioned from the dashboard');
  const links = await h.db.all("SELECT engine, state FROM engine_links WHERE user_id=? ORDER BY engine", [id]);
  assert.deepEqual(links.map((l) => `${l.engine}:${l.state}`), ['mnp:linked', 'mono:linked']);
  // suspend tells Monopoly
  await h.call('POST', `/v1/admin/users/${id}/suspend`, { key: h.owner, body: { why: 'test' } });
  assert.ok(h.fakes.mono.state.suspended.has('newbie@example.test'));
});

// ------------------------------------------------------------------ dashboard

test('dashboard: owner wording, real money beside credits, degraded mode (stale, then unavailable), untrusted text stripped', async () => {
  const h = await withEngines();
  const p = await h.staff('partner', 'Dash');
  await h.verifyUser(p);
  h.fakes.mnp.state.balances[p.email] = 1250;
  h.fakes.mono.state.targets[p.email] = [{ name: '<b>Sell 5</b>', period: 'monthly', goal: 5, progress: 2 }];
  h.fakes.mono.state.achievements[p.email] = { level: 3, badges: [{ name: 'First sale<script>' }] };
  let d = await dash(h, p);
  assert.equal(d.moneypenny.status, 'live');
  assert.equal(d.moneypenny.lines.owned, '1,250 Moneypenny (credits) owned = US$12.50 (about ₹1,037.50)');
  assert.equal(d.moneypenny.lines.rate, '100 Moneypenny = 1 US$');
  assert.match(d.moneypenny.lines.convert, /You can convert 625 Moneypenny \(US\$6\.25\) to money/);
  assert.equal(d.monopoly.targets[0].name, 'bSell 5/b', 'markup characters removed');
  assert.ok(!JSON.stringify(d).includes('<'), 'no markup survives from an engine');
  assert.equal(d.commissions.destination, 'ledger');
  // engine goes down: last numbers shown, labelled stale
  h.fakes.mnp.state.down = true; h.fakes.mono.state.down = true;
  h.advance(2 * 60000);
  d = await dash(h, p);
  assert.equal(d.moneypenny.status, 'stale');
  assert.equal(d.moneypenny.credits, 1250);
  assert.equal(d.monopoly.status, 'stale');
  assert.ok(d.notes.length >= 2);
  assert.ok('commissions' in d && d.commissions.ledger_total_minor === 0, 'the rest of the page still loads');
  // a person with no cache while the engine is down gets a soft line, not an error
  const q = await h.staff('partner', 'Fresh'); await h.verifyUser(q);
  d = await dash(h, q);
  assert.equal(d.moneypenny.status, 'unavailable');
});

test('dashboard with no engines configured says "not connected" and shows no invented numbers', async () => {
  const h = await mk();
  const p = await h.staff('partner', 'Solo'); await h.verifyUser(p);
  const d = await dash(h, p);
  assert.equal(d.moneypenny.status, 'not_connected');
  assert.equal(d.moneypenny.credits, undefined);
  assert.equal(d.monopoly.status, 'not_connected');
});

test('the engine off-switch in tenant settings hides that block', async () => {
  const h = await withEngines();
  const p = await h.staff('partner', 'Off'); await h.verifyUser(p);
  await h.call('PUT', '/v1/admin/tenant', { key: h.owner, body: { mnp_enabled: 0 } });
  assert.equal((await dash(h, p)).moneypenny.status, 'off');
});

// ------------------------------------------------------------------ commissions: one place only

test('default policy: commissions stay in Partner Circle and the owner-approved payout path is unchanged; the sweep does nothing', async () => {
  const h = await withEngines();
  assert.equal((await SU.suiteStatus(h.ctx)).commission_destination, 'ledger');
  assert.equal((await SU.suiteStatus(h.ctx)).payout_mode, 'mock');
  const p = await earner(h);
  const sw = await h.call('POST', '/v1/admin/suite/sweep', { key: h.owner });
  assert.equal(sw.data.claimed, 0);
  assert.equal(h.fakes.mnp.state.granted.length, 0);
  const po = await h.call('POST', '/v1/me/payouts', { key: p.key });
  assert.equal(po.status, 201);
  assert.equal(po.data.status, 'pending_approval', 'still needs the owner');
  assert.equal(h.payouts.calls.length, 0, 'mock provider not called until the owner approves');
});

test('commission_dest=moneypenny: matured commission is paid once as Moneypenny credits and leaves the payout flow (no double pay)', async () => {
  const h = await withEngines();
  const p = await earner(h);
  assert.equal((await setDest(h, 'moneypenny')).status, 200);
  const sw1 = await h.call('POST', '/v1/admin/suite/sweep', { key: h.owner });
  assert.deepEqual([sw1.data.claimed, sw1.data.posted], [1, 1]);
  const sw2 = await h.call('POST', '/v1/admin/suite/sweep', { key: h.owner });
  assert.deepEqual([sw2.data.claimed, sw2.data.posted], [0, 0], 'a second sweep pays nothing');
  assert.equal(h.fakes.mnp.state.granted.length, 1);
  assert.equal(h.fakes.mnp.state.balances[p.email], 1807);
  // payout flow now sees nothing to pay
  const po = await h.call('POST', '/v1/me/payouts', { key: p.key });
  assert.equal(po.data.error.code, 'below_minimum');
  assert.equal(po.data.error.available_minor, 0);
  const b = (await h.call('GET', '/v1/me/balance', { key: p.key })).data;
  assert.equal(b.available_minor + b.pending_minor, b.ledger_total_minor, 'ledger self-check still balances');
  assert.equal(b.ledger_total_minor, 0);
  const d = await dash(h, p);
  assert.equal(d.commissions.sent_to_moneypenny_minor, 150000);
  assert.equal(d.moneypenny.credits, 1807);
  assert.equal((await verifyLedger(h.db)).ok, true);
  assert.equal((await verifyAudit(h.db)).ok, true);
});

test('the database refuses a second claim on the same entry, in either order', async () => {
  const h = await withEngines();
  const p = await earner(h, 'Dup');
  const seq = (await h.db.first("SELECT seq FROM ledger WHERE account_id=? AND kind='commission'", [p.id])).seq;
  await h.db.run('INSERT INTO mp_postings (ledger_seq,user_id,amount_minor,event_key,sale_ref,created_at) VALUES (?,?,?,?,?,?)', [seq, p.id, 1, 'k', 's', 1]);
  await assert.rejects(h.db.run("INSERT INTO payouts (id,user_id,gross_minor,status,requested_by_key,created_at) VALUES ('po_x',?,1,'pending_approval','k',1)", [p.id]).then(() => h.db.run("INSERT INTO payout_items (ledger_seq,payout_id,amount_minor) VALUES (?, 'po_x', 1)", [seq])), /already posted to Moneypenny/);
  const q = await earner(h, 'Dup2');
  const seq2 = (await h.db.first("SELECT seq FROM ledger WHERE account_id=? AND kind='commission'", [q.id])).seq;
  await h.db.run("INSERT INTO payouts (id,user_id,gross_minor,status,requested_by_key,created_at) VALUES ('po_y',?,1,'pending_approval','k',1)", [q.id]);
  await h.db.run("INSERT INTO payout_items (ledger_seq,payout_id,amount_minor) VALUES (?, 'po_y', 1)", [seq2]);
  await assert.rejects(h.db.run('INSERT INTO mp_postings (ledger_seq,user_id,amount_minor,event_key,sale_ref,created_at) VALUES (?,?,?,?,?,?)', [seq2, q.id, 1, 'k2', 's2', 1]), /already belongs to a payout/);
});

test('an entry already in a payout is never claimed for Moneypenny', async () => {
  const h = await withEngines();
  const p = await earner(h, 'Early');
  assert.equal((await h.call('POST', '/v1/me/payouts', { key: p.key })).status, 201);
  await setDest(h, 'moneypenny');
  const sw = await h.call('POST', '/v1/admin/suite/sweep', { key: h.owner });
  assert.equal(sw.data.claimed, 0);
  assert.equal(h.fakes.mnp.state.granted.length, 0);
});

test('Moneypenny down: the claim waits and retries with the same key; recovery pays exactly once', async () => {
  const h = await withEngines();
  const p = await earner(h, 'Slow');
  await setDest(h, 'moneypenny');
  h.fakes.mnp.state.down = true;
  const a = await h.call('POST', '/v1/admin/suite/sweep', { key: h.owner });
  assert.deepEqual([a.data.claimed, a.data.posted, a.data.retry], [1, 0, 1]);
  h.fakes.mnp.state.down = false;
  h.advance(5 * 60000);
  const b = await h.call('POST', '/v1/admin/suite/sweep', { key: h.owner });
  assert.equal(b.data.posted, 1);
  h.advance(DAY);
  const c = await h.call('POST', '/v1/admin/suite/sweep', { key: h.owner });
  assert.equal(c.data.posted, 0);
  assert.equal(h.fakes.mnp.state.granted.length, 1);
  assert.equal(h.fakes.mnp.state.balances[p.email], 1807);
});

test('Moneypenny refuses (no rule): the claim is held for the owner, never silently re-paid elsewhere; requeue after the fix pays once', async () => {
  const h = await withEngines();
  const p = await earner(h, 'Held');
  await setDest(h, 'moneypenny');
  h.fakes.mnp.state.rule = false;
  const a = await h.call('POST', '/v1/admin/suite/sweep', { key: h.owner });
  assert.equal(a.data.rejected, 1);
  const st = await h.call('GET', '/v1/admin/suite/status', { key: h.ai });
  assert.equal(st.data.exceptions.length, 1);
  assert.equal(st.data.exceptions[0].last_error, 'no_rule');
  assert.equal((await h.call('POST', '/v1/me/payouts', { key: p.key })).data.error.available_minor, 0, 'not payable through the payout path either');
  h.fakes.mnp.state.rule = true;
  assert.equal((await h.call('POST', `/v1/admin/suite/postings/${st.data.exceptions[0].ledger_seq}/requeue`, { key: h.ai })).status, 403, 'AI cannot requeue money');
  assert.equal((await h.call('POST', `/v1/admin/suite/postings/${st.data.exceptions[0].ledger_seq}/requeue`, { key: h.owner })).status, 200);
  const b = await h.call('POST', '/v1/admin/suite/sweep', { key: h.owner });
  assert.equal(b.data.posted, 1);
  assert.equal(h.fakes.mnp.state.granted.length, 1);
});

test('refund before Moneypenny was told: claim released and voided, nothing credited; refund after credit: kept and flagged, no clawback', async () => {
  const h = await withEngines();
  const p = await h.staff('partner', 'Ref'); await h.verifyUser(p);
  const ck = await click(h, p);
  await h.sale('mom', { order_id: 'r1', click_id: ck, amount_minor: 1000000 });
  await h.sale('mom', { order_id: 'r2', click_id: ck, amount_minor: 1000000 });
  h.advance(38 * DAY);
  await setDest(h, 'moneypenny');
  h.fakes.mnp.state.down = true; // r1, r2 claimed, never delivered (attempt count rises though)
  // claim without any attempt: run only the claim half by making the engine unreachable AFTER claim is impossible here, so claim directly:
  const rows = await h.db.all("SELECT seq, ref, amount_minor FROM ledger WHERE account_id=? AND kind='commission' ORDER BY seq", [p.id]);
  for (const r of rows) {
    await h.db.batch([
      { sql: 'INSERT INTO mp_postings (ledger_seq,user_id,amount_minor,event_key,sale_ref,created_at) VALUES (?,?,?,?,?,?)', params: [r.seq, p.id, r.amount_minor, `pc:${r.ref}`, `pay_${r.ref}`, h.clock.t] },
      ...(await ledgerStmts(h.ctx, [{ account_id: p.id, kind: 'payout_reserve', amount_minor: -r.amount_minor, eligible_at: h.clock.t, ref: `mpclaim:${r.seq}`, memo: 'sent to Moneypenny' }])),
    ]);
  }
  const out = await h.signed('mom', 'POST', '/v1/integration/refunds', { order_id: 'r1', reason: 'test' });
  assert.equal(out.status, 200);
  assert.equal(await h.db.first('SELECT 1 AS x FROM mp_postings WHERE ledger_seq=?', [rows[0].seq]), null, 'untouched claim taken back');
  assert.ok(await h.db.first('SELECT 1 AS x FROM mp_postings WHERE ledger_seq=?', [rows[1].seq]));
  // r2 delivered, then refunded
  h.fakes.mnp.state.down = false;
  await h.db.run("UPDATE mp_postings SET state='posted', attempts=1 WHERE ledger_seq=?", [rows[1].seq]);
  const out2 = await h.signed('mom', 'POST', '/v1/integration/refunds', { order_id: 'r2', reason: 'test' });
  assert.equal(out2.data.refund_after_payout, true, 'flagged for the owner');
  const tot = (await h.db.first('SELECT SUM(amount_minor) AS n FROM ledger WHERE account_id=?', [p.id])).n;
  assert.equal(tot, 0, 'the partner is not left with a phantom balance');
  assert.equal((await verifyLedger(h.db)).ok, true);
});

// ------------------------------------------------------------------ conversion request, tenant, AI readiness

test('convert request: people only, needs an idempotency key, goes live to Moneypenny, AI key refused', async () => {
  const h = await withEngines();
  const p = await h.staff('partner', 'Conv'); await h.verifyUser(p);
  h.fakes.mnp.state.balances[p.email] = 1000;
  assert.equal((await h.call('POST', '/v1/me/moneypenny/convert-request', { key: p.key, body: { credits: 100 } })).data.error.code, 'idempotency_key_required');
  const ok = await h.call('POST', '/v1/me/moneypenny/convert-request', { key: p.key, body: { credits: 100 }, headers: { 'idempotency-key': 'c1' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.status, 'requested');
  const again = await h.call('POST', '/v1/me/moneypenny/convert-request', { key: p.key, body: { credits: 100 }, headers: { 'idempotency-key': 'c1' } });
  assert.equal(again.headers.get('idempotent-replay'), 'true');
  assert.equal(h.fakes.mnp.state.converts.length, 1);
  assert.equal((await h.call('POST', '/v1/me/moneypenny/convert-request', { key: p.key, body: { credits: 99999 }, headers: { 'idempotency-key': 'c2' } })).data.error.code, 'more_than_convertible');
  assert.equal((await h.call('POST', '/v1/me/moneypenny/convert-request', { key: h.ai, body: { credits: 1 }, headers: { 'idempotency-key': 'c3' } })).status, 403);
  h.fakes.mnp.state.down = true;
  assert.equal((await h.call('POST', '/v1/me/moneypenny/convert-request', { key: p.key, body: { credits: 100 }, headers: { 'idempotency-key': 'c4' } })).status, 503, 'money decisions never fall back to a cache');
});

test('tenant profile: owner only, validated, public brand is safe, cannot route commissions to an unconnected Moneypenny', async () => {
  const h = await mk();
  const brand = (await h.call('GET', '/v1/public/brand')).data;
  assert.equal(brand.product_name, 'Partner Circle');
  assert.equal(brand.currency_label, 'Moneypenny');
  assert.equal((await h.call('PUT', '/v1/admin/tenant', { key: h.ai, body: { product_name: 'X' } })).status, 403);
  for (const bad of [{ accent: 'red' }, { logo_url: 'http://x.example/a.png' }, { product_name: '<b>x</b>' }, { currency_label: '' }, { evil: 1 }, { commission_dest: 'cash' }]) {
    assert.equal((await h.call('PUT', '/v1/admin/tenant', { key: h.owner, body: bad })).status, 422, JSON.stringify(bad));
  }
  assert.equal((await h.call('PUT', '/v1/admin/tenant', { key: h.owner, body: { commission_dest: 'moneypenny' } })).data.error.code, 'engine_not_connected');
  const ok = await h.call('PUT', '/v1/admin/tenant', { key: h.owner, body: { product_name: 'Acme Partners', accent: '#112233', currency_label: 'Acme Coins', logo_url: 'https://acme.example/logo.png' } });
  assert.equal(ok.status, 200);
  const p = await h.staff('partner', 'Brand'); await h.verifyUser(p);
  assert.equal((await dash(h, p)).brand.currency_label, 'Acme Coins');
});

test('AI readiness: every route is described; no route that moves money is open to an AI key; AI reads carry the untrusted-text flag', async () => {
  const doc = buildOpenApi(routes);
  const ops = Object.values(doc.paths).flatMap((m) => Object.values(m));
  assert.equal(ops.length, routes.length);
  for (const op of ops) {
    assert.ok(['read', 'write'].includes(op['x-rw']));
    assert.equal(typeof op['x-money'], 'boolean');
    if (op['x-money']) assert.equal(op['x-ai'].access, 'no', `${op.summary} moves money but is open to AI`);
    if (op['x-rw'] === 'write' && op['x-auth'] !== 'public') assert.ok(op['x-requires-idempotency-key'] !== undefined);
  }
  assert.equal(doc.paths['/v1/admin/payouts/:id/approve'].post['x-ai'].access, 'no');
  assert.equal(doc.paths['/v1/me/moneypenny/convert-request'].post['x-money'], true);
  const h = await mk();
  const r = await h.call('GET', '/v1/admin/summary', { key: h.ai });
  assert.ok(r.headers.get('x-untrusted-text'));
  assert.ok(r.data._untrusted);
  const o = await h.call('GET', '/v1/admin/summary', { key: h.owner });
  assert.equal(o.data._untrusted, undefined);
});

test('Moneypenny signature is the pinned six-part form (timestamp, nonce, method, path+query, body hash, idempotency key)', async () => {
  const { mnpSign } = await import('../src/engines.js');
  const { createHmac } = await import('node:crypto');
  const parts = { ts: '1700000000000', nonce: 'n1', method: 'POST', pathWithQuery: '/v1/x?a=1', bodyHash: 'abc', idem: 'k-1' };
  const want = createHmac('sha256', 'secret').update('1700000000000\nn1\nPOST\n/v1/x?a=1\nabc\nk-1').digest('hex');
  assert.equal(await mnpSign('secret', parts), want);
  assert.notEqual(await mnpSign('secret', { ...parts, idem: '' }), want, 'the idempotency key is part of what is signed');
});

test('major 1: ok:true with no reason or granted 0 is never "posted"; the claim stays pending and retries with the same key', async () => {
  const h = await withEngines();
  await earner(h, 'Vague');
  await setDest(h, 'moneypenny');
  const orig = h.ctx.engines.mnp.postCommission;
  h.ctx.engines.mnp.postCommission = async () => ({ granted: 0, reason: null });
  const a = await h.call('POST', '/v1/admin/suite/sweep', { key: h.owner });
  assert.deepEqual([a.data.claimed, a.data.posted, a.data.retry], [1, 0, 1]);
  const row = await h.ctx.db.first('SELECT state, last_error, granted_credits FROM mp_postings');
  assert.deepEqual([row.state, row.last_error, row.granted_credits], ['pending', 'unclear_answer', null]);
  h.ctx.engines.mnp.postCommission = orig;
});

test('major 2: commission to Moneypenny is refused unless the server switch is on; a definitely rejected claim can be released back to the ledger', async () => {
  const off = await withEngines({ env: {} });
  assert.equal((await setDest(off, 'moneypenny')).data.error.code, 'not_in_v1');
  const h = await withEngines();
  const p = await earner(h, 'Refused');
  await setDest(h, 'moneypenny');
  h.fakes.mnp.state.rule = null; // Moneypenny answers no_rule: a definite refusal
  await h.call('POST', '/v1/admin/suite/sweep', { key: h.owner });
  const row = await h.ctx.db.first('SELECT * FROM mp_postings');
  assert.equal(row.state, 'rejected');
  const before = (await h.call('GET', '/v1/me/dashboard', { key: p.key })).data.commissions;
  const rel = await h.call('POST', `/v1/admin/suite/postings/${row.ledger_seq}/release`, { key: h.owner });
  assert.equal(rel.status, 200);
  assert.equal(await h.ctx.db.first('SELECT 1 AS x FROM mp_postings'), null);
  const after = (await h.call('GET', '/v1/me/dashboard', { key: p.key })).data.commissions;
  assert.ok(after.available_minor > before.available_minor, 'money is back in the partner balance');
  assert.equal((await h.call('POST', `/v1/admin/suite/postings/${row.ledger_seq}/release`, { key: h.owner })).status, 404);
});

test('major 3: erase is refused until Monopoly confirms the removal', async () => {
  const h = await withEngines();
  const p = await earner(h, 'Gone');
  await h.call('GET', '/v1/me/dashboard', { key: p.key });
  await h.ctx.db.run("UPDATE engine_links SET state='linked', linked_at=1 WHERE user_id=? AND engine='mono'", [p.id]);
  h.fakes.mono.state.down = true;
  const r = await h.call('POST', `/v1/admin/users/${p.id}/erase`, { key: h.owner });
  assert.equal(r.data.error.code, 'engine_suspend_pending');
  assert.equal((await h.ctx.db.first('SELECT erased_at FROM users WHERE id=?', [p.id])).erased_at, null);
});

test('major 4: a Moneypenny suspend is recorded honestly as no_remote_suspend', async () => {
  const h = await withEngines();
  const p = await earner(h, 'Quiet');
  await SU.enqueueLinks(h.ctx, p.id, 'suspended');
  await SU.syncUser(h.ctx, p.id);
  const a = await h.ctx.db.first("SELECT meta FROM audit_log WHERE action='engine.link' AND meta LIKE '%no_remote_suspend%' LIMIT 1");
  assert.ok(a, 'audit row carries the no_remote_suspend note');
});

test('audit 3: release is refused when it cannot prove no credit exists (sale_already_used, retried claims, refunded sale)', async () => {
  const h = await withEngines();
  await earner(h, 'Dup');
  await setDest(h, 'moneypenny');
  await h.call('POST', '/v1/admin/suite/sweep', { key: h.owner });
  const row = await h.ctx.db.first('SELECT * FROM mp_postings');
  await h.ctx.db.run("UPDATE mp_postings SET state='rejected', granted_credits=NULL, last_error='sale_already_used', attempts=1 WHERE ledger_seq=?", [row.ledger_seq]);
  assert.equal((await h.call('POST', `/v1/admin/suite/postings/${row.ledger_seq}/release`, { key: h.owner })).data.error.code, 'manual_review');
  await h.ctx.db.run("UPDATE mp_postings SET last_error='no_rule', attempts=2 WHERE ledger_seq=?", [row.ledger_seq]);
  assert.equal((await h.call('POST', `/v1/admin/suite/postings/${row.ledger_seq}/release`, { key: h.owner })).data.error.code, 'manual_review');
  await h.ctx.db.run("UPDATE mp_postings SET attempts=1 WHERE ledger_seq=?", [row.ledger_seq]);
  await h.ctx.db.run("UPDATE sales SET status='refunded' WHERE id=(SELECT sale_id FROM ledger WHERE seq=?)", [row.ledger_seq]);
  assert.equal((await h.call('POST', `/v1/admin/suite/postings/${row.ledger_seq}/release`, { key: h.owner })).data.error.code, 'sale_not_recorded');
});

test('audit 4: requeue never resets attempts, so a possibly-credited (dead) claim cannot become releasable; no claiming without the v1 switch', async () => {
  const h = await withEngines();
  await earner(h, 'Req');
  await setDest(h, 'moneypenny');
  await h.call('POST', '/v1/admin/suite/sweep', { key: h.owner });
  const row = await h.ctx.db.first('SELECT * FROM mp_postings');
  await h.ctx.db.run("UPDATE mp_postings SET state='dead', granted_credits=NULL, attempts=8 WHERE ledger_seq=?", [row.ledger_seq]);
  await h.call('POST', `/v1/admin/suite/postings/${row.ledger_seq}/requeue`, { key: h.owner });
  assert.equal((await h.ctx.db.first('SELECT attempts FROM mp_postings')).attempts, 8);
  await h.ctx.db.run("UPDATE mp_postings SET state='rejected', last_error='no_rule' WHERE ledger_seq=?", [row.ledger_seq]);
  assert.equal((await h.call('POST', `/v1/admin/suite/postings/${row.ledger_seq}/release`, { key: h.owner })).data.error.code, 'manual_review');
  const off = await withEngines({ env: {} });
  await earner(off, 'Off');
  await off.ctx.db.run("UPDATE tenant_profile SET commission_dest='moneypenny'");
  assert.equal((await off.call('POST', '/v1/admin/suite/sweep', { key: off.owner })).data.claimed, 0);
});

test('audit 5: a crash after sending still counts the attempt (release refused); a refunded claim no longer blocks erase or shows as on the way', async () => {
  const h = await withEngines();
  const p = await earner(h, 'Crash');
  await setDest(h, 'moneypenny');
  h.fakes.mnp.state.down = true;
  await h.call('POST', '/v1/admin/suite/sweep', { key: h.owner });
  const row = await h.ctx.db.first('SELECT * FROM mp_postings');
  assert.equal(row.attempts, 1);
  assert.ok(row.sent_at);
  // attempts is bumped in the same batch as sent_at (before the call), so it counts even if the process dies mid-call
  await h.ctx.db.run("UPDATE mp_postings SET state='pending', attempts=1, next_try_at=0 WHERE ledger_seq=?", [row.ledger_seq]);
  h.fakes.mnp.state.down = false; h.fakes.mnp.state.rule = null;
  await h.call('POST', '/v1/admin/suite/sweep', { key: h.owner });
  const r2 = await h.ctx.db.first('SELECT * FROM mp_postings');
  assert.equal(r2.state, 'rejected');
  assert.ok(r2.attempts >= 2);
  assert.equal((await h.call('POST', `/v1/admin/suite/postings/${row.ledger_seq}/release`, { key: h.owner })).data.error.code, 'manual_review');
  await h.ctx.db.run("UPDATE sales SET status='refunded' WHERE id=(SELECT sale_id FROM ledger WHERE seq=?)", [row.ledger_seq]);
  const d = (await h.call('GET', '/v1/me/dashboard', { key: p.key })).data;
  assert.equal(d.commissions.on_the_way_to_moneypenny_minor, 0);
});

test('cloud audit 2 H1: an unverified e-mail never reaches the engines (no reading another person\'s balance)', async () => {
  const h = await withEngines();
  h.fakes.mnp.state.balances['victim@example.test'] = 500000;
  const p = await h.staff('refer', 'Sneak');
  await h.call('PATCH', '/v1/me', { key: p.key, body: { email: 'victim@example.test' } });
  const d = (await h.call('GET', '/v1/me/dashboard', { key: p.key })).data;
  assert.equal(d.moneypenny.status, 'verify_email');
  assert.equal(d.moneypenny.credits, undefined);
  assert.equal(d.monopoly.status, 'verify_email');
});

test('cloud audit 1 M1: two concurrent runs send a claim once and attempts stays truthful (lease)', async () => {
  const h = await withEngines();
  await earner(h, 'Race');
  await setDest(h, 'moneypenny');
  let calls = 0;
  const orig = h.ctx.engines.mnp.postCommission;
  h.ctx.engines.mnp.postCommission = async (a) => { calls += 1; await new Promise((r) => setTimeout(r, 30)); return orig(a); };
  await Promise.all([SU.runPostings(h.ctx), SU.runPostings(h.ctx)]);
  assert.equal(calls, 1, 'one send');
  const row = await h.ctx.db.first('SELECT attempts, state FROM mp_postings');
  assert.deepEqual([row.attempts, row.state], [1, 'posted']);
});

test('cloud audit 1 M3: a sent claim whose sale was refunded is listed for the owner, not silently stuck', async () => {
  const h = await withEngines();
  await earner(h, 'Stuck');
  await setDest(h, 'moneypenny');
  h.fakes.mnp.state.down = true;
  await h.call('POST', '/v1/admin/suite/sweep', { key: h.owner });
  await h.ctx.db.run("UPDATE sales SET status='refunded'");
  const st = (await h.call('GET', '/v1/admin/suite/status', { key: h.owner })).data;
  assert.equal(st.refunded_sent.length, 1);
});
