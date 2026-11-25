// Audit round 4 (1.0.9): the joining bonus is for a Growth Partner only, an AI key cannot approve early, the wording guard cannot be fooled by the string reader, no tick box anywhere in the UI, the payee default is not typed into a page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mk, DAY } from './helpers.js';
import { handle } from '../src/app.js';
import { stringLiterals } from './audit-round3.test.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rd = (f) => readFileSync(join(ROOT, f), 'utf8');
const files = (dir, exts) => readdirSync(join(ROOT, dir)).flatMap((f) => {
  const rel = `${dir}/${f}`;
  if (statSync(join(ROOT, rel)).isDirectory()) return files(rel, exts);
  return exts.some((e) => f.endsWith(e)) ? [rel] : [];
});
const click = async (h, user, siteId = 'tam') => {
  const l = await h.call('POST', '/v1/me/links', { key: user.key, body: { site_id: siteId, path: '/' } });
  const res = await handle(h.ctx, new Request(`https://pc.test${l.data.url}`, { headers: { 'cf-connecting-ip': '198.51.100.9' } }));
  return new URL(res.headers.get('location')).searchParams.get('pc');
};

// ---------------------------------------------------------------- the joining bonus is for a Growth Partner only
test('joining bonus: a Sales Manager with an approval moment gets none, a Growth Partner gets it, and the summary says none for the manager', async () => {
  const h = await mk({ realDefaults: true, payDays: [], joiningBonus: 50000 });
  const mgr = await h.staff('manager', 'Max');
  const pat = await h.staff('partner', 'Pat');
  assert.ok((await h.db.first('SELECT approved_at FROM users WHERE id=?', [mgr.id])).approved_at, 'the manager does have an approval moment, so only the role keeps the bonus away');
  const rm = await h.sale('tam', { order_id: 'm1', click_id: await click(h, mgr), amount_minor: 400000 });
  const rp = await h.sale('tam', { order_id: 'p1', click_id: await click(h, pat), amount_minor: 400000 });
  assert.equal(rm.data.bonus_minor, 0, 'staff on a salary plan do not get the Growth Partner bonus');
  assert.equal(rp.data.bonus_minor, 50000);
  assert.deepEqual((await h.db.all("SELECT account_id FROM ledger WHERE ref LIKE 'bonus:%'")).map((r) => r.account_id), [pat.id]);
  assert.equal((await h.call('GET', '/v1/me/summary', { key: mgr.key })).data.joining_bonus.state, 'none');
  assert.equal((await h.call('GET', '/v1/me/summary', { key: pat.key })).data.joining_bonus.state, 'earned');
});

// ---------------------------------------------------------------- an AI key cannot choose early approval
test('pay days: an AI key that sends early:true is still refused, nothing is approved and nothing is logged as approved', async () => {
  const h = await mk({ realDefaults: true, joiningBonus: 0 });
  const p = await h.staff('partner', 'Ann');
  await h.verifyUser(p);
  await h.sale('tam', { order_id: 'ai1', click_id: await click(h, p), amount_minor: 400000 });
  h.advance(8 * DAY);
  const po = (await h.call('POST', '/v1/me/payouts', { key: p.key })).data;
  const r = await h.call('POST', `/v1/admin/payouts/${po.id}/approve`, { key: h.ai, body: { early: true } });
  assert.equal(r.status, 403);
  assert.equal((await h.db.first('SELECT status FROM payouts WHERE id=?', [po.id])).status, 'pending_approval');
  assert.equal((await h.db.first("SELECT COUNT(*) AS n FROM audit_log WHERE action='payout.approve'")).n, 0);
});

// ---------------------------------------------------------------- the wording guard does not depend on the string reader alone
const POSSESSIVE = /\b(my|mine|your|yours)\b/i;
const ALLOWED = 'Copy this link and paste in your AI to work.';
/** Second net, independent of the string reader: every code line of every shipped script, with the one allowed sentence and comments removed. */
function rawHits(src) {
  const hits = [];
  let inBlock = false; // inside a /* ... */ comment that runs over several lines
  src.split("\n").forEach((line, n) => {
    let code = line.split(ALLOWED).join(' ');
    if (inBlock) {
      const e = code.indexOf('*/');
      if (e < 0) return;
      code = code.slice(e + 2); inBlock = false;
    }
    code = code.replace(/\/\*.*?\*\//g, ' ');
    const o = code.indexOf('/*');
    if (o >= 0) { code = code.slice(0, o); inBlock = true; }
    if (code.trim().startsWith('//')) return;
    code = code.replace(/(^|\s)\/\/(?!\/).*$/, '$1');
    if (POSSESSIVE.test(code)) hits.push(`${n + 1}: ${line.trim().slice(0, 90)}`);
  });
  return hits;
}
const SHIPPED = [...files('src', ['.js']), ...files('functions', ['.js']), 'public/js/app.js', 'public/embed.js'].filter((f) => !f.endsWith('payee.js') && !f.endsWith('version.js'));

test('wording: the string reader sees a possessive after a regex literal and inside a nested template', () => {
  const lit = (s) => stringLiterals(s).some((t) => POSSESSIVE.test(t));
  assert.ok(lit("const r = /a'b/; f('your team')"), 'a quote inside a regex does not hide the next string');
  assert.ok(lit('const a = `x ${ f(`y`) } your`;'), 'a template inside a template does not hide the text after it');
  assert.ok(lit("if (x) { y(); }\n/re/.test(z); f('my')"), 'a regex after a closing brace does not hide the next string');
  assert.ok(lit("const t = `a ${ b ? 'c' : 'd' } mine`"), 'a string inside a template placeholder does not hide the text after it');
  assert.ok(!lit("f('plain') // your comment"), 'a comment is still ignored');
});

test('wording: second net - no my, mine, your or yours in any code line of the shipped scripts, however the strings are read', () => {
  const found = [];
  for (const f of SHIPPED) for (const h of rawHits(rd(f))) found.push(`${f}:${h}`);
  assert.deepEqual(found, []);
});

test('wording: the second net really fails on a possessive', () => {
  assert.equal(rawHits("const a = 1;\nf('Send your key');\n// your comment\n/* my note\n   your note */ g('mine');").length, 2);
  assert.equal(rawHits("/* a\n   your b\n*/\nf(1)").length, 0, 'a possessive inside a comment over several lines is ignored');
  assert.equal(rawHits(`f('${ALLOWED}')`).length, 0);
});

// ---------------------------------------------------------------- no tick box in any UI file
test('no tick boxes: not in any script, page or style file under public', () => {
  const ui = files('public', ['.js', '.html', '.css']);
  assert.ok(ui.length >= 5);
  for (const f of ui) {
    const t = rd(f);
    assert.ok(!/checkbox/i.test(t), `${f} mentions a checkbox`);
    assert.ok(!/type\s*=\s*["']?checkbox/i.test(t), `${f} builds a checkbox`);
    assert.ok(!/setAttribute\(\s*['"]type['"]\s*,\s*['"](checkbox|radio)['"]/.test(t), `${f} sets a tick type`);
  }
});

// ---------------------------------------------------------------- the payee default is not typed into a page
test('the payee: the default name from the record appears in no shipped script, page or style', async () => {
  const h = await mk({ realDefaults: true });
  const name = (await h.call('GET', '/v1/public/brand')).data.payee_name;
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  assert.ok(norm(name).length >= 4);
  for (const f of [...files('src', ['.js']), ...files('functions', ['.js']), ...files('public', ['.html', '.js', '.css'])]) {
    assert.ok(!norm(rd(f)).includes(norm(name)), `${f} types the payee name instead of reading it from the record`);
  }
});
