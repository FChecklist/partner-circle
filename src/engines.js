// The two engines behind the front door: Moneypenny (credit ledger) and Corporate Monopoly (targets, achievements).
// Partner Circle talks to them ONLY from the server, signed, never from the browser, so a partner has one login (this one).
//
// Borders (see docs/SUITE.md):
//   Moneypenny  CONTRACT: C:\ct\moneypenny\contract\v1\openapi.json   (real; signing x-mnp-*)
//   Monopoly    CONTRACT: C:\ct\monopoly\CONTRACT\signed-v1.md        (real signing; per-person routes are PROPOSED, see docs/SUITE.md section 4)
//
// Defaults are honest: with no environment variables there is NO engine ("not connected"), never made-up numbers.
// mockMoneypenny() / mockMonopoly() are fakes that verify the real signing scheme; tests and `npm run dev -- --stub` use them.

import { HttpError, sha256Hex, hmacHex, randHex, timingSafeEqualStr } from './util.js';

/** An engine call failed. `definitive` = the engine understood and refused (nothing was changed there); otherwise the outcome is unknown and a retry with the same keys is safe. */
export class EngineError extends Error {
  constructor(code, message, { status = 0, definitive = false } = {}) {
    super(message);
    this.code = code; this.status = status; this.definitive = definitive;
  }
}

const TIMEOUT_MS = 2000;

async function send(fetchImpl, url, init, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: ac.signal, redirect: 'error' });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { res, data };
  } catch (e) {
    throw new EngineError('unreachable', e?.name === 'AbortError' ? 'engine did not answer in time' : 'engine could not be reached');
  } finally { clearTimeout(timer); }
}

function failFrom(res, data) {
  const code = data?.error?.code || `http_${res.status}`;
  // 4xx (except 401 clock/replay, timeout and rate-limit) means the engine read the request and refused it. 401 / 5xx / 408 / 429 mean "try again".
  const definitive = res.status >= 400 && res.status < 500 && ![401, 408, 429].includes(res.status);
  return new EngineError(code, String(data?.error?.message || `engine answered ${res.status}`).slice(0, 200), { status: res.status, definitive });
}

// ------------------------------------------------------------------ Moneypenny

// Six parts, per contract/v1/openapi.json x-signing: the sixth is the Idempotency-Key header (empty string when none, e.g. a GET).
export function mnpSign(secret, { ts, nonce, method, pathWithQuery, bodyHash, idem = '' }) {
  return hmacHex(secret, [ts, nonce, method, pathWithQuery, bodyHash, idem].join('\n'));
}

export function moneypennyClient({ baseUrl, keyId, secret, fetchImpl, now = () => Date.now(), timeoutMs = TIMEOUT_MS }) {
  if (!baseUrl || !keyId || !secret) throw new HttpError(500, 'server_misconfigured', 'Moneypenny settings are incomplete (MNP_BASE_URL, MNP_KEY_ID, MNP_SECRET)');
  if (!/^https:\/\//.test(baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(baseUrl)) throw new HttpError(500, 'server_misconfigured', 'MNP_BASE_URL must be https');
  const base = baseUrl.replace(/\/+$/, '');
  async function call(method, pathWithQuery, body, { idem, timeout = timeoutMs } = {}) {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const ts = String(now());
    const nonce = randHex(12);
    if (method !== 'GET' && !idem) throw new Error('every Moneypenny write needs an idempotency key');
    const idemH = idem ? String(idem).slice(0, 120) : '';
    const headers = {
      'x-mnp-key': keyId, 'x-mnp-timestamp': ts, 'x-mnp-nonce': nonce,
      'x-mnp-signature': await mnpSign(secret, { ts, nonce, method, pathWithQuery, bodyHash: await sha256Hex(raw), idem: idemH }),
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET') headers['idempotency-key'] = idemH;
    const { res, data } = await send(fetchImpl, base + pathWithQuery, { method, headers, body: body === undefined ? undefined : raw }, timeout);
    if (!res.ok || data?.ok === false) throw failFrom(res, data);
    return data;
  }
  const q = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return {
    name: 'moneypenny',
    /** Read the person's balance (and the real-money value). `degraded:true` from Moneypenny itself is passed on. */
    async balance(email) {
      const b = await call('GET', `/v1/balance?${q({ email })}`);
      let inrMinor = null;
      if (b.balance > 0) {
        try { inrMinor = (await call('GET', `/v1/quote?${q({ credits: b.balance })}`)).inr_minor ?? null; } catch { /* rupee value is optional */ }
      }
      return { credits: b.balance, can_convert: b.can_convert ?? 0, settling: b.settling ?? 0, conversion_enabled: !!b.conversion_enabled, fx_stale: !!b.fx_stale, degraded: !!b.degraded, inr_minor: inrMinor };
    },
    /** Pay one matured commission as a `commission` credit. Moneypenny dedupes on event_key and on the Idempotency-Key. */
    async postCommission({ email, event_key, cash_minor, sale_ref, payer_email, gen = 0 }) {
      const d = await call('POST', '/v1/event', { email, event_type: 'partner_commission', event_key, payer_email, cash_minor, currency: 'INR', sale_ref }, { idem: gen ? `${event_key}#${gen}` : event_key });
      return { granted: Math.max(0, Math.trunc(Number(d.granted)) || 0), reason: d.reason ? String(d.reason).slice(0, 60) : null }; // no reason is NOT a grant
    },
    /** A person asks to turn commission credits into cash. Moneypenny only records and calculates; a person approves there. Never cached. */
    async convertRequest({ email, credits, idem }) {
      const d = await call('POST', '/v1/convert_request', { email, credits }, { idem });
      return { request_id: d.request_id ?? d.id ?? null, status: d.status || 'requested' };
    },
    async health() { const d = await call('GET', '/health'); return { ok: !!d.ok }; },
  };
}

// ------------------------------------------------------------------ Corporate Monopoly

/** X-Signature = hex HMAC-SHA256(secret, `<ts>.<METHOD> <pathAndQuery>.<rawBody>`)  (CONTRACT/signed-v1.md) */
export const monoSign = (secret, ts, method, pathAndQuery, raw) => hmacHex(secret, `${ts}.${method} ${pathAndQuery}.${raw}`);

export function monopolyClient({ baseUrl, keyId, secret, fetchImpl, now = () => Date.now(), timeoutMs = TIMEOUT_MS }) {
  if (!baseUrl || !keyId || !secret) throw new HttpError(500, 'server_misconfigured', 'Monopoly settings are incomplete (MONO_BASE_URL, MONO_KEY_ID, MONO_SECRET)');
  if (!/^https:\/\//.test(baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(baseUrl)) throw new HttpError(500, 'server_misconfigured', 'MONO_BASE_URL must be https');
  const base = baseUrl.replace(/\/+$/, '');
  async function call(method, pathAndQuery, body) {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const ts = String(now());
    const headers = { 'x-key-id': keyId, 'x-timestamp': ts, 'x-signature': await monoSign(secret, ts, method, pathAndQuery, raw) };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const { res, data } = await send(fetchImpl, base + pathAndQuery, { method, headers, body: body === undefined ? undefined : raw }, timeoutMs);
    if (!res.ok || data?.ok === false) throw failFrom(res, data);
    return data;
  }
  const e = encodeURIComponent;
  return {
    name: 'monopoly',
    // PROPOSED routes (not in signed-v1 yet): Monopoly must add them before a company is marked live. See docs/SUITE.md section 4.
    async provision({ email, name, role, team_ref }) { return call('POST', '/api/v1/people', { work_email: email, name, role, team_ref: team_ref ?? null, source: 'partner_circle' }); },
    async suspend({ email }) { return call('POST', '/api/v1/people/suspend', { work_email: email }); },
    async targets(email) { return (await call('GET', `/api/v1/people/targets?email=${e(email)}`)).targets || []; },
    async achievements(email) { const d = await call('GET', `/api/v1/people/achievements?email=${e(email)}`); return { level: d.level ?? null, badges: d.badges || [] }; },
    async health() { await call('GET', '/api/health'); return { ok: true }; },
  };
}

// ------------------------------------------------------------------ choose from the environment

export function enginesFromEnv(env, fetchImpl) {
  const out = {};
  if (env.MNP_BASE_URL) out.mnp = moneypennyClient({ baseUrl: env.MNP_BASE_URL, keyId: env.MNP_KEY_ID, secret: env.MNP_SECRET, fetchImpl });
  if (env.MONO_BASE_URL) out.mono = monopolyClient({ baseUrl: env.MONO_BASE_URL, keyId: env.MONO_KEY_ID, secret: env.MONO_SECRET, fetchImpl });
  return out;
}

// ------------------------------------------------------------------ fakes that verify the REAL signing (tests, dev, contract tests)

/**
 * A fake Moneypenny with the real behaviour that matters at the border: signed calls only, replayed nonce refused, idempotency-key
 * and event_key dedupe, one sale_ref per commission, commission needs cash. `fail` lets a test make it down or slow.
 * Use it through fakeFetch(): it is a `fetch` replacement, so the REAL client code runs against it.
 */
export function mockMoneypenny({ keyId = 'mnpk_test', secret = 'mnp-secret-0123456789', credits = {}, rate = { cpu: 100, inrPerUsdMinor: 8300 } } = {}) {
  const st = { balances: { ...credits }, events: new Map(), idem: new Map(), saleRefs: new Set(), nonces: new Set(), calls: [], granted: [], down: false, rule: true, converts: [], conversion_enabled: true };
  const send = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const err = (status, code, message) => send(status, { ok: false, error: { code, message } });
  async function handle(url, init) {
    const u = new URL(url);
    const method = init.method || 'GET';
    const raw = init.body || '';
    const h = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    st.calls.push({ method, path: u.pathname + u.search, body: raw ? JSON.parse(raw) : null });
    if (st.down) return err(503, 'paused', 'switched off');
    if (u.pathname === '/health') return send(200, { ok: true });
    if (!h['x-mnp-key'] || !h['x-mnp-signature']) return err(401, 'unsigned', 'Signed headers are missing.');
    if (h['x-mnp-key'] !== keyId) return err(401, 'bad_signature', 'Signature not accepted.');
    const expect = await mnpSign(secret, { ts: h['x-mnp-timestamp'], nonce: h['x-mnp-nonce'], method, pathWithQuery: u.pathname + u.search, bodyHash: await sha256Hex(raw), idem: h['idempotency-key'] || '' });
    if (!timingSafeEqualStr(expect, String(h['x-mnp-signature']))) return err(401, 'bad_signature', 'Signature not accepted.');
    if (Math.abs(Date.now() - Number(h['x-mnp-timestamp'])) > 300000) return err(401, 'stale_timestamp', 'Timestamp is too old or too new.');
    if (st.nonces.has(h['x-mnp-nonce'])) return err(401, 'replayed', 'This request was already used.');
    st.nonces.add(h['x-mnp-nonce']);
    const body = raw ? JSON.parse(raw) : {};
    if (method !== 'GET' && !h['idempotency-key']) return err(400, 'idempotency_key_required', 'Send an Idempotency-Key header.');
    if (method !== 'GET') {
      const prev = st.idem.get(h['idempotency-key']);
      if (prev) return send(200, prev);
    }
    const remember = (data) => { if (method !== 'GET') st.idem.set(h['idempotency-key'], data); return send(200, data); };
    if (u.pathname === '/v1/balance') {
      const email = String(u.searchParams.get('email') || '').toLowerCase();
      if (!email.includes('@')) return err(400, 'bad_email', 'not a valid e-mail address');
      const n = st.balances[email] || 0;
      return send(200, { ok: true, balance: n, can_convert: Math.floor(n / 2), settling: 0, next_expiry: null, conversion_enabled: st.conversion_enabled, fx_stale: false });
    }
    if (u.pathname === '/v1/quote') {
      const c = Number(u.searchParams.get('credits'));
      return send(200, { ok: true, credits: c, usd_minor: Math.round((c * 100) / rate.cpu), inr_minor: Math.round((c * rate.inrPerUsdMinor) / rate.cpu) });
    }
    if (u.pathname === '/v1/event' && method === 'POST') {
      const email = String(body.email || '').toLowerCase();
      if (st.events.has(body.event_key)) return remember({ ok: true, granted: 0, reason: 'already_earned' });
      if (!body.sale_ref) return remember({ ok: true, granted: 0, reason: 'sale_ref_required' });
      if (!body.payer_email) return remember({ ok: true, granted: 0, reason: 'payer_required' });
      if (!(body.cash_minor > 0)) return remember({ ok: true, granted: 0, reason: 'no_cash_no_commission' });
      if (!st.rule) return remember({ ok: true, granted: 0, reason: 'no_rule' });
      if (st.saleRefs.has(body.sale_ref)) return remember({ ok: true, granted: 0, reason: 'sale_already_used' });
      const credits = Math.floor((body.cash_minor * rate.cpu) / rate.inrPerUsdMinor);
      st.events.set(body.event_key, credits); st.saleRefs.add(body.sale_ref);
      st.balances[email] = (st.balances[email] || 0) + credits;
      st.granted.push({ email, credits, event_key: body.event_key });
      return remember({ ok: true, granted: credits, reason: 'granted' });
    }
    if (u.pathname === '/v1/convert_request' && method === 'POST') {
      if (!st.conversion_enabled) return err(403, 'conversion_off', 'Conversion is not switched on.');
      const email = String(body.email || '').toLowerCase();
      if ((st.balances[email] || 0) < body.credits) return err(422, 'more_than_convertible', 'Only fewer credits can be converted now.');
      st.converts.push(body);
      return remember({ ok: true, request_id: `cv_${st.converts.length}`, status: 'requested' });
    }
    return err(404, 'not_found', 'No such route.');
  }
  return { state: st, fetch: (url, init = {}) => handle(url, init), keyId, secret };
}

/** A fake Corporate Monopoly following signed-v1 signing. */
export function mockMonopoly({ keyId = 'monok_test', secret = 'mono-secret-0123456789' } = {}) {
  const st = { people: new Map(), suspended: new Set(), targets: {}, achievements: {}, calls: [], down: false, seen: new Set() };
  const send = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  async function handle(url, init) {
    const u = new URL(url);
    const method = init.method || 'GET';
    const raw = init.body || '';
    const h = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    st.calls.push({ method, path: u.pathname + u.search, body: raw ? JSON.parse(raw) : null });
    if (st.down) return send(503, { ok: false, error: { code: 'paused', message: 'down' } });
    if (u.pathname === '/api/health') return send(200, { ok: true });
    if (h['x-key-id'] !== keyId) return send(401, { ok: false, error: { code: 'bad_key', message: 'key' } });
    const expect = await monoSign(secret, h['x-timestamp'], method, u.pathname + u.search, raw);
    if (!timingSafeEqualStr(expect, String(h['x-signature']))) return send(401, { ok: false, error: { code: 'bad_signature', message: 'signature' } });
    if (Math.abs(Date.now() - Number(h['x-timestamp'])) > 300000) return send(401, { ok: false, error: { code: 'stale', message: 'stale' } });
    if (st.seen.has(h['x-signature'])) return send(401, { ok: false, error: { code: 'replayed', message: 'replayed' } });
    st.seen.add(h['x-signature']);
    const body = raw ? JSON.parse(raw) : {};
    if (u.pathname === '/api/v1/people' && method === 'POST') { st.people.set(String(body.work_email).toLowerCase(), body); st.suspended.delete(String(body.work_email).toLowerCase()); return send(200, { ok: true, person_id: 'p_' + st.people.size }); }
    if (u.pathname === '/api/v1/people/suspend' && method === 'POST') { st.suspended.add(String(body.work_email).toLowerCase()); return send(200, { ok: true }); }
    const email = String(u.searchParams.get('email') || '').toLowerCase();
    if (u.pathname === '/api/v1/people/targets') return st.people.has(email) ? send(200, { ok: true, targets: st.targets[email] || [] }) : send(404, { ok: false, error: { code: 'unknown_person', message: 'no such person' } });
    if (u.pathname === '/api/v1/people/achievements') return st.people.has(email) ? send(200, { ok: true, ...(st.achievements[email] || { level: 1, badges: [] }) }) : send(404, { ok: false, error: { code: 'unknown_person', message: 'no such person' } });
    return send(404, { ok: false, error: { code: 'not_found', message: 'no route' } });
  }
  return { state: st, fetch: (url, init = {}) => handle(url, init), keyId, secret };
}

/** Build the two real clients on top of fakes (the real client code, the fake servers). */
export function stubEngines({ mnp = mockMoneypenny(), mono = mockMonopoly(), now } = {}) {
  return {
    mnp: moneypennyClient({ baseUrl: 'http://localhost:1', keyId: mnp.keyId, secret: mnp.secret, fetchImpl: mnp.fetch, now }),
    mono: monopolyClient({ baseUrl: 'http://localhost:2', keyId: mono.keyId, secret: mono.secret, fetchImpl: mono.fetch, now }),
    fakes: { mnp, mono },
  };
}
