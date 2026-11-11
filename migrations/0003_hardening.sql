-- 0003: closes the findings of the 10-11 Nov independent review. Additive only (no table rebuilds), so it is safe to run on D1.

-- One Razorpay payment confirms exactly one sale. (Replaces the plain index from 0001.)
DROP INDEX IF EXISTS sales_payment;
CREATE UNIQUE INDEX sales_payment_uq ON sales(razorpay_payment_id) WHERE razorpay_payment_id IS NOT NULL;

-- The old name said "after maturity"; it has always meant "refunded after the commission was sent in a payout".
ALTER TABLE sales RENAME COLUMN refund_after_maturity TO refund_after_payout;

-- Claims / chargebacks hold the money until resolved. NULL = no claim, open = on hold, won = cleared, lost = refunded.
ALTER TABLE sales ADD COLUMN dispute_status TEXT;
ALTER TABLE sales ADD COLUMN dispute_note TEXT;
ALTER TABLE sales ADD COLUMN disputed_at INTEGER;
-- What the site told us when it refunded: did the buyer really use the product (owner rule: refund only real users)?
ALTER TABLE sales ADD COLUMN usage_verified INTEGER;
ALTER TABLE sales ADD COLUMN refund_reason TEXT;

-- The payout destination is frozen (encrypted) when the payout is requested, so a later KYC edit cannot redirect it.
ALTER TABLE payouts ADD COLUMN dest_enc TEXT;
ALTER TABLE payouts ADD COLUMN provider_mode TEXT;
-- A payout the provider reversed after it was marked paid: status becomes 'failed', funds go back to the partner, and this is set.
ALTER TABLE payouts ADD COLUMN reversed_at INTEGER;

-- Site hosts are guesses until the owner confirms them; unconfirmed sites seed inactive. refund_terms is shown to buyers before payment.
ALTER TABLE sites ADD COLUMN host_confirmed INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sites ADD COLUMN refund_terms TEXT;

ALTER TABLE users ADD COLUMN erased_at INTEGER;
ALTER TABLE rate_limits ADD COLUMN ts INTEGER;

-- Incremental chain verification: the last verified row and its hash.
CREATE TABLE chain_checkpoints (
  chain TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  hash TEXT NOT NULL,
  verified_at INTEGER NOT NULL
);

CREATE INDEX clicks_ts ON clicks(ts);
CREATE INDEX leads_ts ON leads(ts);
CREATE INDEX audit_ts ON audit_log(ts);
