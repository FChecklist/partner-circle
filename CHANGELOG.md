# Partner Circle: version notes

Format: newest first. Every release also updates `public/version.json` (shown in the page footer) and `package.json`.

## 1.0.6 - 23 Nov 2026
- Site calls are now signed over time, method, path and body, so a signed sale cannot be replayed against another endpoint (sites must update their signing line; see docs/INTEGRATION.md).
- Razorpay events are de-duplicated by the event type and entity id inside the signed body, not by a header anyone could change.
- Direct RazorpayX payout code is documented as OFF unless the owner decides otherwise.
- Privacy page: how long records are kept and what stays after erasure, in plain words; layout fixed; "Need help?" line tidied.
- The erasure list empties once a request is completed; field names like `constructor` are refused in settings.

## 1.0.5 - 23 Nov 2026
- Sign-up has no tick box and no "I agree" button (owner rule v1.3). The form shows a gentle line with links to the Terms and Conditions and the Privacy notice; sign-up works without any consent field and ignores one if an old app sends it. The privacy notice is now version 2026-11-23.
- Added a short Terms and Conditions page (/terms.html) for the owner to finalise.
- Fixed the release time shown in the footer: it showed the UTC time labelled IST.
- Notes for the owner: a check to run before applying migration 0003.

## 1.0.4 - 23 Nov 2026
- A friendly "Need help?" line with the grievance officer's name, e-mail and WhatsApp number is now in the page footer and on the privacy page. It is plain text: no tick box, no button.

## 1.0.3 - 21 Nov 2026
- Erasure requests: the owner queue lists every request, oldest first (no cut-off), and the Approvals screen now shows them. Two requests at the same instant still write one record. New database index (migration 0006) keeps the lookups cheap.

## 1.0.2 - 21 Nov 2026
- Erasure requests: asking again no longer writes a new record, and the owner queue lists each person once, so one person cannot push others' requests out of the owner's view.
- Docs: README test count no longer hard-coded; the privacy-page grievance contact is a launch gate (do not invite Indian partners until the owner fills it).

## 1.0.1 - 21 Nov 2026
- Money fix: a refund or a claim that arrives at the same moment the owner approves a payout can no longer give that payout's money back to the partner (the check is now made again inside the same step that writes the change). Marking a payout as failed has the same re-check, and a payout already handed over (also one paid by hand) needs the owner to confirm with the provider first.
- The owner queue now flags a waiting payout that contains a refunded sale, and lists people who asked to be erased.
- Privacy: sign-up now needs the consent tick on the server too; a public privacy page (/privacy.html); buttons in the account to download your data, rotate your key and ask for erasure.
- Prospect registration: a held e-mail now gets the same reply as a fresh one, every try counts towards a limit of 100 an hour, and the limit of 50 counts only prospects still inside their protection period.
- Key rotation replies are never stored with an Idempotency-Key.
- Docs: README migrations list and test counts corrected; version file kept in step with the release.

## 1.0.0 - 21 Nov 2026 11:00 IST
- Front door for the Moneypenny / Corporate Monopoly / Partner Circle suite: one dashboard (Moneypenny credits owned with the 100 = 1 US$ rate and real money beside it, Monopoly targets and achievements, commissions), signed provisioning, degraded mode when an engine is down.
- Commission to Moneypenny is built but OFF in v1 (`MNP_COMMISSION_ENABLED` server switch; commissions stay in the ledger and the owner-approved payout flow). Payouts are off by default (mock adapter).
- Tenant profile, OpenAPI with read/write and money flags, AI keys barred from money routes, audit log.
- Hardened through five independent audit passes (no double pay, refund after send, release only when no credit can exist, erase waits for Monopoly).
- Cloud audit round 1 fixes: payout request/approve re-checked inside the atomic step, payout sent marker before the provider call (no release of an unknown outcome), concurrent approve guard, Moneypenny claim lease, dashboard asks engines only for a verified e-mail, key rotation, payout-details-changed notice and flag, e-mail alias self-referral check, prospect cap and uniform replies, anonymous leaderboard, privacy notice with consent record, data export and erasure request, cheaper rate limiting.
- Known limits: erase check not atomic with a concurrent claim; Moneypenny has no suspend call.
- Version number, version notes (this file) and footer version line added.
