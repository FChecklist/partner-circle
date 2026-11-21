-- 0005: a payout records that the provider was (maybe) contacted BEFORE the call, so an unknown outcome is never treated as "not sent".
ALTER TABLE payouts ADD COLUMN sent_at INTEGER;
ALTER TABLE payouts ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
