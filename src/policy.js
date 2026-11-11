// Editable policy. Values below are SAMPLE defaults chosen to be safe; the owner changes them via
// PUT /v1/admin/policy. Rates and the TDS figure are placeholders pending the owner and a CA.

import { DAY, isHostname } from './util.js';

export const POLICY_DEFAULTS = {
  attribution_window_days: 30,
  min_payout_minor: 100000, // Rs 1,000
  // override on net sale, paid to each ACTIVE upline member by their role (basis points). Sample values.
  override_bps: { exec: 100, leader: 75, manager: 50 },
  max_codes_per_user: 20,
  code_default_days: 30,
  deal_protection_days: 14,
  scheme_hold_days: 37,
  // Tax deducted at payout (India Sec 194H etc.) is recorded per payout; default 0 until a CA confirms the rate.
  tds_bps_default: 0,
  // Owner flips this once a CA has confirmed the TDS rate; until then the approval queue shows a warning on every payout.
  tds_confirmed: false,
  // The eligibility clock may start at most this many days before we heard about the sale, so a site cannot shorten the hold.
  max_backdate_days: 1,
  click_retention_days: 180,
  lead_retention_days: 365,
  // Partner links may only redirect to these domains (and their subdomains).
  owned_domains: ['veridian-aios.com', 'projexa-ai.com', 'corporatetambola.com', 'townhall-records.com'],
};

/** Validators for PUT /v1/admin/policy. Anything not listed here cannot be set. */
export const POLICY_VALIDATORS = {
  attribution_window_days: (v) => Number.isInteger(v) && v >= 1 && v <= 180,
  min_payout_minor: (v) => Number.isInteger(v) && v >= 0 && v <= 10000000,
  override_bps: (v) => v && typeof v === 'object' && ['exec', 'leader', 'manager'].every((k) => Number.isInteger(v[k]) && v[k] >= 0 && v[k] <= 2000) && Object.keys(v).length === 3,
  max_codes_per_user: (v) => Number.isInteger(v) && v >= 0 && v <= 200,
  deal_protection_days: (v) => Number.isInteger(v) && v >= 0 && v <= 90,
  code_default_days: (v) => Number.isInteger(v) && v >= 1 && v <= 365,
  scheme_hold_days: (v) => Number.isInteger(v) && v >= 0 && v <= 120,
  tds_bps_default: (v) => Number.isInteger(v) && v >= 0 && v <= 3000,
  tds_confirmed: (v) => typeof v === 'boolean',
  max_backdate_days: (v) => Number.isInteger(v) && v >= 0 && v <= 7,
  click_retention_days: (v) => Number.isInteger(v) && v >= 30 && v <= 1095,
  lead_retention_days: (v) => Number.isInteger(v) && v >= 30 && v <= 1095,
  owned_domains: (v) => Array.isArray(v) && v.length >= 1 && v.length <= 20 && v.every(isHostname),
};

export async function getPolicy(ctx) {
  const rows = await ctx.db.all('SELECT key, value FROM policy');
  const p = { ...POLICY_DEFAULTS };
  for (const r of rows) {
    try { p[r.key] = JSON.parse(r.value); } catch { /* ignore corrupt row, keep default */ }
  }
  return p;
}

/** Days between payment and commission becoming payable: product return window + buffer. */
export const holdDays = (site) => site.return_days + site.buffer_days;
export const eligibleAt = (paidAt, site) => paidAt + holdDays(site) * DAY;

/**
 * Seed values: games/Townhall have no return window (7 days total); Veridian products and PROJEXA have 30 (+7 = 37).
 * `confirmed` = the host appears in the owner's own domain map (2 Nov 2026). The others are best guesses, so they seed INACTIVE
 * and the owner switches them on after confirming the host (PATCH /v1/admin/sites/:id {host, host_confirmed:1, active:1}).
 * The two Townhall products from the demo used elections./meetings.townhall.com, which is not an owner domain; they now sit under
 * townhall-records.com until the owner says otherwise.
 */
export const DEFAULT_SITES = [
  { id: 'dpdp', host: 'dpdp.veridian-aios.com', name: 'DPDP Compliance', confirmed: 1, return_days: 30, commission_bps: 1500, refer_bps: 500, discount_allowed: 1, max_discount_bps: 1000 },
  { id: 'mom', host: 'mom.veridian-aios.com', name: 'MOM (Minutes of Meeting)', confirmed: 0, return_days: 30, commission_bps: 1500, refer_bps: 500, discount_allowed: 1, max_discount_bps: 1000 },
  { id: 'aios', host: 'veridian-aios.com', name: 'Veridian AI OS', confirmed: 1, return_days: 30, commission_bps: 1000, refer_bps: 300, discount_allowed: 0, max_discount_bps: 0 },
  { id: 'projexa', host: 'projexa-ai.com', name: 'PROJEXA', confirmed: 1, return_days: 30, commission_bps: 1000, refer_bps: 300, discount_allowed: 0, max_discount_bps: 0 },
  { id: 'tam', host: 'home.corporatetambola.com', name: 'Corporate Tambola', confirmed: 1, return_days: 0, commission_bps: 1200, refer_bps: 400, discount_allowed: 1, max_discount_bps: 500 },
  { id: 'voter', host: 'voterlist.townhall-records.com', name: 'Voter List', confirmed: 0, return_days: 0, commission_bps: 1000, refer_bps: 300, discount_allowed: 0, max_discount_bps: 0 },
  { id: 'th', host: 'townhall-records.com', name: 'Townhall Records', confirmed: 1, return_days: 0, commission_bps: 1000, refer_bps: 300, discount_allowed: 0, max_discount_bps: 0 },
  { id: 'el', host: 'elections.townhall-records.com', name: 'Elections', confirmed: 0, return_days: 0, commission_bps: 1000, refer_bps: 300, discount_allowed: 1, max_discount_bps: 500 },
  { id: 'mt', host: 'meetings.townhall-records.com', name: 'Meetings', confirmed: 0, return_days: 0, commission_bps: 1000, refer_bps: 300, discount_allowed: 0, max_discount_bps: 0 },
];

export function seedSiteStmts(now) {
  return DEFAULT_SITES.map((s) => ({
    sql: 'INSERT OR IGNORE INTO sites (id,host,name,return_days,buffer_days,commission_bps,refer_bps,discount_allowed,max_discount_bps,active,host_confirmed,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    params: [s.id, s.host, s.name, s.return_days, 7, s.commission_bps, s.refer_bps, s.discount_allowed, s.max_discount_bps, s.confirmed, s.confirmed, now],
  }));
}

/** Default text shown to buyers before they pay, until the owner writes site-specific terms. */
export const defaultRefundTerms = (site) =>
  site.return_days > 0
    ? `You pay the full price up front and have ${site.return_days} days to use the product. A refund is given only if you have genuinely used it during that time (draft wording: the owner and a consumer-law adviser must approve the final text).`
    : 'Refunds follow the terms shown at checkout for this product (draft wording: the owner must approve the final text).';
