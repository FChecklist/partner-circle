// Local dev server: real API + static UI on one port, SQLite file in .data/ (no Cloudflare, no network, no paid service).
// Usage: node scripts/dev-server.mjs   (PORT=8788 by default). Secrets are generated once into .data/dev-secrets.json (git-ignored).
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname, normalize, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ROOT, openDb, seedSites } from './lib.mjs';
import { makeCtx } from '../src/ctx.js';
import { handle } from '../src/app.js';
import { createKey } from '../src/auth.js';
import { nullMailer, mockPayoutAdapter } from '../src/adapters.js';

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
const mailer = nullMailer();
const ctx = makeCtx({ db, env, mailer, payouts: mockPayoutAdapter() });

// First run: mint an owner key and an AI key into a git-ignored file. The keys are NOT printed.
const keysPath = join(DATA, 'dev-keys.json');
if (!(await db.first("SELECT 1 AS x FROM api_keys WHERE kind='owner'"))) {
  const owner = await createKey(ctx, { kind: 'owner', label: 'dev owner' });
  const ai = await createKey(ctx, { kind: 'ai', label: 'dev ai' });
  writeFileSync(keysPath, JSON.stringify({ owner: owner.token, ai: ai.token }, null, 2));
  console.log(`Dev owner and AI keys written to ${keysPath} (not printed).`);
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };
const PUB = join(ROOT, 'public');
// Send the same security headers Cloudflare Pages will apply from public/_headers (CSP included), so what works here works deployed.
const staticHeaders = (() => {
  const out = {};
  let inAll = false;
  for (const line of readFileSync(join(PUB, '_headers'), 'utf8').split(/\r?\n/)) {
    if (/^\S/.test(line)) { inAll = line.trim() === '/*'; continue; }
    const m = inAll && /^\s+([A-Za-z-]+):\s*(.+)$/.exec(line);
    if (m) out[m[1].toLowerCase()] = m[2].trim();
  }
  return out;
})();
const port = Number(process.env.PORT || 8788);

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${port}`);
    if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/r/')) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const headers = { ...req.headers, 'cf-connecting-ip': req.socket.remoteAddress || '' };
      if (url.pathname === '/v1/dev/outbox') { // dev only: read the mock mailbox (verification codes), loopback only
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(mailer.outbox.map((m) => ({ to: m.to, code: m._code })).slice(-20)));
      }
      const r = await handle(ctx, new Request(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }));
      res.writeHead(r.status, Object.fromEntries(r.headers));
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    if (url.pathname.startsWith('/dev/login/')) { // dev only (127.0.0.1): sign the browser in as a seeded key without ever printing it
      const who = url.pathname.slice('/dev/login/'.length);
      const all = { ...(existsSync(keysPath) ? JSON.parse(readFileSync(keysPath, 'utf8')) : {}), ...(existsSync(join(DATA, 'demo-keys.json')) ? JSON.parse(readFileSync(join(DATA, 'demo-keys.json'), 'utf8')) : {}) };
      if (!all[who]) { res.writeHead(404); return res.end('no such dev key'); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(`<script>sessionStorage.setItem('pc_key', ${JSON.stringify(all[who])});location.replace('/#/');</script>`);
    }
    const p = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const file = normalize(join(PUB, p));
    if (!file.startsWith(PUB + sep) || !existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { ...staticHeaders, 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(readFileSync(file));
  } catch (e) {
    console.error(e);
    res.writeHead(500); res.end('error');
  }
}).listen(port, '127.0.0.1', () => console.log(`Partner Circle dev server: http://127.0.0.1:${port}  (mock payouts, mock mail, SQLite in .data/)`));
