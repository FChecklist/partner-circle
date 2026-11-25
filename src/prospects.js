// Registered prospects (deal registration).
// A partner tells us "I am working with this person". The prospect is protected for policy.deal_protection_days against
// other partners' clicks, and is the lead that a later sale (even with no click id) is attributed to.

import { HttpError, newId, needStr, DAY, normEmail } from './util.js';

const MAX_PROSPECTS = 50; // per partner: a harvested e-mail list cannot be registered wholesale
import { atomic, auditStmts } from './chain.js';
import { getPolicy } from './policy.js';
import { rateLimit } from './auth.js';

export async function registerProspect(ctx, user, body) {
  if (user.status !== 'active') throw new HttpError(403, 'not_active', 'the account is not active yet');
  if (user.role === 'refer') throw new HttpError(403, 'not_allowed', 'prospect registration is for partners and sales staff');
  const site = await ctx.db.first('SELECT * FROM sites WHERE id=? AND active=1', [body.site_id]);
  if (!site) throw new HttpError(404, 'site_not_found', 'unknown or inactive site');
  const email = needStr(body.customer_email, 'customer_email', 254);
  const hash = await ctx.pepper(email);
  if ((user.email_hash && user.email_hash === hash) || (user.email && (await ctx.pepper(normEmail(user.email))) === (await ctx.pepper(normEmail(email))))) throw new HttpError(422, 'self_referral', 'you cannot register yourself');
  const policy = await getPolicy(ctx);
  // every attempt counts, whether or not the e-mail turns out to be held by someone else (no free probing)
  await rateLimit(ctx, `prospect:${user.id}`, 100, 3600000);
  const live = (await ctx.db.first("SELECT COUNT(*) AS n FROM leads WHERE user_id=? AND source='registered' AND ts > ?", [user.id, ctx.now() - policy.deal_protection_days * DAY])).n;
  if (live >= MAX_PROSPECTS) {
    throw new HttpError(429, 'prospect_limit', `you can hold up to ${MAX_PROSPECTS} protected prospects at a time; each is protected for ${policy.deal_protection_days} days, then frees a place`);
  }
  const existing = await ctx.db.first('SELECT * FROM leads WHERE site_id=? AND customer_hash=?', [site.id, hash]);
  if (existing) {
    if (existing.user_id === user.id) return { id: existing.id, site_id: site.id, already_yours: true, registered_at: existing.ts };
    return heldElsewhere(site, ctx, policy); // same answer as a fresh registration: no one can probe who holds an e-mail
  }
  const id = newId('ld');
  const r = await ctx.db.run(
    "INSERT OR IGNORE INTO leads (id,site_id,user_id,source,click_id,code,customer_hash,lead_ref,ts) VALUES (?,?,?,'registered',NULL,NULL,?,?,?)",
    [id, site.id, user.id, hash, body.note ? String(body.note).slice(0, 100) : null, ctx.now()],
  );
  if (r.changes !== 1) return heldElsewhere(site, ctx, policy);
  await atomic(ctx, () => auditStmts(ctx, [{ action: 'prospect.register', target: `lead:${id}`, meta: { site_id: site.id } }]));
  return { id, site_id: site.id, registered_at: ctx.now(), protected_until: ctx.now() + policy.deal_protection_days * DAY };
}

// Identical in shape to a fresh registration (fake id included), so the answer does not reveal whether someone else holds the e-mail.
const heldElsewhere = (site, ctx, policy) => ({ id: newId('ld'), site_id: site.id, registered_at: ctx.now(), protected_until: ctx.now() + policy.deal_protection_days * DAY });

export async function listProspects(ctx, userId) {
  return ctx.db.all("SELECT id, site_id, ts AS registered_at, lead_ref AS note FROM leads WHERE user_id=? AND source='registered' ORDER BY ts DESC LIMIT 100", [userId]);
}
