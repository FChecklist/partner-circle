-- Partner Circle schema (SQLite / Cloudflare D1). All money is integer paise (INR minor units).

CREATE TABLE sites (
  id TEXT PRIMARY KEY,
  host TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  return_days INTEGER NOT NULL,          -- refund / usage window of the product (30 Veridian+PROJEXA, 0 games+Townhall)
  buffer_days INTEGER NOT NULL DEFAULT 7,
  commission_bps INTEGER NOT NULL,       -- growth-partner commission on net sale
  refer_bps INTEGER NOT NULL DEFAULT 0,  -- Refer and Earn reward on net sale
  discount_allowed INTEGER NOT NULL DEFAULT 0,
  max_discount_bps INTEGER NOT NULL DEFAULT 0,
  secret_version INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('refer','partner','exec','leader','manager')),
  name TEXT,
  handle TEXT UNIQUE,
  email TEXT,
  email_hash TEXT,
  phone TEXT,
  country TEXT NOT NULL DEFAULT 'IN',
  parent_id TEXT REFERENCES users(id),
  email_verified INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('pending','active','suspended')),
  created_at INTEGER NOT NULL
);
CREATE INDEX users_parent ON users(parent_id);
CREATE UNIQUE INDEX users_email_uq ON users(email_hash) WHERE email_hash IS NOT NULL;

CREATE TABLE user_kyc (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  country TEXT NOT NULL DEFAULT 'IN',
  pan TEXT, upi_id TEXT,
  tax_id TEXT, bank_account TEXT, bank_ifsc_swift TEXT, bank_name TEXT,
  status TEXT NOT NULL DEFAULT 'none' CHECK (status IN ('none','submitted','verified','rejected')),
  submitted_at INTEGER, verified_by TEXT, verified_at INTEGER
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('owner','ai','user','site')),
  user_id TEXT REFERENCES users(id),
  site_id TEXT REFERENCES sites(id),
  label TEXT,
  hash TEXT NOT NULL,                    -- sha256 of the secret half; the secret is shown once and never stored
  scopes TEXT NOT NULL,                  -- JSON array
  rate_per_min INTEGER NOT NULL DEFAULT 120,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_used_at INTEGER
);

CREATE TABLE links (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  site_id TEXT NOT NULL REFERENCES sites(id),
  slug TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL DEFAULT '/',
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE codes (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id),
  site_id TEXT NOT NULL REFERENCES sites(id),
  discount_bps INTEGER NOT NULL,
  max_uses INTEGER NOT NULL,
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE clicks (
  id TEXT PRIMARY KEY,
  link_id TEXT NOT NULL REFERENCES links(id),
  user_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  ip_hash TEXT
);
CREATE INDEX clicks_user_ts ON clicks(user_id, ts);

CREATE TABLE leads (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source TEXT NOT NULL,
  click_id TEXT,
  code TEXT,
  customer_hash TEXT NOT NULL,
  lead_ref TEXT,
  ts INTEGER NOT NULL,
  UNIQUE (site_id, customer_hash)
);

CREATE TABLE sales (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  order_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  tax_minor INTEGER NOT NULL DEFAULT 0,
  net_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  paid_at INTEGER NOT NULL,
  hold_days INTEGER NOT NULL,
  eligible_at INTEGER NOT NULL,
  user_id TEXT,
  attribution TEXT NOT NULL,             -- code | click | lead | none
  click_id TEXT,
  code TEXT,
  customer_hash TEXT,
  razorpay_payment_id TEXT,
  razorpay_order_id TEXT,
  rzp_status TEXT NOT NULL DEFAULT 'pending' CHECK (rzp_status IN ('pending','confirmed','mismatch')),
  status TEXT NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','refunded','blocked')),
  block_reason TEXT,
  refund_after_maturity INTEGER NOT NULL DEFAULT 0,
  refunded_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (site_id, order_id)
);
CREATE INDEX sales_user ON sales(user_id, paid_at);
CREATE INDEX sales_payment ON sales(razorpay_payment_id);

CREATE TABLE razorpay_events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payment_id TEXT,
  order_id TEXT,
  amount_minor INTEGER,
  ts INTEGER NOT NULL
);
CREATE INDEX rzp_payment ON razorpay_events(payment_id);

CREATE TABLE payouts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  gross_minor INTEGER NOT NULL,
  tds_bps INTEGER NOT NULL DEFAULT 0,
  tds_minor INTEGER NOT NULL DEFAULT 0,
  net_minor INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending_approval','approved','processing','paid','rejected','failed')),
  requested_by_key TEXT NOT NULL,
  approved_by_key TEXT,
  approved_at INTEGER,
  method TEXT,
  destination_masked TEXT,
  provider TEXT,
  provider_ref TEXT,
  paid_ref TEXT,
  paid_at INTEGER,
  note TEXT,
  created_at INTEGER NOT NULL
);
-- at most one open payout per account: stops two simultaneous requests reserving the same balance
CREATE UNIQUE INDEX one_open_payout ON payouts(user_id) WHERE status IN ('pending_approval','approved','processing');

-- Append-only, hash-chained ledger. seq is the PRIMARY KEY so concurrent writers cannot fork the chain.
CREATE TABLE ledger (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  ts INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('commission','override','void','payout_reserve','payout_release','adjustment')),
  amount_minor INTEGER NOT NULL,
  sale_id TEXT,
  payout_id TEXT,
  eligible_at INTEGER NOT NULL,
  ref TEXT NOT NULL UNIQUE,
  memo TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX ledger_account ON ledger(account_id, eligible_at);
CREATE INDEX ledger_sale ON ledger(sale_id);
CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger BEGIN SELECT RAISE(ABORT,'ledger is append-only'); END;
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT,'ledger is append-only'); END;

CREATE TABLE audit_log (
  seq INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  key_id TEXT,
  action TEXT NOT NULL,
  target TEXT,
  meta TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX audit_actor ON audit_log(actor_id, ts);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT,'audit_log is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT,'audit_log is append-only'); END;

CREATE TABLE policy (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE idempotency (
  scope TEXT PRIMARY KEY,
  req_hash TEXT NOT NULL,
  status INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE rate_limits (bucket TEXT PRIMARY KEY, win INTEGER NOT NULL, n INTEGER NOT NULL);
