# Audit pass 3 (commit 7a208db) - VERDICT: FAIL

Ran: node --test test/suite.test.js (21/21 pass). Read-only otherwise.

## Pass-2 fixes verified
- Unclear answers (no reason, or granted with 0) stay pending, never posted (suite.js runPostings). HOLDS.
- Rejected claim release exists (releasePosting, owner-only, suite.write in OWNER_ONLY_SCOPES). Works for the plain case. See finding 1.
- Erase: guards open postings (pending/rejected/dead) and requires Monopoly confirmed suspend (app.js:179-191). HOLDS (fail-closed).
- Moneypenny suspend is honest (recorded as no_remote_suspend, suite.js syncUser). HOLDS.
- sent_at set before call; applyRefund voids only untouched claims, flags the rest. Ledger nets to zero. HOLDS.
- Payouts off by default (mock adapter unless PAYOUT_MODE); MNP commission needs MNP_COMMISSION_ENABLED=1; no console logging in src.

## Findings
1. MAJOR suite.js releasePosting (~L275): does not check the sale. A rejected claim has sent_at set, so a later refund only flags it and keeps the commission entry. Release then adds +amount (payout_release) while the commission is not voided. Result: ledger_total exceeds available+pending (the double-entry self-check in payouts.js balances() breaks), and a refunded sale carries phantom positive balance. Not payable today (AVAILABLE requires sale recorded) but any future reader of ledger total over-pays. Fix: refuse release if sale not 'recorded' (or void on release).
2. MAJOR suite.js ~L229 plus releasePosting: every non-transient reason string (for example sale_already_used, no_rule) becomes 'rejected' and is treated as "definitely not credited". sale_already_used means Moneypenny already holds a credit for that sale_ref. Owner release returns the amount to the cash payout path, so the same commission can be paid in cash and as credits (double pay). Fix: treat sale_already_used as manual review, never releasable; show reason before release.
3. MAJOR suite.js catch (~L232) / releasePosting: a definitive 4xx on a retry after an earlier unknown-outcome attempt (timeout) marks rejected and releasable, though attempt 1 may have credited. releasePosting does not check attempts>1 or prior unknown. Fix: track "ever unknown" flag; block release then.
4. MINOR ledger.ref is UNIQUE: after release, a re-claim cannot insert ref mpclaim:<seq> (and mprelease:<seq>), the UNIQUE error is swallowed by the claim loop. Entry silently returns to the payout path under commission_dest=moneypenny; that breaks the "one place" promise silently. Use a gen suffix in refs.
5. MINOR Re-claim after release reuses event_key and gen=0, so Moneypenny's remembered Idempotency-Key replays the old rejection.
6. MINOR app.js erase: check-then-erase is not atomic with a concurrent claim (MATURED checks erased_at, but the window exists between guard and eraseUser).
7. MINOR Moneypenny suspend is a no-op: a suspended partner's already-granted credits remain convertible (documented, but owner-visible warning absent).

Auth scopes: suite.write owner-only OK; AI keys cannot reach suite/payout routes. Untrusted engine text is whitelisted/clipped (clean/norm*). No secrets logged.

Default FAIL on money: findings 1-3 must be fixed.

## Builder response (after pass 3 FAIL)
Findings 1-3 fixed: release now needs a single attempt, a provable "nothing granted" reason (no_rule, sale_ref_required, payer_required, no_cash_no_commission) and a still-recorded sale; sale_already_used, retried claims and refunded sales go to manual review. Finding 4: a released entry cannot be re-claimed (unique ledger ref), so it returns to the normal payout path, which is the intent. 5-7 noted: minor, open. Test added; 131/131. Needs a new SHA and two clean independent passes.
