// Audit round 3 (1.0.8): wording scan, no tick boxes, joining bonus once at the database, held-bonus text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mk, DAY } from './helpers.js';
import { handle } from '../src/app.js';
import { payoutWaitText } from '../src/policy.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rd = (f) => readFileSync(join(ROOT, f), 'utf8');
const list = (dir, ext) => readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(ext)).map((f) => `${dir}/${f}`);
const JS = [...list('src', '.js'), ...list('functions', '.js'), 'public/js/app.js'].filter((f) => !f.endsWith('payee.js') && !f.endsWith('version.js'));
const HTML = list('public', '.html');
const ALLOWED = 'Copy this link and paste in your AI to work.';

/** The text of every string literal in a JS source; comments are skipped, code identifiers are never looked at. */
export function stringLiterals(src) {
  const out = [];
  let i = 0;
  let last = ''; // last significant char, to tell a regex literal from a division
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 2; continue; }
    if (c === '/' && /[(,=:[!&|?{};+\-*%<>~^]|^$/.test(last)) { // regex literal
      i++; let cls = false;
      while (i < src.length && (src[i] !== '/' || cls)) { if (src[i] === '\\') i++; else if (src[i] === '[') cls = true; else if (src[i] === ']') cls = false; i++; }
      i++; last = '/'; continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1; let s = '';
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') { s += src[j + 1]; j += 2; continue; } s += src[j]; j++; }
      out.push(s); i = j + 1; last = c; continue;
    }
    if (!/\s/.test(c)) last = c;
    i++;
  }
  return out;
}
const htmlText = (h) => h.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]*>/g, ' ');
const POSSESSIVE = /\b(my|mine|your|yours)\b/i;
const bad = (texts) => texts.map((t) => t.split(ALLOWED).join(' ')).filter((t) => POSSESSIVE.test(t));

test('scanner sanity: finds a possessive in a literal, ignores comments and identifiers, allows only the exact sentence', () => {
  assert.deepEqual(bad(stringLiterals("const your = 1; // your\nf('Your team', `a ${x} my`)")), ['Your team', 'a ${x} my']);
  assert.deepEqual(bad(stringLiterals(`f('${ALLOWED}')`)), []);
  assert.equal(bad(stringLiterals(`f('${ALLOWED} Then your key')`)).length, 1);
});

test('wording: no my, mine, your or yours in any text a person reads (screens, pages, messages, e-mails)', () => {
  const found = [];
  for (const f of JS) for (const t of bad(stringLiterals(rd(f)))) found.push(`${f}: ${t.slice(0, 90)}`);
  for (const f of HTML) for (const t of bad([htmlText(rd(f))])) found.push(`${f}: ${t.match(/.{0,40}\b(my|mine|your|yours)\b.{0,40}/i)[0]}`);
  assert.deepEqual(found, []);
});

test('wording: the word host never reads as a person role in user text, and there is no nickname', () => {
  const all = [...JS.flatMap((f) => stringLiterals(rd(f))), ...HTML.map((f) => htmlText(rd(f)))];
  assert.deepEqual(all.filter((t) => /nickname/i.test(t)), []);
  const ui = stringLiterals(rd('public/js/app.js')).filter((t) => /\bhost/i.test(t) && !/^(host|host_confirmed)$/.test(t));
  assert.deepEqual(ui, []);
});

test('no tick boxes: no checkbox in any UI source', () => {
  for (const f of ['public/js/app.js', 'public/index.html', 'public/privacy.html', 'public/terms.html', 'public/css/app.css', 'public/embed.js']) {
    assert.ok(!/checkbox/i.test(rd(f)), `${f} mentions a checkbox`);
  }
  assert.ok(!/type\s*=\s*["']?checkbox/i.test(rd('public/js/app.js')));
  assert.ok(!/(remember|tdsOk|discOn|confirmed|active)\.checked/.test(rd('public/js/app.js')), 'no tick state is read either');
});

// ---------------------------------------------------------------- joining bonus: once, decided by the database
const click = async (h, user, siteId = 'tam') => {
  const l = await h.call('POST', '/v1/me/links', { key: user.key, body: { site_id: siteId, path: '/' } });
  const res = await handle(h.ctx, new Request(`https://pc.test${l.data.url}`, { headers: { 'cf-connecting-ip': '198.51.100.9' } }));
  return new URL(res.headers.get('location')).searchParams.get('pc');
};
const bonusRows = (h) => h.db.all("SELECT * FROM ledger WHERE ref LIKE 'bonus:%'");

test('joining bonus: two first sales at the same moment pay exactly one bonus', async () => {
  const h = await mk({ realDefaults: true, payDays: [], joiningBonus: 50000 });
  const p = await h.staff('partner', 'Cy');
  const ck = await click(h, p);
  const rs2 = await Promise.all([1, 2].map((n) => h.sale('tam', { order_id: `par${n}`, click_id: ck, amount_minor: 400000 })));
  assert.deepEqual(rs2.map((r) => r.status), [201, 201].map((x, i) => rs2[i].status));
  assert.ok(rs2.every((r) => r.status < 300));
  assert.equal((await bonusRows(h)).length, 1);
  assert.equal(rs2.reduce((n, r) => n + r.data.bonus_minor, 0), 50000);
});

test('joining bonus: when another writer got in after the check, the database refuses the second bonus, the sale is still recorded and no bonus is paid twice', async () => {
  const h = await mk({ realDefaults: true, payDays: [], joiningBonus: 50000 });
  const p = await h.staff('partner', 'Di');
  const ck = await click(h, p);
  const r1 = await h.sale('tam', { order_id: 'x1', click_id: ck, amount_minor: 400000 });
  assert.equal(r1.data.bonus_minor, 50000);
  // a stale read: the shortcut SELECT in the code is made to miss the existing bonus row, as it would if a parallel writer committed just after it
  const first = h.ctx.db.first;
  let hidden = 0;
  h.ctx.db.first = (sql, params) => (/FROM ledger WHERE ref=\?/.test(sql) && String(params?.[0]).startsWith('bonus:') && hidden < 1 && ++hidden ? Promise.resolve(null) : first.call(h.ctx.db, sql, params));
  const r2 = await h.sale('tam', { order_id: 'x2', click_id: ck, amount_minor: 400000 });
  h.ctx.db.first = first;
  assert.equal(hidden, 1, 'the stale read really happened');
  assert.equal(r2.status, 201, 'the second sale is recorded');
  assert.equal(r2.data.bonus_minor, 0, 'and told it got no bonus');
  const rows = await bonusRows(h);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sale_id, r1.data.id);
  assert.equal((await h.db.first("SELECT COUNT(*) AS n FROM sales WHERE order_id='x2'")).n, 1);
});

// ---------------------------------------------------------------- held joining bonus: plain text
test('payout_wait says a joining bonus is held until it is eligible', async () => {
  for (const site of [{ return_days: 0, buffer_days: 7, early_release_bps: 0 }, { return_days: 30, buffer_days: 7, early_release_bps: 8000 }]) {
    assert.match(payoutWaitText(site), /joining bonus is held until it is eligible/i);
  }
  const h = await mk({ realDefaults: true });
  const sites = (await h.call('GET', '/v1/public/sites')).data;
  assert.ok(sites.length > 0 && sites.every((s) => /joining bonus is held until it is eligible/i.test(s.payout_wait)));
});

test('summary: an earned joining bonus that is still held carries its eligible date, and the screen says so', async () => {
  const h = await mk({ realDefaults: true, payDays: [], joiningBonus: 50000 });
  const p = await h.staff('partner', 'Ed');
  const ck = await click(h, p);
  const r = await h.sale('tam', { order_id: 'h1', click_id: ck, amount_minor: 400000 });
  const jb = (await h.call('GET', '/v1/me/summary', { key: p.key })).data.joining_bonus;
  assert.equal(jb.state, 'earned');
  assert.equal(jb.eligible_at, r.data.eligible_at);
  assert.equal(jb.held, true);
  h.advance(8 * DAY);
  const later = (await h.call('GET', '/v1/me/summary', { key: p.key })).data.joining_bonus;
  assert.equal(later.held, false);
  const app = rd('public/js/app.js');
  assert.match(app, /held until it is eligible on /);
});
