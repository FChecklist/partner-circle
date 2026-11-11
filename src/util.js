// Small shared helpers. Web-standard APIs only (runs unchanged on Cloudflare Workers and Node 24+).

export class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const enc = new TextEncoder();

export const toHex = (buf) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(s) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

export async function hmacHex(key, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}

export function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function randHex(bytes) {
  const u = new Uint8Array(bytes);
  crypto.getRandomValues(u);
  return toHex(u);
}

export const newId = (prefix) => `${prefix}_${randHex(8)}`;

const B32 = 'abcdefghjkmnpqrstuvwxyz23456789';
export function randSlug(n = 8) {
  const u = new Uint8Array(n);
  crypto.getRandomValues(u);
  return [...u].map((b) => B32[b % B32.length]).join('');
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function mask(s, keep = 4) {
  if (!s) return null;
  const t = String(s);
  return t.length <= keep ? '*'.repeat(t.length) : '*'.repeat(t.length - keep) + t.slice(-keep);
}

export function isInt(n, min = -Infinity, max = Infinity) {
  return Number.isSafeInteger(n) && n >= min && n <= max;
}

export function needStr(v, name, max = 200) {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new HttpError(422, 'invalid_field', `${name} is required (string, max ${max})`);
  return v.trim();
}

export const DAY = 86400000;

export function aesKey(secret) {
  return sha256Bytes(secret).then((b) => crypto.subtle.importKey('raw', b, 'AES-GCM', false, ['encrypt', 'decrypt']));
}
async function sha256Bytes(s) {
  return crypto.subtle.digest('SHA-256', enc.encode(s));
}
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** AES-GCM field encryption for KYC values. Output: "v1.<iv>.<ciphertext>" (base64). */
export async function encryptField(secret, plain) {
  if (plain == null || plain === '') return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(secret), enc.encode(String(plain))));
  return `v1.${b64(iv)}.${b64(ct)}`;
}
export async function decryptField(secret, packed) {
  if (!packed) return null;
  const [v, iv, ct] = String(packed).split('.');
  if (v !== 'v1') throw new Error('unknown field format');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await aesKey(secret), unb64(ct));
  return new TextDecoder().decode(pt);
}
