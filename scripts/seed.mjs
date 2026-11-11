// Seed the LOCAL dev database (.data/dev.sqlite): the 9 sites always; with --demo, a sample organisation with fake
// people (@example.test), links, sales, a pending approval and a payout waiting for the owner.
// Keys for the seeded people are written to .data/demo-keys.json (git-ignored) and never printed.
//   node scripts/seed.mjs --demo
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ROOT, openDb, seedSites } from './lib.mjs';
import { makeCtx } from '../src/ctx.js';
import { handle } from '../src/app.js';
import { createKey, siteSecret, signBody } from '../src/auth.js';
import { hmacHex } from '../src/util.js';
import { nullMailer } from '../src/adapters.js';

const DATA = join(ROOT, '.data');
mkdirSync(DATA, { recursive: true });
const secretsPath = join(DATA, 'dev-secrets.json');
if (!existsSync(secretsPath)) {
  const r = () => randomBytes(24).toString('hex');
  writeFileSync(secretsPath, JSON.stringify({ PC_PEPPER: r(), SITE_SECRET_MASTER: r(), RAZORPAY_WEBHOOK_SECRET: r(), KYC_KEY: r() }, null, 2));
}
const env = JSON.parse(readFileSync(secretsPath, 'utf8'));
const { db } = openDb(join(DATA, 'dev.sqlite'));
if (!(await db.first('SELECT 1 AS x FROM sites LIMIT 1'))) await seedSites(db);
console.log('sites:', (await db.first('SELECT COUNT(*) AS n FROM sites')).n);
if (!process.argv.includes('--demo')) process.exit(0);

const mailer = nullMailer();
const realNow = Date.now();
let clock = realNow - 45 * 86400000;
const ctx = makeCtx({ db, env, mailer, now: () => clock });
const keysPath = join(DATA, 'dev-keys.json');
if (!existsSync(keysPath) || !(await db.first("SELECT 1 AS x FROM api_keys WHERE kind='owner'"))) {
  const owner = await createKey(ctx, { kind: 'owner', label: 'dev owner' });
  const ai = await createKey(ctx, { kind: 'ai', label: 'dev ai' });
  writeFileSync(keysPath, JSON.stringify({ owner: owner.token, ai: ai.token }, null, 2));
}
const ownerTok = JSON.parse(readFileSync(keysPath, 'utf8')).owner;

const call = async (method, path, { body, key, headers } = {}) => {
  const r = await handle(ctx, new Request(`http://seed.local${path}`, { method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }));
  const t = await r.text();
  if (r.status >= 400) throw new Error(`${method} ${path} -> ${r.status} ${t}`);
  return t ? JSON.parse(t) : null;
};
const keys = {};
const add = async (tag, role, name, parent) => {
  const r = await call('POST', '/v1/admin/users', { key: ownerTok, body: { role, name, email: `${tag}@example.test`, phone: '9876500000', parent_id: parent } });
  keys[tag] = r.api_key;
  return r.user.id;
};
const manager = await add('anita', 'manager', 'Anita Rao');
const leader = await add('ravi', 'leader', 'Ravi Menon', manager);
const exec1 = await add('sonal', 'exec', 'Sonal Gupta', leader);
const exec2 = await add('kabir', 'exec', 'Kabir Shah', leader);
const p1 = await add('imran', 'partner', 'Imran Qureshi', exec1);
await add('julie', 'partner', 'Julie Dsouza', exec1);
await add('neha', 'partner', 'Neha Iyer', exec2);
const refer = await call('POST', '/v1/register', { body: { role: 'refer', name: 'Rita Refer' } });
keys.rita = refer.api_key;
await call('POST', '/v1/register', { body: { role: 'partner', name: 'Tara Nair', email: 'tara@example.test', phone: '9876511111' } });

await call('POST', '/v1/me/email/send-code', { key: keys.imran });
await call('POST', '/v1/me/email/verify', { key: keys.imran, body: { code: mailer.outbox.at(-1)._code } });
await call('PUT', '/v1/me/kyc', { key: keys.imran, body: { pan: 'ABCDE1234F', upi_id: 'imran@okbank' } });
await call('POST', `/v1/admin/users/${p1}/kyc/review`, { key: ownerTok, body: { approve: true } });
await call('PUT', '/v1/admin/policy', { key: ownerTok, body: { min_payout_minor: 10000 } });
await call('POST', '/v1/me/codes', { key: keys.imran, body: { site_id: 'mom', discount_bps: 1000, code: 'IMRAN10', max_uses: 5 } });

const sale = async (siteId, fields) => {
  const body = { tax_minor: 0, ...fields };
  const raw = JSON.stringify(body);
  const site = await db.first('SELECT * FROM sites WHERE id=?', [siteId]);
  const sig = await signBody(await siteSecret(ctx, site), String(clock), raw);
  await call('POST', '/v1/integration/sales', { body, headers: { 'x-pc-site': siteId, 'x-pc-timestamp': String(clock), 'x-pc-signature': sig } });
  const evt = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: body.razorpay_payment_id, amount: body.amount_minor } } } });
  await handle(ctx, new Request('http://seed.local/v1/webhooks/razorpay', { method: 'POST', headers: { 'x-razorpay-signature': await hmacHex(env.RAZORPAY_WEBHOOK_SECRET, evt), 'x-razorpay-event-id': `evt_${body.razorpay_payment_id}` }, body: evt }));
};
for (const i of [1, 2, 3]) {
  const l = await call('POST', '/v1/me/links', { key: keys.imran, body: { site_id: 'mom', path: '/' } });
  const r = await handle(ctx, new Request(`http://seed.local${l.url}`, { headers: { 'cf-connecting-ip': `198.51.100.${i}` } }));
  const pc = new URL(r.headers.get('location')).searchParams.get('pc');
  await sale('mom', { order_id: `demo-${i}`, amount_minor: 99800 * i, click_id: pc, customer_email: `buyer${i}@example.test`, razorpay_payment_id: `pay_demo_${i}` });
  clock += 86400000;
}
await sale('tam', { order_id: 'demo-t1', amount_minor: 250000, customer_email: 'buyer9@example.test', razorpay_payment_id: 'pay_demo_t1' });
clock = realNow;
const po = await call('POST', '/v1/me/payouts', { key: keys.imran });
writeFileSync(join(DATA, 'demo-keys.json'), JSON.stringify(keys, null, 2));
console.log(`demo data ready: 9 people, 4 sales, payout ${po.id} waiting for the owner. Keys in .data/demo-keys.json (not printed).`);
