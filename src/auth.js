// API-key auth, scopes, rate limits and signed-webhook verification.
// Key token: "pck_<id>.<secret>". Only sha256(secret) is stored; the secret is shown once at creation.

import { HttpError, randHex, sha256Hex, hmacHex, timingSafeEqualStr } from './util.js';

/** Scopes only a human owner can hold. An AI key can never be minted with these (CONSTITUTION: AI proposes, owner approves). */
export const OWNER_ONLY_SCOPES = ['payouts.approve', 'kyc.verify', 'users.approve', 'keys.manage', 'policy.write', 'schemes.settle', 'schemes.activate'];
export const AI_SCOPES = ['admin.read', 'users.create', 'users.suspend', 'codes.write', 'schemes.write', 'sites.read'];
export const USER_SCOPES = ['me'];
export const SITE_SCOPES = ['integration'];

export async function createKey(ctx, { kind, user_id = null, site_id = null, label = null, scopes, rate_per_min = 120, created_by = null }) {
  if (!['owner', 'ai', 'user', 'site'].includes(kind)) throw new HttpError(422, 'invalid_field', 'kind');
  scopes = scopes || (kind === 'owner' ? ['*'] : kind === 'ai' ? AI_SCOPES : kind === 'user' ? USER_SCOPES : SITE_SCOPES);
  if (kind === 'ai') {
    const bad = scopes.filter((s) => !AI_SCOPES.includes(s));
    if (bad.length) throw new HttpError(422, 'scope_not_assignable', `AI keys cannot hold: ${bad.join(', ')}`);
  }
  if (!Array.isArray(scopes) || scopes.some((x) => typeof x !== 'string')) throw new HttpError(422, 'invalid_field', 'scopes must be an array of strings');
  if (kind === 'user' && scopes.some((x) => !USER_SCOPES.includes(x))) throw new HttpError(422, 'scope_not_assignable', 'user keys hold only: me');
  if (kind === 'site' && scopes.some((x) => !SITE_SCOPES.includes(x))) throw new HttpError(422, 'scope_not_assignable', 'site keys hold only: integration');
  if (!Number.isInteger(rate_per_min) || rate_per_min < 1 || rate_per_min > 6000) throw new HttpError(422, 'invalid_field', 'rate_per_min must be 1..6000');
  if (kind === 'owner' && !(scopes.length === 1 && scopes[0] === '*')) throw new HttpError(422, 'invalid_field', 'owner keys hold "*"');
  if (kind === 'user' && !user_id) throw new HttpError(422, 'invalid_field', 'user_id');
  if (kind === 'site' && !site_id) throw new HttpError(422, 'invalid_field', 'site_id');
  const id = randHex(6);
  const secret = randHex(24);
  const now = ctx.now();
  await ctx.db.run(
    'INSERT INTO api_keys (id,kind,user_id,site_id,label,hash,scopes,rate_per_min,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [id, kind, user_id, site_id, label, await sha256Hex(secret), JSON.stringify(scopes), rate_per_min, created_by, now],
  );
  return { id, token: `pck_${id}.${secret}`, kind, scopes };
}

export async function revokeKey(ctx, id) {
  const r = await ctx.db.run('UPDATE api_keys SET revoked_at=? WHERE id=? AND revoked_at IS NULL', [ctx.now(), id]);
  if (!r.changes) throw new HttpError(404, 'not_found', 'key not found or already revoked');
}

export async function rateLimit(ctx, bucket, limit, windowMs = 60000) {
  const win = Math.floor(ctx.now() / windowMs);
  const r = await ctx.db.first(
    'INSERT INTO rate_limits (bucket,win,n) VALUES (?,?,1) ON CONFLICT(bucket) DO UPDATE SET n = CASE WHEN win = excluded.win THEN n + 1 ELSE 1 END, win = excluded.win RETURNING n',
    [bucket, win],
  );
  if (r.n > limit) throw new HttpError(429, 'rate_limited', 'too many requests, slow down', { retry_after_s: Math.ceil(((win + 1) * windowMs - ctx.now()) / 1000) });
}

export function bearer(req) {
  const h = req.headers.get('authorization') || '';
  const m = /^Bearer\s+(pck_[0-9a-f]+\.[0-9a-f]+)$/i.exec(h);
  return m ? m[1] : null;
}

/** Resolve the actor for a request. Throws 401 when a token is given but invalid; returns null when none was given. */
export async function authenticate(ctx, req) {
  const token = bearer(req);
  if (!token) return null;
  const [idPart, secret] = token.slice(4).split('.');
  const key = await ctx.db.first('SELECT * FROM api_keys WHERE id=?', [idPart]);
  const ok = key && !key.revoked_at && timingSafeEqualStr(key.hash, await sha256Hex(secret));
  if (!ok) throw new HttpError(401, 'invalid_key', 'API key is invalid or revoked');
  await rateLimit(ctx, `key:${key.id}`, key.rate_per_min);
  await ctx.db.run('UPDATE api_keys SET last_used_at=? WHERE id=?', [ctx.now(), key.id]);
  const actor = { type: key.kind, keyId: key.id, id: key.user_id || key.site_id || null, scopes: JSON.parse(key.scopes) };
  if (key.kind === 'user') {
    const user = await ctx.db.first('SELECT * FROM users WHERE id=?', [key.user_id]);
    if (!user) throw new HttpError(401, 'invalid_key', 'key owner no longer exists');
    actor.user = user;
  }
  if (key.kind === 'site') {
    const site = await ctx.db.first('SELECT * FROM sites WHERE id=? AND active=1', [key.site_id]);
    if (!site) throw new HttpError(403, 'site_inactive', 'site is not active');
    actor.site = site;
  }
  return actor;
}

export const hasScope = (actor, scope) => !!actor && (actor.scopes.includes('*') || actor.scopes.includes(scope));

export function requireScope(actor, scope) {
  if (!actor) throw new HttpError(401, 'auth_required', 'API key required');
  if (!hasScope(actor, scope)) throw new HttpError(403, 'forbidden', `this key lacks the "${scope}" scope`);
}

export function requireKind(actor, ...kinds) {
  if (!actor) throw new HttpError(401, 'auth_required', 'API key required');
  if (!kinds.includes(actor.type)) throw new HttpError(403, 'forbidden', `needs a ${kinds.join(' or ')} key`);
}

// ---- signed site webhooks -------------------------------------------------------------------------------------

export const siteSecret = (ctx, site) => hmacHex(ctx.secret('SITE_SECRET_MASTER'), `site:${site.id}:${site.secret_version}`);

export const signBody = (secret, ts, body) => hmacHex(secret, `${ts}.${body}`);

/** Verify X-PC-Site / X-PC-Timestamp / X-PC-Signature (HMAC-SHA256 over "<ts>.<raw body>"), 5-minute replay window. */
export async function verifySiteSignature(ctx, req, rawBody) {
  const siteId = req.headers.get('x-pc-site');
  const ts = req.headers.get('x-pc-timestamp');
  const sig = req.headers.get('x-pc-signature');
  if (!siteId || !ts || !sig) throw new HttpError(401, 'signature_required', 'X-PC-Site, X-PC-Timestamp and X-PC-Signature are required');
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(ctx.now() - t) > 5 * 60000) throw new HttpError(401, 'stale_signature', 'timestamp outside the 5 minute window');
  const site = await ctx.db.first('SELECT * FROM sites WHERE id=? AND active=1', [siteId]);
  if (!site) throw new HttpError(401, 'invalid_signature', 'unknown site');
  const expect = await signBody(await siteSecret(ctx, site), ts, rawBody);
  if (!timingSafeEqualStr(expect, sig.toLowerCase())) throw new HttpError(401, 'invalid_signature', 'signature does not match');
  await rateLimit(ctx, `site:${site.id}`, 600);
  return site;
}
