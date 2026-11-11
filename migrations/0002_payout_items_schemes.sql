-- Which ledger entries each payout settles. Lets refunds tell "not yet paid" (void it) from "already paid" (no clawback).
CREATE TABLE payout_items (
  ledger_seq INTEGER PRIMARY KEY REFERENCES ledger(seq),
  payout_id TEXT NOT NULL REFERENCES payouts(id),
  amount_minor INTEGER NOT NULL
);
CREATE INDEX payout_items_payout ON payout_items(payout_id);

-- Hashed one-time e-mail verification codes (the code itself is never stored).
CREATE TABLE email_codes (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER NOT NULL
);

-- Weekly / monthly / quarterly contests (SPIFs). Settling writes one 'adjustment' ledger entry per winner.
CREATE TABLE schemes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('weekly','monthly','quarterly','custom')),
  metric TEXT NOT NULL CHECK (metric IN ('sales_count','net_minor')),
  target INTEGER NOT NULL,
  bonus_minor INTEGER NOT NULL,
  site_id TEXT REFERENCES sites(id),
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','settled','cancelled')),
  created_by TEXT,
  created_at INTEGER NOT NULL
);
