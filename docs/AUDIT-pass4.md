# Audit pass 4 (commit 5f7b009) - VERDICT: FAIL

Ran: node --test test/suite.test.js (22/22 pass). Read-only otherwise.

## Pass-3 fixes verified
- Unclear answers stay pending (suite.js:289-290). HOLDS.
- Release checks sale 'recorded', reason in NO_CREDIT_REASONS, attempts<=1 (suite.js:326-330) for the plain path. sale_already_used and refunded sales are blocked. HOLDS, but see finding 1.
- Refund after release nets to zero (commission + reserve + release + void). Refund after sent flags and keeps entries (sales.js:205-221). HOLDS.
- Erase guard plus Monopoly-confirmed suspend (app.js:179-191). HOLDS.
- suite.write is owner-only; payouts mock by default; MNP_COMMISSION_ENABLED gate on the switch to moneypenny (suite.js:58-64); commission_dest default ledger; no console logging. HOLDS.

## Findings
1. MAJOR (double pay) suite.js:316 vs :329. requeuePosting resets attempts=0 on rejected or dead postings. The "single attempt" proof in releasePosting is then defeated. Scenario: attempt 1 times out (Moneypenny may have credited), retries reach 'dead' (outcome unknown, manual). Owner requeues, attempts=0. Next call answers no_rule with attempts=1, state rejected. releasePosting passes (attempts=1, NO_CREDIT reason, sale recorded) and returns the cash to the ledger/payout path while the earlier credit may exist. Same for a sale_already_used rejection followed by requeue and a different reason. Fix: keep a sticky "ever_unknown/ever_sent" flag, or never reset attempts, or block release when any earlier attempt existed (use the audit log or a new column). Add a test.
2. MINOR suite.js:226/:267 plus app.js:179. A rejected or pending claim whose sale is later refunded can never be released (sale_not_recorded) and never delivered (due query needs recorded). It stays in the 'open' set, so erase of that user is blocked permanently (posting_open) and the dashboard shows it as "on the way". Needs an owner "close/void" path for refunded sales (ledger already nets to zero).
3. MINOR suite.js:58. The MNP_COMMISSION_ENABLED gate only checks the transition. If commission_dest were already 'moneypenny' in the DB (migration, manual SQL) runPostings sends without the env flag. Also check the env in runPostings.
4. MINOR (carried) mp_postings DELETE on release plus unique ledger refs: re-claim silently fails, entry returns to cash path (intended). Moneypenny suspend is a no-op (documented). Erase check-then-act is not atomic with claims.

Auth scopes OK (AI keys cannot reach suite or payout routes). Engine text is clipped by clean(). No secrets logged.

Default FAIL on money: finding 1 must be fixed, with a new SHA and a clean pass.

## Builder response (after pass 4 FAIL)
Finding 1 fixed: requeue no longer resets attempts, so a dead (unknown-outcome) claim can never satisfy the release rule. Finding 3 fixed: claiming also requires MNP_COMMISSION_ENABLED=1. Finding 2 (void path for a claim whose sale was refunded; blocks erase) and the carried minors stay open for the owner. 132/132 tests. Needs two clean independent passes on the new SHA.
