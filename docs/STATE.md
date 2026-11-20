# Partner Circle: state and handover (19 Nov 2026)

Branch `feat/partner-circle-v1`, local only (no remote; a public repo needs Rajat's typed yes). Nothing deployed. Builder: this session. **Audits: none yet. An independent auditor must do two passes in a row; default FAIL if unsure on money, security or data.**

## What exists
- Base product (earlier commits): partners, links, sales, hash-chained ledger and audit log, payouts (owner approval), schemes, prospects, embed snippet, web UI, D1 adapter.
- Suite front door (commit dd674c5 and after): `src/engines.js` (signed Moneypenny + Monopoly clients, fakes that verify the real signing), `src/suite.js` (tenant profile, provisioning outbox, dashboard with 45 s cache and degraded mode, convert request, commission posting), `src/openapi.js` (OpenAPI from live routes), `migrations/0004_suite.sql`, dashboard and Suite console in `public/js/app.js`, `docs/SUITE.md`, `docs/openapi.json`.

## Owner rulings in force
- Payouts: default mock adapter; owner approves every payout; live only after owner go via IT Services Razorpay.
- Commission to Moneypenny: OFF in v1 (`commission_dest='ledger'`); v2 item. Moneypenny needs a purchase-key payment notice first; override credits unsupported.
- Monopoly per-person routes: contract-only until Monopoly passes two audits. Dashboard shows "setting up" meanwhile.
- Tenancy: one deployment per company (shared `tenant_id` is an open owner decision).
- No new public repo, no paid steps, no deploy before audits.

## Tests
`npm test` (node 22). New: `test/suite.test.js` (16 tests: both borders, provisioning, dashboard degraded mode, no-double-pay triggers, refunds, convert request, tenant, AI readiness). Heavy runs on the partner laptop (`C:\dev\pcrun.ps1`, lock `C:\dev\HEAVY.lock`, log `C:\dev\pc-test.log`).

## Auditor: look hardest at
1. `src/suite.js` runPostings and `migrations/0004_suite.sql` triggers (one claim per ledger entry) and the refund path in `src/sales.js` applyRefund.
2. Engine text handling (untrusted fields) and the AI header and `_untrusted` addition in `src/app.js`.
3. `suite.write` owner-only scope; `PUT /v1/admin/tenant` validation (logo https only, accent, names).
4. Ledger self-check and both hash chains with the new `payout_reserve` entries that have no payout id.
5. Known gaps: no cron on free Pages (postings and provisioning retry only on dashboard load or owner sweep); Moneypenny balance read uses a spend-class key (read key would be tighter); no per-tenant data separation beyond one-deployment-per-company; the new dashboard widgets and Suite console have NOT been opened in a browser (a syntax slip in app.js was found and fixed by the build check; look at them with `npm run dev -- --stub`).

## Before go-live (all need the owner)
Two clean audits; Moneypenny live check with test tenant keys (`MNP_*` secrets, masked); Monopoly routes and keys; migration 0004 on D1; Rajat's yes for any repo.

## Update 21 Nov 2026: audit pass 1 = FAIL, fixes applied (needs pass 2 by a fresh auditor)
Fixed: Moneypenny signature now six-part incl. Idempotency-Key (pinned test vector); 401 retryable; `sent_at` marks "may exist at Moneypenny" so refunds flag, never void, a contacted claim; claim re-checked inside the atomic builder; `updateProfile` uses `Object.hasOwn`, refuses mnp off while commission goes to Moneypenny; dashboard backfills engine links; KYC gate on Moneypenny postings; erase refused while a posting is open, engine link/cache rows purged; convert button reuses one Idempotency-Key per render; engine error codes sanitised.
Note for v2: money going via Moneypenny skips the payout flow, so TDS and KYC rules must be re-checked then. Commission to Moneypenny stays OFF. Full local suite 126/126; laptop re-run still to do. Nothing deployed, no remote.

## Update: audit pass 2 = FAIL (4 majors) fixed
1 no-reason/zero-grant answers never mark "posted" (pending, retry same key). 2 commission to Moneypenny needs server switch MNP_COMMISSION_ENABLED=1 (off in v1); owner route POST /v1/admin/suite/postings/:seq/release returns a definitely rejected claim to the ledger. 3 erase refused until Monopoly confirms removal. 4 Moneypenny suspend is recorded as no_remote_suspend (no remote call exists). Minors: redirect:'error', hashed convert idem key. 130/130 tests. Needs two independent clean audits on the exact SHA.
