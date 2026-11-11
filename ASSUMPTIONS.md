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
| Partner is paid ~37 days after payment for Veridian + PROJEXA (30 + 7 buffer), 7 days for games / Townhall (0 + 7) | `sites.return_days`, `sites.buffer_days`; `eligible_at = paid_at + hold` |
| Pay only when the sale is real **and** Razorpay confirmed the payment | `sales.rzp_status` must be `confirmed` before any commission is "available" |
| No clawback after payout; "pay late instead" | refund after the commission was swept into a payout keeps the payout and flags the sale (`refund_after_maturity` column = "refunded after payout") for the owner |
| Complete ledger; each payout and partner has its own trail | append-only hash-chained `ledger` + `audit_log` (DB triggers block UPDATE/DELETE; `/v1/admin/verify` re-hashes everything) |
| AI operates the system, owner only approves | AI keys cannot hold `payouts.approve kyc.verify users.approve keys.manage policy.write schemes.settle schemes.activate`; AI-created staff are `pending` |
| Partner verification at first payout: e-mail + PAN + UPI (India); abroad tax/ID + bank | `PUT /v1/me/kyc`, encrypted (AES-GCM, key `KYC_KEY`), shown masked, owner verifies |
| All payouts only by IT SERVICES BY RAJAT AGARWAL through Razorpay | footer text; payout adapter is RazorpayX only; no other payee exists in code |
| Refer and Earn: no e-mail to start sharing; verification before first payout | role `refer`: active at once, links only, e-mail + KYC enforced at payout request |
| E-mail only through the existing Resend free-limit setup, never `tina@` | `resendMailer` is the only mail path and is off unless `RESEND_API_KEY` + `MAIL_FROM` are set |
| Discount codes only where policy allows | `sites.discount_allowed`, `max_discount_bps`; refer members cannot create codes |

## Decisions I made (flag any you disagree with)

1. **Rates are samples.** Commission 10-15% (games 12%), refer reward 3-5%, overrides 1.0% / 0.75% / 0.5% to Executive / Team Leader / Manager on a downline sale, max discount 5-10% on four sites, none elsewhere. Copied from the demo, which labels them "sample". Commission is on **net of tax** (`amount - tax`), after any discount.
2. **Sales staff earn per-sale commission at the same site rate as a partner** when the sale is theirs; the upline overrides come on top. Salary, monthly target pay and accelerators from the demo are **not modelled** (HR/payroll, not a partner-commission function). Schemes (weekly / monthly / quarterly bonuses) are.
3. **Attribution order:** discount code > registered prospect (14-day protection) > click id (30-day window) > earlier sign-up. First match wins; one partner per sale.
4. **Self-referral** = buyer's e-mail hash equals the partner's own. Blocked sales are recorded with a reason and no commission. (Same-device / same-card checks need data the sites do not send.)
5. **Minimum payout Rs 1,000**, one open payout per partner at a time, one payout sweeps *all* currently available entries (no partial amounts).
6. **TDS** is stored per payout as `tds_bps` (default 0%) and deducted from the amount sent. Whether Sec 194H applies, the rate, thresholds, PAN-less higher rate, GST on partner invoices and withholding for foreign payees are **CA questions** (owner's own instruction). Nothing here is tax advice.
7. **INR only.** A sale in another currency is rejected (422). Foreign partners are paid in INR value or by hand (see below).
8. **Non-India payees:** RazorpayX pays Indian UPI / IMPS only, so for a non-India partner `approve` records the payout as `processing` with provider `manual`; the owner pays by bank transfer outside the API and records it with `POST /v1/admin/payouts/:id/mark-paid {reference}`.
9. **A refund processed by Razorpay in full** (`refund.processed`) is applied automatically; a **partial** refund is only flagged (`sale.partial_refund_review`) because the commission give-back is a human call.
10. **Customer e-mails are never stored.** Only `HMAC-SHA256(PC_PEPPER, lower(email))`. Raw IPs are never stored either (daily-salted hash for click de-dup stats). Partner e-mail / phone are stored (needed to contact and pay them) and shown masked.
11. **Ledger integrity is tamper-evident, not tamper-proof.** Anyone with raw database control can drop the triggers and rebuild the chain consistently. For stronger assurance export `GET /v1/admin/verify` head hashes to an external place on a schedule (not implemented).
12. **Concurrency:** ledger writes re-read the chain tail inside an optimistic retry (25 tries with jitter) and queue within an isolate; this is correct but sized for tens of writes per second, not thousands.
13. **Login = API key.** No passwords and no sessions to steal; the key is shown once. A lost key means the owner mints a new one. Magic-link login by e-mail is a possible later step (needs Resend live).

## Not done / needs the owner (honest list)

- **Nothing is deployed.** No Cloudflare, D1, Pages, Resend, Razorpay or RazorpayX call has ever been made. The Cloudflare path is tested against a faithful in-memory D1 fake, not against Cloudflare itself.
- **Live payouts** are off by design (`PAYOUT_MODE` unset = mock). The RazorpayX adapter is written to the documented Payouts API shape and tested with an injected fake `fetch`; it has never talked to Razorpay. Needs the owner's RazorpayX account, an account number, the webhook secret, and a deliberate `PAYOUT_MODE=live`.
- **Razorpay webhook field names** (`payment.captured`, `refund.processed`, `payout.*`) follow the public docs from memory of the payload shape; verify with a real test-mode event before go-live.
- **CA decisions** (item 6), partner agreement wording, the partner-facing refund-condition text shown to buyers, and consumer-law review.
- **Rates, discount maxima, minimum payout, override %** need the owner's final numbers (item 1, 5).
- **Salary / target / incentive for Manager, Team Leader, Executive** (demo screens) are not built (item 2).
- **E-mail**: verification codes use the mock mailer unless Resend is configured; no approval / payout notification e-mails are sent yet.
- **Wiring the 8 sites**: each site must add the one signed server call and the script tag (`docs/INTEGRATION.md`); that is a change in those repos and was not made here.
- **UI polish / accessibility pass** and a mobile-device test beyond a narrow-viewport check; no automated browser tests (the UI was exercised by hand against the dev server).
- **Admin screens** for per-site rate edits and creating a code for another user exist only as API calls.
- Data retention / erasure (DPDP) for partners and the purge of old clicks / idempotency rows beyond the opportunistic 7-day idempotency cleanup.
- Branch is local only (`feat/partner-circle-v1`); nothing was pushed.
