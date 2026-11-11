import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { mk, DAY } from './helpers.js';
import { handle } from '../src/app.js';

const click = async (h, user, siteId = 'mom') => {
  const l = await h.call('POST', '/v1/me/links', { key: user.key, body: { site_id: siteId, path: '/' } });
  const res = await handle(h.ctx, new Request(`https://pc.test${l.data.url}`));
  return new URL(res.headers.get('location')).searchParams.get('pc');
};

test('schemes: AI drafts, only the owner activates and settles; winners get one bonus entry each; double-settle impossible', async () => {
  const h = await mk();
  const a = await h.staff('partner', 'Winner');
  const b = await h.staff('partner', 'Almost');
  const start = h.clock.t;
  const draft = await h.call('POST', '/v1/admin/schemes', { key: h.ai, body: { name: 'Week 1 sprint', period: 'weekly', metric: 'sales_count', target: 2, bonus_minor: 30000, starts_at: start, ends_at: start + 7 * DAY } });
  assert.equal(draft.status, 201);
  assert.equal(draft.data.status, 'draft');
  const id = draft.data.id;
  assert.equal((await h.call('POST', `/v1/admin/schemes/${id}/activate`, { key: h.ai })).status, 403);
  assert.equal((await h.call('POST', `/v1/admin/schemes/${id}/settle`, { key: h.owner })).status, 409, 'draft cannot settle');
  assert.equal((await h.call('POST', `/v1/admin/schemes/${id}/activate`, { key: h.owner })).data.status, 'active');
  const ca = await click(h, a);
  const cb = await click(h, b);
  await h.sale('mom', { order_id: 'w1', click_id: ca });
  await h.sale('mom', { order_id: 'w2', click_id: ca });
  await h.sale('mom', { order_id: 'w3', click_id: cb });
  await h.sale('mom', { order_id: 'w4', click_id: cb, amount_minor: 100000 }, { rzp: false }); // unconfirmed: does not count
  const prog = (await h.call('GET', '/v1/me/schemes', { key: a.key })).data.schemes[0];
  assert.deepEqual([prog.value, prog.percent], [2, 100]);
  assert.equal((await h.call('GET', '/v1/me/schemes', { key: b.key })).data.schemes[0].percent, 50);
  assert.equal((await h.call('POST', `/v1/admin/schemes/${id}/settle`, { key: h.owner })).data.error.code, 'not_ended');
  h.advance(8 * DAY);
  const st = await h.call('POST', `/v1/admin/schemes/${id}/settle`, { key: h.owner });
  assert.equal(st.data.winners, 1);
  assert.equal((await h.call('POST', `/v1/admin/schemes/${id}/settle`, { key: h.owner })).status, 409);
  const entries = await h.db.all("SELECT account_id, amount_minor FROM ledger WHERE kind='adjustment'");
  assert.deepEqual(entries, [{ account_id: a.id, amount_minor: 30000 }]);
  // the bonus matures after the scheme hold (default 37 days), like commission
  const bal = async () => (await h.call('GET', '/v1/me/balance', { key: a.key })).data;
  assert.ok((await bal()).pending_minor >= 30000);
  h.advance(37 * DAY);
  const b2 = await bal();
  assert.equal(b2.ledger_total_minor, b2.available_minor + b2.pending_minor);
});

test('scheme validation and leaderboard shows first names only', async () => {
  const h = await mk();
  const t = h.clock.t;
  const bad = [{ name: '', period: 'weekly', metric: 'sales_count', target: 1, bonus_minor: 1, starts_at: t, ends_at: t + 1 },
    { name: 'x', period: 'yearly', metric: 'sales_count', target: 1, bonus_minor: 1, starts_at: t, ends_at: t + 1 },
    { name: 'x', period: 'weekly', metric: 'sales_count', target: 0, bonus_minor: 1, starts_at: t, ends_at: t + 1 },
    { name: 'x', period: 'weekly', metric: 'sales_count', target: 1, bonus_minor: 1, starts_at: t, ends_at: t },
    { name: 'x', period: 'weekly', metric: 'sales_count', target: 1, bonus_minor: 1, starts_at: t, ends_at: t + 1, site_id: 'nope' }];
  for (const body of bad) assert.equal((await h.call('POST', '/v1/admin/schemes', { key: h.owner, body })).status, 422, JSON.stringify(body));
  const p = await h.staff('partner', 'Imran Khan');
  await h.sale('mom', { order_id: 'lb1', click_id: await click(h, p) });
  const lb = (await h.call('GET', '/v1/leaderboard', { key: p.key })).data.month;
  assert.equal(lb[0].first_name, 'Imran');
  assert.ok(!JSON.stringify(lb).includes('Khan'));
});

function runEmbed(href, store = {}) {
  const cookies = [];
  const win = {
    location: { href, protocol: 'https:' },
    localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
  };
  const doc = {
    get cookie() { return cookies.join('; '); },
    set cookie(v) { const [kv] = v.split(';'); const [k] = kv.split('='); const i = cookies.findIndex((c) => c.startsWith(k + '=')); if (i >= 0) cookies[i] = kv; else cookies.push(kv); },
    createElement: () => ({}),
  };
  win.window = win;
  const ctx = vm.createContext({ window: win, document: doc, location: win.location, URL, encodeURIComponent, decodeURIComponent, RegExp });
  vm.runInContext(readFileSync(new URL('../public/embed.js', import.meta.url), 'utf8'), ctx);
  return { pc: win.PartnerCircle, store, cookies };
}

test('embed snippet: remembers a valid click id and code, ignores junk, survives navigation via cookie/localStorage', () => {
  const e = runEmbed('https://mom.veridian-aios.com/pricing?pc=ck_0123456789abcdef&pcode=cody10');
  assert.equal(e.pc.clickId(), 'ck_0123456789abcdef');
  assert.equal(e.pc.code(), 'CODY10');
  // next page: no query string, store carried over
  const e2 = runEmbed('https://mom.veridian-aios.com/checkout', e.store);
  assert.equal(e2.pc.clickId(), 'ck_0123456789abcdef');
  const junk = runEmbed('https://x.test/?pc=<script>alert(1)</script>&pcode=%27%20OR%201');
  assert.equal(junk.pc.clickId(), '');
  assert.equal(junk.pc.code(), '');
  const fields = [];
  const form = { appendChild: (i) => fields.push(i) };
  e.pc.attach(form);
  assert.deepEqual(fields.map((f) => [f.name, f.value]), [['pc_click_id', 'ck_0123456789abcdef'], ['pc_code', 'CODY10']]);
});

test('/v1/public/sites exposes only what a signup page needs, with CORS for the browser', async () => {
  const h = await mk();
  const r = await h.call('GET', '/v1/public/sites');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.equal(r.data.length, 9);
  assert.deepEqual(Object.keys(r.data[0]).sort(), ['discount_allowed', 'host', 'id', 'max_discount_bps', 'name', 'refund_terms', 'return_days']);
});

test('site signing secret is derived (never stored), revealable only by the owner, and rotating it invalidates the old one', async () => {
  const h = await mk();
  assert.equal((await h.call('GET', '/v1/admin/sites/mom/secret', { key: h.ai })).status, 403);
  const s1 = (await h.call('GET', '/v1/admin/sites/mom/secret', { key: h.owner })).data.signing_secret;
  assert.match(s1, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(await h.db.all('SELECT * FROM sites')).includes(s1));
  assert.equal((await h.signed('mom', 'POST', '/v1/integration/sales', { order_id: 'k1', amount_minor: 100 })).status, 201);
  assert.equal((await h.call('POST', '/v1/admin/sites/mom/rotate-secret', { key: h.owner })).status, 200);
  const old = await h.signed('mom', 'POST', '/v1/integration/sales', { order_id: 'k2', amount_minor: 100 }, { secretOverride: s1 });
  assert.equal(old.status, 401);
  const s2 = (await h.call('GET', '/v1/admin/sites/mom/secret', { key: h.owner })).data.signing_secret;
  assert.notEqual(s1, s2);
  const audit = (await h.call('GET', '/v1/admin/audit', { key: h.owner })).data.entries.map((e) => e.action);
  assert.ok(audit.includes('site.secret_revealed') && audit.includes('site.secret_rotated'));
});
