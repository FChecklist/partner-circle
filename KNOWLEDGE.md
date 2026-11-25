# Partner Circle: knowledge file

## Version
- Current version: **1.0.7** (see `public/version.json`, which lives in `public/` so the page footer can read it; shown in the page footer, and `CHANGELOG.md` for version notes).
- Rule (owner order, 21 Nov 2026): every product, site and page update carries a version number and version notes, saved in git. Bump `package.json`, `public/version.json` and add a `CHANGELOG.md` entry for every release.

## Where things are
- Money: `src/payouts.js`, `src/sales.js`, `src/chain.js` (hash-chained ledger and audit log). Suite front door: `src/suite.js`, `src/engines.js`.
- Handover and status: `docs/STATE.md`; open owner choices: `docs/OWNER-DECISIONS.md`; privacy: `docs/PRIVACY.md`; audits: PR comments and `docs/AUDIT-pass*.md`.
- Switches: `PAYOUT_MODE` (unset = mock, nothing real is paid), `MNP_COMMISSION_ENABLED=1` (commission to Moneypenny; off in v1), `ALLOW_OWNER_VOUCH=1` (emergency only).
- Tests: `npm test` (node 22). Build check: `npm run build`.

- Grievance contact (owner decision, 23 Nov 2026): shown as a plain line in the footer (`public/index.html`) and `public/privacy.html`; wording is gentle, no tick box. Change it in those two files and `docs/PRIVACY.md`.
- Payments (owner rule): money moves only via Moneypenny -> IT Services -> Razorpay. The direct RazorpayX code (`src/adapters.js`, `src/payouts.js`, `src/razorpay.js`) is OFF by default (PAYOUT_MODE unset = mock) and must not be switched on without an owner decision.
- Site signatures cover timestamp, method, path and body (1.0.6); Razorpay webhook dedupe uses the event type and entity id inside the signed body.
- Sign-up (owner rule v1.3, 23 Nov 2026): no checkbox and no accept button anywhere; only plain Terms and Privacy links. `releasedAtIST` is UTC plus 5h30m.
- Money rules rechecked 25 Nov 2026 (1.0.7): minimum 500 rupees; 80% after 7 days and the rest after 37 for money-back products (two ledger entries per commission, `-final` ref); pay days 15 and last day (`payouts.pay_on`, early approval needs `{early:true}` and is logged); joining bonus 500 rupees on the first sale within 30 days of approval (`bonus:<user>` ref, `users.approved_at`); team share off by default; payee name from `tenant_profile.payee_name`. Table and open questions: `docs/MONEY-RULES-RECHECK-2026-11-25.md`. Dashboard contract: `docs/DASHBOARD-OVER-MONEYPENNY-AND-MONOPOLY.md`.
- The test harness (`test/helpers.js`) keeps the older plain behaviour by default; tests of the 14 Nov rules open it with `{ realDefaults: true }`.
