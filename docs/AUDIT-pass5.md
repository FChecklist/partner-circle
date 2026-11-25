# Audit pass 5 (commit 9288dd5) - VERDICT: FAIL

Ran node --test test/suite.test.js: 23/23 pass. Read-only otherwise.
Note: the coordinator withdrew the "owner accepted" list, so the three carried items are graded on merit below.

## Pass-4 fixes verified
- requeuePosting no longer resets attempts (suite.js:316); release needs attempts<=1 (suite.js:329). HOLDS for the normal path.
- Claim needs MNP_COMMISSION_ENABLED=1 at claim time (suite.js:240). HOLDS. Delivery of already-claimed rows ignores the flag by design.
- Ledger identity holds: claim (+commission, -reserve) is excluded from available and pending; after release the entry returns once. payouts off by default (mock unless PAYOUT_MODE), commission_dest default ledger, suite.write owner-only, no secrets logged (only console.error 'unhandled' in app.js:473).

## Findings
1. MAJOR (double pay) suite.js:273-297 vs :329. sent_at is committed BEFORE the call but attempts is only saved AFTER it. If the worker dies or is killed between the call and the result write, attempts stays 0 and sent_at is set; Moneypenny may have credited. The next run makes attempt "1"; a no_rule or similar answer then gives attempts=1 and state rejected, and release passes. Cash returns to the payout path while a credit may exist. Fix: write attempts=attempts+1 in the same batch as sent_at, or refuse release when sent_at is set and the audit log shows an earlier moneypenny.send.
2. MAJOR (money race) suite.js:330-338. Sale status is checked outside atomic(); the builder only re-checks the posting row. A refund landing between them flags the claim (sent_at set, no void) and release then adds +amount with the commission not voided: ledger_total exceeds available+pending and a refunded sale carries a positive balance. Re-check s.status='recorded' inside the builder.
3. MINOR->MAJOR on merit (no void path for a refunded-sale claim). suite.js:226/267, app.js:179. Such a claim is stuck in pending/rejected, counted "on the way" in the dashboard (suite.js:188) and blocks erase forever. Money is not lost (ledger nets to zero), but it is a data/compliance dead end (right-to-erasure blocked). Grade MAJOR for data: add an owner close/void action for rows whose sale is refunded.
4. MINOR erase not atomic (app.js:179-191). A claim can land between the guard and eraseUser; MATURED excludes erased users only after the erase. Effect: an orphan claim for an erased user, never delivered (email null). Low money risk; fix by re-checking inside eraseUser's batch.
5. MINOR Moneypenny suspend is a no-op (suite.js:100-102). A suspended or erased partner keeps already-granted credits, which stay convertible; audit records no_remote_suspend but the owner gets no visible warning. Acceptable only with an owner-facing warning; add one.
6. MINOR ledger.ref unique: a released entry cannot be re-claimed; it silently returns to the cash path (intended, but unannounced).

Auth: AI keys cannot reach suite or payout routes; engine text is whitelisted and clipped via clean().

Verdict: FAIL. Findings 1 and 2 are money defects and need fixes, with a new SHA and a clean pass.

## Builder response (after pass 5 FAIL)
Fixed: (1) attempts is bumped in the same batch as sent_at, before the Moneypenny call, so a crash mid-call still counts and release is refused. (2) release re-checks the sale and claim state inside the batch builder and confirms the row is gone afterwards. Open item "no void path": a claim whose sale is no longer recorded no longer blocks erase and no longer shows as "on the way" (ledger already nets to zero). Known limits for the owner (minor): erase guard not atomic with a concurrent claim; Moneypenny has no suspend call, so granted credits stay convertible after a suspend (owner sees no warning yet). 133/133 tests. Needs two clean independent passes on the new SHA.
