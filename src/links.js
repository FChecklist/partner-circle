// Personal links, discount codes, click tracking and lead capture.

import { HttpError, newId, randSlug, needStr, isInt, hostIsOwned, DAY, normEmail } from './util.js';
import { atomic, auditStmts } from './chain.js';
import { getPolicy } from './policy.js';

const CODE_RE = /^[A-Z0-9][A-Z0-9-]{2,23}$/;

export function safePath(p) {
  const path = p == null || p === '' ? '/' : String(p);
  if (!path.startsWith('/') || path.startsWith('//') || /[\\\s\u0000-\u001f]/.test(path) || path.length > 300) {
    throw new HttpError(422, 'invalid_field', 'path must start with a single "/" and contain no spaces or backslashes');
  }
  return path;
}

async function activeSite(ctx, siteId) {
  const site = await ctx.db.first('SELECT * FROM sites WHERE id=? AND active=1', [siteId]);
  if (!site) throw new HttpError(404, 'site_not_found', 'unknown or inactive site');
  return site;
}

export async function createLink(ctx, user, { site_id, path }) {
  if (user.status !== 'active') throw new HttpError(403, 'not_active', 'your account is not active yet');
  const site = await activeSite(ctx, site_id);
  const p = safePath(path);
  const existing = await ctx.db.first('SELECT * FROM links WHERE user_id=? AND site_id=? AND path=? AND active=1', [user.id, site.id, p]);
  if (existing) return linkView(site, existing);
  const id = newId('ln');
  const slug = randSlug(8);
  await atomic(ctx, async () => [
    { sql: 'INSERT INTO links (id,user_id,site_id,slug,path,active,created_at) VALUES (?,?,?,?,?,1,?)', params: [id, user.id, site.id, slug, p, ctx.now()] },
    ...(await auditStmts(ctx, [{ action: 'link.create', target: `link:${id}`, meta: { site_id: site.id, path: p } }])),
  ]);
  return linkView(site, { id, slug, path: p, site_id: site.id, created_at: ctx.now() });
}

const linkView = (site, l) => ({ id: l.id, site_id: site.id, site_name: site.name, path: l.path, slug: l.slug, url: `/r/${l.slug}`, created_at: l.created_at });

export async function listLinks(ctx, userId) {
  const rows = await ctx.db.all(
    `SELECT l.*, s.name AS site_name, (SELECT COUNT(*) FROM clicks c WHERE c.link_id = l.id) AS clicks
       FROM links l JOIN sites s ON s.id = l.site_id WHERE l.user_id=? AND l.active=1 ORDER BY l.created_at`, [userId]);
  return rows.map((l) => ({ id: l.id, site_id: l.site_id, site_name: l.site_name, path: l.path, slug: l.slug, url: `/r/${l.slug}`, clicks: l.clicks }));
}

/** Public redirect: log the click, then send the visitor to the site with ?pc=<click id> for the embed snippet to remember. */
export async function followLink(ctx, slug, ip) {
  const l = await ctx.db.first(
    `SELECT l.*, s.host, u.status AS user_status FROM links l JOIN sites s ON s.id = l.site_id AND s.active=1
       JOIN users u ON u.id = l.user_id WHERE l.slug=? AND l.active=1`, [slug]);
  if (!l) throw new HttpError(404, 'not_found', 'link not found');
  // Never redirect a visitor to a host the owner does not control, whatever the sites table says.
  if (!hostIsOwned(l.host, (await getPolicy(ctx)).owned_domains)) throw new HttpError(502, 'site_host_not_owned', 'this site is not on an owned domain; ask the owner');
  const clickId = newId('ck');
  const ipHash = ip ? await ctx.pepper(`${ip}|${Math.floor(ctx.now() / DAY)}`) : null;
  // Clicks are logged even for non-active partners (for the audit trail) but only active partners can earn from them.
  await ctx.db.run('INSERT INTO clicks (id,link_id,user_id,site_id,ts,ip_hash) VALUES (?,?,?,?,?,?)', [clickId, l.id, l.user_id, l.site_id, ctx.now(), ipHash]);
  const sep = l.path.includes('?') ? '&' : '?';
  return `https://${l.host}${l.path}${sep}pc=${clickId}`;
}

export async function resolveLink(ctx, site, slug) {
  const l = await ctx.db.first(
    `SELECT l.slug, l.path, l.site_id, u.handle, u.status FROM links l JOIN users u ON u.id = l.user_id WHERE l.slug=? AND l.active=1`, [slug]);
  if (!l || l.site_id !== site.id) throw new HttpError(404, 'not_found', 'link not found for this site');
  return { slug: l.slug, site_id: l.site_id, path: l.path, partner_handle: l.handle, partner_active: l.status === 'active' };
}

// ---- codes ----------------------------------------------------------------------------------------------------

export async function createCode(ctx, user, body, { asAdmin = false, forUserId } = {}) {
  const owner = asAdmin ? await ctx.db.first("SELECT * FROM users WHERE id=? AND status='active'", [forUserId]) : user;
  if (!owner) throw new HttpError(404, 'not_found', 'code owner not found or not active');
  if (owner.status !== 'active') throw new HttpError(403, 'not_active', 'your account is not active yet');
  if (owner.role === 'refer') throw new HttpError(403, 'not_allowed', 'Refer and Earn members share links only; discount codes are for partners and sales staff');
  const site = await activeSite(ctx, body.site_id);
  if (!site.discount_allowed) throw new HttpError(403, 'discount_not_allowed', `${site.name} does not allow discount codes`);
  const bps = body.discount_bps;
  if (!isInt(bps, 1, site.max_discount_bps)) throw new HttpError(422, 'discount_too_high', `discount_bps must be 1..${site.max_discount_bps} for ${site.name}`);
  const maxUses = body.max_uses ?? 3;
  if (!isInt(maxUses, 1, 1000)) throw new HttpError(422, 'invalid_field', 'max_uses must be 1..1000');
  const policy = await getPolicy(ctx);
  const count = (await ctx.db.first('SELECT COUNT(*) AS n FROM codes WHERE user_id=? AND active=1', [owner.id])).n;
  if (count >= policy.max_codes_per_user) throw new HttpError(409, 'too_many_codes', `limit of ${policy.max_codes_per_user} active codes reached`);
  let expires = body.expires_at ?? ctx.now() + policy.code_default_days * DAY;
  if (!isInt(expires, ctx.now() + 1)) throw new HttpError(422, 'invalid_field', 'expires_at must be in the future');
  let code = body.code ? String(body.code).toUpperCase().trim() : `${site.id.toUpperCase()}-${randSlug(5).toUpperCase()}`;
  if (!CODE_RE.test(code)) throw new HttpError(422, 'invalid_field', 'code must be 3-24 letters, digits or dashes');
  const id = newId('cd');
  try {
    await atomic(ctx, async () => [
      { sql: 'INSERT INTO codes (id,code,user_id,site_id,discount_bps,max_uses,used_count,expires_at,active,created_at) VALUES (?,?,?,?,?,?,0,?,1,?)',
        params: [id, code, owner.id, site.id, bps, maxUses, expires, ctx.now()] },
      ...(await auditStmts(ctx, [{ action: 'code.create', target: `code:${code}`, meta: { site_id: site.id, discount_bps: bps, max_uses: maxUses, for: owner.id } }])),
    ]);
  } catch (e) {
    if (/UNIQUE constraint failed: codes\.code/.test(String(e.message))) throw new HttpError(409, 'code_taken', 'that code already exists');
    throw e;
  }
  return codeView(await ctx.db.first('SELECT * FROM codes WHERE id=?', [id]));
}

const codeView = (c) => ({ code: c.code, site_id: c.site_id, discount_bps: c.discount_bps, max_uses: c.max_uses, used_count: c.used_count, expires_at: c.expires_at, active: !!c.active });

export async function listCodes(ctx, userId) {
  return (await ctx.db.all('SELECT * FROM codes WHERE user_id=? ORDER BY created_at DESC', [userId])).map(codeView);
}

export async function deactivateCode(ctx, code, ownerId) {
  const c = await ctx.db.first('SELECT * FROM codes WHERE code=?', [String(code).toUpperCase()]);
  if (!c || (ownerId && c.user_id !== ownerId)) throw new HttpError(404, 'not_found', 'code not found');
  await atomic(ctx, async () => [
    { sql: 'UPDATE codes SET active=0 WHERE id=?', params: [c.id] },
    ...(await auditStmts(ctx, [{ action: 'code.deactivate', target: `code:${c.code}` }])),
  ]);
  return { code: c.code, active: false };
}

/** Site-facing check before the buyer pays: is this code usable on this site, and what discount does it carry? */
export async function validateCode(ctx, site, rawCode) {
  const code = String(rawCode || '').toUpperCase().trim();
  const c = await ctx.db.first(
    `SELECT c.*, u.status AS user_status, u.handle FROM codes c JOIN users u ON u.id = c.user_id WHERE c.code=? AND c.site_id=?`, [code, site.id]);
  const bad = (reason) => ({ valid: false, reason });
  if (!c) return bad('unknown_code');
  if (!c.active) return bad('inactive');
  if (c.user_status !== 'active') return bad('partner_inactive');
  if (c.expires_at && c.expires_at < ctx.now()) return bad('expired');
  if (c.used_count >= c.max_uses) return bad('exhausted');
  if (!site.discount_allowed || c.discount_bps > site.max_discount_bps) return bad('discount_not_allowed');
  return { valid: true, code: c.code, discount_bps: c.discount_bps, partner_handle: c.handle, uses_left: c.max_uses - c.used_count };
}

// ---- leads ----------------------------------------------------------------------------------------------------

/** A sign-up on a site. Remembers who brought the person so a later sale (even without a click id) can be attributed. */
export async function recordLead(ctx, site, body) {
  const email = needStr(body.customer_email, 'customer_email', 254);
  const customerHash = await ctx.pepper(email);
  let userId = null;
  let source = null;
  let clickId = null;
  let code = null;
  const policy = await getPolicy(ctx);
  const windowMs = policy.attribution_window_days * DAY;
  if (body.code) {
    const v = await validateCodeNoUse(ctx, site, body.code);
    if (v) { userId = v.user_id; source = 'code'; code = v.code; }
  }
  if (!userId && body.click_id) {
    const c = await ctx.db.first('SELECT * FROM clicks WHERE id=? AND site_id=?', [String(body.click_id), site.id]);
    if (c && ctx.now() - c.ts <= windowMs) { userId = c.user_id; source = 'click'; clickId = c.id; }
  }
  if (!userId) return { recorded: false, attributed: false };
  const u = await ctx.db.first('SELECT email, email_hash, phone, status FROM users WHERE id=?', [userId]);
  const lastDigits = (v) => String(v || '').replace(/\D/g, '').slice(-10);
  const samePhone = u.phone && body.customer_phone && lastDigits(u.phone).length >= 8 && lastDigits(u.phone) === lastDigits(body.customer_phone);
  const sameMailbox = u.email && body.customer_email && (await ctx.pepper(normEmail(u.email))) === (await ctx.pepper(normEmail(body.customer_email)));
  if ((u.email_hash && u.email_hash === customerHash) || samePhone || sameMailbox) {
    await atomic(ctx, () => auditStmts({ ...ctx, actor: { type: 'site', id: site.id } }, [{ action: 'lead.blocked', target: `user:${userId}`, meta: { reason: 'self_referral', site_id: site.id } }]));
    return { recorded: false, attributed: false, blocked: 'self_referral' };
  }
  const id = newId('ld');
  const r = await ctx.db.run(
    'INSERT OR IGNORE INTO leads (id,site_id,user_id,source,click_id,code,customer_hash,lead_ref,ts) VALUES (?,?,?,?,?,?,?,?,?)',
    [id, site.id, userId, source, clickId, code, customerHash, body.lead_ref ? String(body.lead_ref).slice(0, 100) : null, ctx.now()]);
  return { recorded: r.changes === 1, attributed: true, source };
}

async function validateCodeNoUse(ctx, site, rawCode) {
  const v = await validateCode(ctx, site, rawCode);
  if (!v.valid) return null;
  return ctx.db.first('SELECT user_id, code FROM codes WHERE code=?', [v.code]);
}
