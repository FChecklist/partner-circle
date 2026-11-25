// Contract test: the examples in docs/DASHBOARD-OVER-MONEYPENNY-AND-MONOPOLY.md are compared, field by field and in both directions,
// with what GET /v1/me/dashboard really returns (stub engines stand in for Moneypenny and Monopoly). A field added to or removed from the code
// without the document, or the other way round, fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mk } from './helpers.js';
import { stubEngines } from '../src/engines.js';

const DOC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'DASHBOARD-OVER-MONEYPENNY-AND-MONOPOLY.md'), 'utf8');

function example(name) {
  const m = DOC.match(new RegExp(`<!-- contract:${name} -->\\s*\`\`\`json\\n([\\s\\S]*?)\\n\`\`\``));
  assert.ok(m, `the document has no example named ${name}`);
  return JSON.parse(m[1]);
}
/** path -> type of every field (arrays are described by their first element). null matches any type: a value that may be absent. */
function shape(v, prefix = '', out = new Map()) {
  if (Array.isArray(v)) { out.set(prefix, 'array'); if (v.length) shape(v[0], `${prefix}[]`, out); }
  else if (v && typeof v === 'object') { out.set(prefix, 'object'); for (const k of Object.keys(v)) shape(v[k], prefix ? `${prefix}.${k}` : k, out); }
  else out.set(prefix, v === null ? 'null' : typeof v);
  return out;
}
const same = (a, b) => a === b || a === 'null' || b === 'null';
/** Differences between the documented example and the real answer. `optional` paths may be missing from either side. */
function differences(doc, live, optional = []) {
  const d = shape(doc), l = shape(live), out = [];
  for (const [p, t] of d) if (!optional.includes(p) && !(l.has(p) && same(t, l.get(p)))) out.push(`documented but not in the answer (or another type): ${p}`);
  for (const [p, t] of l) if (!optional.includes(p) && !(d.has(p) && same(t, d.get(p)))) out.push(`in the answer but not documented (or another type): ${p}`);
  return out;
}
const withEngines = async () => { const e = stubEngines(); const h = await mk({ engines: { mnp: e.mnp, mono: e.mono } }); h.fakes = e.fakes; return h; };
const dash = async (h, u) => (await h.call('GET', '/v1/me/dashboard', { key: u.key })).data;
const OPTIONAL_LIVE = ['moneypenny.lines.settling']; // only present when some credits are still settling

test('contract: the live example in the document has exactly the fields the real dashboard returns', async () => {
  const h = await withEngines();
  const p = await h.staff('partner', 'Dash');
  await h.verifyUser(p);
  h.fakes.mnp.state.balances[p.email] = 1250;
  h.fakes.mono.state.targets[p.email] = [{ name: 'Sell 5 licences', period: 'monthly', unit: 'sales', goal: 5, progress: 2, ends_at: 1796000000000 }];
  h.fakes.mono.state.achievements[p.email] = { level: 3, badges: [{ name: 'First sale', earned_at: 1793000000000 }] };
  const live = await dash(h, p);
  assert.equal(live.moneypenny.status, 'live');
  assert.equal(live.monopoly.status, 'live');
  assert.deepEqual(differences(example('dashboard-live'), live, OPTIONAL_LIVE), []);
});

test('contract: the "engines down" example in the document has exactly the fields returned when nothing can be fetched', async () => {
  const h = await withEngines();
  h.fakes.mnp.state.down = true;
  h.fakes.mono.state.down = true;
  const p = await h.staff('partner', 'Down');
  await h.verifyUser(p);
  const live = await dash(h, p);
  assert.equal(live.moneypenny.status, 'unavailable');
  assert.equal(live.monopoly.status, 'unavailable');
  assert.deepEqual(differences(example('dashboard-down'), live), []);
  assert.ok(live.notes.length >= 2, 'one soft line per block that is not live');
});

test('contract: the comparison really catches drift (a field added to the answer, or one the answer lost, is reported)', () => {
  const doc = example('dashboard-live');
  const extra = JSON.parse(JSON.stringify(doc));
  extra.commissions.surprise_minor = 5;
  assert.deepEqual(differences(doc, extra), ['in the answer but not documented (or another type): commissions.surprise_minor']);
  const lost = JSON.parse(JSON.stringify(doc));
  delete lost.moneypenny.credits;
  assert.deepEqual(differences(doc, lost), ['documented but not in the answer (or another type): moneypenny.credits']);
  const retyped = JSON.parse(JSON.stringify(doc));
  retyped.moneypenny.credits = '1250';
  assert.equal(differences(doc, retyped).length, 2);
});

test('contract: every block status, both routes and the engine calls are written in the document', () => {
  for (const s of ['live', 'stale', 'unavailable', 'setting_up', 'not_connected', 'off', 'verify_email']) assert.match(DOC, new RegExp(`\\| \`${s}\` \\|`), `status ${s}`);
  for (const r of ['GET /v1/me/dashboard', 'POST /v1/me/moneypenny/convert-request']) assert.ok(DOC.includes(r), r);
  for (const c of ['/v1/balance', '/v1/quote', '/v1/convert_request', '/v1/event', '/api/v1/people', '/api/v1/people/targets', '/api/v1/people/achievements']) assert.ok(DOC.includes(c), c);
});

test('contract: Monopoly cannot touch pay: the Commissions block is the same whatever Monopoly says', async () => {
  const h = await withEngines();
  const p = await h.staff('partner', 'Pay');
  await h.verifyUser(p);
  h.fakes.mnp.state.balances[p.email] = 500;
  const before = (await dash(h, p)).commissions;
  h.fakes.mono.state.targets[p.email] = [{ name: 'Penalty: lose all pay', period: 'monthly', unit: 'sales', goal: 99, progress: 0 }];
  h.fakes.mono.state.achievements[p.email] = { level: 0, badges: [] };
  h.advance(2 * 60000);
  const after = await dash(h, p);
  assert.deepEqual(after.commissions, before);
  assert.equal((await h.db.first('SELECT COUNT(*) AS n FROM ledger')).n, 0, 'nothing was written to the ledger');
});
