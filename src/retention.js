// Data retention (DPDP). Cloudflare Pages Functions have no scheduler, so this runs when the owner or the AI master calls
// POST /v1/admin/maintenance/purge (a free cron-job service or the AI's own schedule can do that daily), and opportunistically
// a few times a day from normal traffic. It removes only data that has no money or audit value left:
//   clicks and prospect/lead records past their retention, idempotency keys > 7 days, expired e-mail codes, stale rate-limit counters.
// It never touches the ledger, the action log, sales, payouts or users (those are financial records; a person's personal details are
// removed separately by users.eraseUser once nothing is owed).

import { DAY } from './util.js';
import { getPolicy } from './policy.js';
import { atomic, auditStmts } from './chain.js';

export async function purgeExpired(ctx, { audit = true } = {}) {
  const policy = await getPolicy(ctx);
  const now = ctx.now();
  const del = async (sql, params) => (await ctx.db.run(sql, params)).changes;
  const out = {
    clicks: await del('DELETE FROM clicks WHERE ts < ?', [now - policy.click_retention_days * DAY]),
    leads: await del('DELETE FROM leads WHERE ts < ?', [now - policy.lead_retention_days * DAY]),
    idempotency: await del('DELETE FROM idempotency WHERE created_at < ?', [now - 7 * DAY]),
    email_codes: await del('DELETE FROM email_codes WHERE expires_at < ?', [now - DAY]),
    rate_limits: await del('DELETE FROM rate_limits WHERE ts IS NOT NULL AND ts < ?', [now - 2 * DAY]),
  };
  if (audit) await atomic(ctx, () => auditStmts(ctx, [{ action: 'maintenance.purge', target: 'retention', meta: out }]));
  return out;
}
