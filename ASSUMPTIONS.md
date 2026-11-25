# Assumptions, decisions and open items

Sources: owner policy memory (9 Nov 2026, "payout policy" and "72h plan" item 5), the demo at `review-sites/partner`, and
`docs/PARTNER-PORTAL-RESEARCH.md`. Where the owner has not decided, a **safe, editable default** is used and listed here.
Every rate / limit below can be changed by the owner at runtime (`PUT /v1/admin/policy`, `PATCH /v1/admin/sites/:id`); changes
affect future sales only.

## Owner rules implemented as written

| Rule | Where it lives |
|---|---|
| Independent product, integrated by API; sites need no change beyond one signed server call | `docs/INTEGRATION.md`, `src/app.js` |
| Customers pay 100% up front; 30-day usage period; refund only for real users | the site decides and calls `/refunds`; `usage_verified` is recorded in the action log |
| Partner is paid 7 days after payment for games / Townhall (0 + 7). Money-back products (Veridian, PROJEXA, DPDP, MOM): 80% after 7 days, the last 20% after 37 days (30 money-back days + 7 buffer; the owner's note said 30, see docs/MONEY-RULES-RECHECK-2026-11-25.md question 1) | `sites.return_days`, `sites.buffer_days`, `sites.early_release_bps`; two ledger entries per commission, `eligible_at = paid_at + hold` for the last part |
| Pay only when the sale is real **and** Razorpay confirmed the payment | `sales.rzp_status` must be `confirmed` before any commission is "available" |
| No clawback after payout; "pay late instead" | refund after the commission was swept into a payout keeps the payout and flags the sale (`refund_after_maturity` column = "refunded after payout") for the owner |
| Complete ledger; each payout and partner has its own trail | append-only hash-chained `ledger` + `audit_log` (DB triggers block UPDATE/DELETE; `/v1/admin/verify` re-hashes everything) |
| AI operates the system, owner only approves | AI keys cannot hold `payouts.approve kyc.verify users.approve keys.manage policy.write schemes.settle schemes.activate`; AI-created staff are `pending` |
| Partner verification at first payout: e-mail + PAN + UPI (India); abroad tax/ID + bank | `PUT /v1/me/kyc`, encrypted (AES-GCM, key `KYC_KEY`), shown masked, owner verifies |
| All payouts only by the payee on record (IT Services by Rajat Agarwal) through Razorpay | the name lives in `tenant_profile.payee_name` and is filled into the pages from `/v1/public/brand`, never written into code; the payout adapter is RazorpayX only and OFF unless `PAYOUT_MODE` is set; no other payee exists in code |
| Refer and Earn: no e-mail to start sharing; verification before first payout | role `refer`: active at once, links only, e-mail + KYC enforced at payout request |
| E-mail only through the existing Resend free-limit setup, never `tina@` | `resendMailer` is the only mail path and is off unless `RESEND_API_KEY` + `MAIL_FROM` are set |
| Discount codes only where policy allows | `sites.discount_allowed`, `max_discount_bps`; refer members cannot create codes |

## Decisions I made (flag any you disagree with)

1. **Rates are samples, except Corporate Tambola.** Corporate Tambola is 25% for a Growth Partner and 25% for Refer and Earn (owner, 14 Nov 2026). Other products: commission 10-15%, refer reward 3-5%, max discount 10% on DPDP and MOM, no discount codes on the games and Townhall products. **Team share (override) is OFF (0%) until the owner decides yes or no and how much**; when switched on it is paid to Executive / Team Leader / Manager on a downline sale. Copied from the demo, which labels them "sample". Commission is on **net of tax** (`amount - tax`), after any discount.
2. **Sales staff earn per-sale commission at the same site rate as a partner** when the sale is theirs; the upline overrides come on top. Salary, monthly target pay and accelerators from the demo are **not modelled** (HR/payroll, not a partner-commission function). Schemes (weekly / monthly / quarterly bonuses) are.
3. **Attribution order:** discount code > registered prospect (14-day protection) > click id (30-day window) > earlier sign-up. First match wins; one partner per sale.
4. **Self-referral** = buyer's e-mail hash equals the partner's own. Blocked sales are recorded with a reason and no commission. (Same-device / same-card checks need data the sites do not send.)
5. **Minimum payout 500 rupees** (owner, 14 Nov 2026), payouts on the 15th and the last day of the month (a payout asked for earlier waits, and the owner can approve it early on purpose, which is logged), a joining bonus of 500 rupees with the first sale if it is paid within 30 days of approval, one open payout per partner at a time, one payout sweeps *all* currently available entries (no partial amounts).
6. **TDS** is stored per payout as `tds_bps` (default 0%) and deducted from the amount sent. Whether Sec 194H applies, the rate, thresholds, PAN-less higher rate, GST on partner invoices and withholding for foreign payees are **CA questions** (owner's own instruction). Nothing here is tax advice.
7. **INR only.** A sale in another currency is rejected (422). Foreign partners are paid in INR value or by hand (see below).
8. **Non-India payees:** RazorpayX pays Indian UPI / IMPS only, so for a non-India partner `approve` records the payout as `processing` with provider `manual`; the owner pays by bank transfer outside the API and records it with `POST /v1/admin/payouts/:id/mark-paid {reference}`.
9. **A refund processed by Razorpay in full** (`refund.processed`) is applied automatically; a **partial** refund is only flagged (`sale.partial_refund_review`) because the commission give-back is a human call.
10. **Customer e-mails are never stored.** Only `HMAC-SHA256(PC_PEPPER, lower(email))`. Raw IPs are never stored either (daily-salted hash for click de-dup stats). Partner e-mail / phone are stored (needed to contact and pay them) and shown masked.
11. **Ledger integrity is tamper-evident, not tamper-proof.** Anyone with raw database control can drop the triggers and rebuild the chain consistently. For stronger assurance export `GET /v1/admin/verify` head hashes to an external place on a schedule (not implemented).
12. **Concurrency:** ledger writes re-read the chain tail inside an optimistic retry (25 tries with jitter) and queue within an isolate; this is correct but sized for tens of writes per second, not thousands.
13. **Login = API key.** No passwords and no sessions to steal; the key is shown once. A lost key means the owner mints a new one. Magic-link login by e-mail is a possible later step (needs Resend live).

## Not done / needs the owner (honest list)

- **Nothing is deployed.** Migration `0003_hardening.sql` is additive (ALTER ADD / RENAME COLUMN, one new table, one unique index) and was only replayed on `node:sqlite`; apply it to a copy of the real D1 first. If production already has two sales sharing a payment id the unique index will refuse to build - resolve those by hand. No Cloudflare, D1, Pages, Resend, Razorpay or RazorpayX call has ever been made. The Cloudflare path is tested against a faithful in-memory D1 fake, not against Cloudflare itself.
- **Live payouts** are off by design (`PAYOUT_MODE` unset = mock). The RazorpayX adapter is written to the documented Payouts API shape and tested with an injected fake `fetch`; it has never talked to Razorpay. Needs the owner's RazorpayX account, an account number, the webhook secret, and a deliberate `PAYOUT_MODE=live`.
- **RazorpayX request/response shape and webhook payloads** (including `payment.dispute.*`) are written from the public docs and tested against fakes only. Razorpay has no sandbox host: test vs live is decided by the key prefix, and the adapter now refuses `PAYOUT_MODE=test` with a live key (and the reverse). Run one real Rs 1 test-mode payout and replay one real event of each kind before go-live.
- **Razorpay webhook field names** (`payment.captured`, `refund.processed`, `payout.*`) follow the public docs from memory of the payload shape; verify with a real test-mode event before go-live.
- **CA decisions** (item 6), partner agreement wording, the partner-facing refund-condition text shown to buyers, and consumer-law review.
- **Rates, discount maxima, minimum payout, override %** need the owner's final numbers (item 1, 5).
- **Salary / target / incentive for Manager, Team Leader, Executive** (demo screens) are not built (item 2).
- **E-mail**: with no mailer configured the verification endpoint now answers 503 `mail_not_configured` instead of pretending to send; the owner can mark an address verified by hand (`POST /v1/admin/users/:id/verify-email`, logged) so payouts are never blocked on mail. Approval / payout / cancellation notifications are sent best-effort to verified addresses only; they have never been sent through a real Resend account.
- **Site list needs the owner's confirmation.** The brief said 8 sites, 9 are seeded (PROJEXA is in the owner's own domain map). Five hosts are live from the start (dpdp, aios, projexa, tam, th). Four (mom, voter, el, mt) are seeded INACTIVE with `host_confirmed=0`; `elections.` and `meetings.townhall.com` were replaced by `townhall-records.com` sub-domains, which are guesses. A site can only go live after the owner confirms its host (`PATCH /v1/admin/sites/:id`), and redirects only go to hosts on the owned-domain list in policy.
- **Wiring the 8 sites**: each site must add the one signed server call and the script tag (`docs/INTEGRATION.md`); that is a change in those repos and was not made here.
- **UI polish / accessibility pass** and a mobile-device test; no automated browser tests. The CSP-compatible styling and the new owner screens (payouts tab, masked KYC, claims, placement, site editor) were written and statically checked but not driven in a real browser after the last change - do one click-through on the dev server before relying on them.
- **Admin screens** for per-site rate edits and creating a code for another user exist only as API calls.
- **Salary / target / incentive pay** for Manager, Team Leader and Executive is still not modelled (HR/payroll; owner decision). Promotion and moving a team are supported (`POST /v1/admin/users/:id/placement`).
- **TDS** stays at 0% until a CA answers. The approvals queue shows a standing "TDS not confirmed" warning on every payout until the owner ticks `tds_confirmed` in policy; this is a visible flag, not a hard block (a hard block would stop all payouts until the CA replies - the owner can choose that later). The rate itself is a CA question.
- **Retention / erasure (DPDP)** exists (`POST /v1/admin/maintenance/purge`, `POST /v1/admin/users/:id/erase`) with the default windows clicks 180 days, leads 365 days; these windows are placeholders for the owner / lawyer to set. Nothing calls the purge on a schedule yet - add a Cloudflare Cron trigger or call it from the AI key.
- **Known small race:** a refund that lands between the RazorpayX call and the status update of an `approved` payout can be applied as if nothing was sent; the owner sees it in the refund flag and the payout row.
- **Incremental verification** re-checks only the saved checkpoint row plus new rows; an edit deep in old history is found by "Check everything" (`/v1/admin/verify?full=1`), not by the quick check.
- Branch is local only (`feat/partner-circle-v1`); nothing was pushed.
