-- 0007: money-rule recheck against the owner decisions of 9, 14 and 17 Nov 2026. Additive only (ALTER ADD COLUMN, no table rebuilds), safe on D1.
-- Nothing here is applied to a real database by the builder: the owner applies it after the audits pass.

-- Split release for products with a money-back window (owner, 14 Nov 2026: 80% is paid at 7 days, the last 20% after the money-back days).
-- sites.early_release_bps = the share of each commission that becomes payable after buffer_days; the rest waits return_days + buffer_days.
-- 0 = no split (the whole commission waits return_days + buffer_days, as before). Always less than 10000.
ALTER TABLE sites ADD COLUMN early_release_bps INTEGER NOT NULL DEFAULT 0;
-- A sale remembers the split that applied on its day: a later change of the rate card affects future sales only.
ALTER TABLE sales ADD COLUMN early_release_bps INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sales ADD COLUMN early_eligible_at INTEGER;

-- Joining bonus (owner, 14 Nov 2026): paid with the first sale, gone if there is no first sale within the valid days of approval.
ALTER TABLE users ADD COLUMN approved_at INTEGER;

-- Pay days (owner, 14 Nov 2026: the 15th and the last day of the month). The day a payout becomes payable is fixed when it is requested.
ALTER TABLE payouts ADD COLUMN pay_on INTEGER;

-- The payee is read from this record and never written into the code or the pages (owner rule, 29 Oct and 16 Nov 2026).
ALTER TABLE tenant_profile ADD COLUMN payee_name TEXT NOT NULL DEFAULT 'IT Services by Rajat Agarwal';

-- Rows that already exist (nothing is deployed yet, so this only matters for a database seeded from an earlier build):
-- products with a money-back window get the owner's 80 / 20 split, and approved people get an approval moment.
UPDATE sites SET early_release_bps = 8000 WHERE return_days > 0 AND early_release_bps = 0;
UPDATE users SET approved_at = created_at WHERE status IN ('active','suspended') AND approved_at IS NULL;
