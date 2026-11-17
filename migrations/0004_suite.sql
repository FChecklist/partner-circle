-- 0004: suite front door (Partner Circle + Moneypenny + Corporate Monopoly). Additive only (no table rebuilds), safe on D1.

-- One row per deployment = one company (tenant). Isolation model: ONE DEPLOYMENT PER COMPANY (own D1 database, own keys), so there is no
-- cross-tenant query to get wrong. A shared tenant_id column is a separate owner decision (see docs/SUITE.md). Branding, wording and the
-- rate cards (the `sites` table: commission_bps, refer_bps, hold days) are therefore per company by construction.
CREATE TABLE tenant_profile (
  id TEXT PRIMARY KEY CHECK (id = 'self'),
  slug TEXT NOT NULL,
  product_name TEXT NOT NULL,
  accent TEXT NOT NULL DEFAULT '#0b6b57',
  logo_url TEXT,
  currency_label TEXT NOT NULL DEFAULT 'Moneypenny',
  credits_per_usd INTEGER NOT NULL DEFAULT 100,
  -- 'ledger' = commissions stay in Partner Circle and are paid by the owner-approved payout flow (today's policy).
  -- 'moneypenny' = matured commissions are posted to Moneypenny (bucket commission) and leave the payout flow. Never both.
  commission_dest TEXT NOT NULL DEFAULT 'ledger' CHECK (commission_dest IN ('ledger','moneypenny')),
  mnp_enabled INTEGER NOT NULL DEFAULT 1,   -- off-switch per engine
  mono_enabled INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
INSERT INTO tenant_profile (id, slug, product_name, updated_at) VALUES ('self', 'default', 'Partner Circle', 0);

-- Provisioning outbox: one row per person per engine. Retried with back-off; never blocks sign-up or approval.
CREATE TABLE engine_links (
  user_id TEXT NOT NULL REFERENCES users(id),
  engine TEXT NOT NULL CHECK (engine IN ('mnp','mono')),
  desired TEXT NOT NULL DEFAULT 'active' CHECK (desired IN ('active','suspended')),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','linked','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_try_at INTEGER NOT NULL DEFAULT 0,
  linked_at INTEGER,
  PRIMARY KEY (user_id, engine)
);

-- Last good copy of each dashboard block, for degraded mode (engine down: show the last known numbers, labelled). Display only; never used for a money decision.
CREATE TABLE engine_cache (
  user_id TEXT NOT NULL,
  block TEXT NOT NULL CHECK (block IN ('mnp','targets','achievements')),
  body TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, block)
);

-- A matured commission or override entry that was handed to Moneypenny. ledger_seq is the primary key and two triggers make a ledger entry
-- belong to AT MOST ONE of {a payout, a Moneypenny posting}: the database itself refuses a second claim.
CREATE TABLE mp_postings (
  ledger_seq INTEGER PRIMARY KEY REFERENCES ledger(seq),
  user_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  event_key TEXT NOT NULL UNIQUE,            -- the idempotency identity Moneypenny dedupes on
  sale_ref TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','posted','rejected','dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  gen INTEGER NOT NULL DEFAULT 0,            -- bumped when Moneypenny gave a definite "not granted" answer, so the retry uses a fresh Idempotency-Key (same event_key: still cannot pay twice)
  last_error TEXT,
  next_try_at INTEGER NOT NULL DEFAULT 0,
  granted_credits INTEGER,
  created_at INTEGER NOT NULL,
  posted_at INTEGER
);
CREATE INDEX mp_postings_state ON mp_postings(state, next_try_at);
CREATE INDEX mp_postings_user ON mp_postings(user_id);

CREATE TRIGGER mp_posting_not_in_payout BEFORE INSERT ON mp_postings
WHEN EXISTS (SELECT 1 FROM payout_items WHERE ledger_seq = NEW.ledger_seq)
BEGIN SELECT RAISE(ABORT, 'ledger entry already belongs to a payout'); END;

CREATE TRIGGER payout_item_not_in_mp BEFORE INSERT ON payout_items
WHEN EXISTS (SELECT 1 FROM mp_postings WHERE ledger_seq = NEW.ledger_seq)
BEGIN SELECT RAISE(ABORT, 'ledger entry already posted to Moneypenny'); END;
