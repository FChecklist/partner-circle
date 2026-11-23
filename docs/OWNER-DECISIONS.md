# Owner decisions still open (found by the cloud audits, 21 Nov 2026)

These are business rules the owner set earlier. They were NOT changed by the builder; each has a mitigation in code and a choice for the owner.

1. **Hold length vs chargebacks (audit 2 M3).** Games and Townhall pay after 7 days; card chargebacks can arrive later, and there is no clawback after a payout is sent. Choice: longer hold for those sites (per-site `buffer_days`), or net later payouts against disputed commission.
2. **Deal registration beats a later click (audit 2 M1).** Owner rule. Mitigations built: 50 prospects per partner, the same reply whether or not an e-mail is already held. Choice: expire a prospect unless the buyer touches the partner.
3. **Refer-and-earn self-purchase (audit 2 M2).** Refer members have no e-mail or phone, so a self-buy cannot be detected. Built: alias-aware e-mail check (+tag, Gmail dots). Choice: accept the cost, or hold refer commission longer.
4. **Click stuffing (audit 2 M9).** Built: the embed ignores attribution parameters inside frames. Remaining: a partner code (`pcode`) beats every click and every registered prospect whatever its age, and each use is counted; a click does not beat a registered prospect inside the protection period. Owner to choose whether a newer click should win.
5. **Erasure at Moneypenny / Monopoly (audit 2 M7).** Needs delete calls in those products.
6. **Mail.** Real partners need mail (RESEND_API_KEY) configured; the owner can no longer vouch for an e-mail without it (`ALLOW_OWNER_VOUCH=1` is the emergency override).
7. **Lows not done:** site signature does not cover method and path; KYC key has no KDF; verification code is 6 digits with a resettable counter; `email_taken` reveals registered e-mails; `constructor` key 500 on admin PATCH; bad `%` in a URL returns 500; leaked site key can set leads; AI keys can suspend users; no HSTS header; chain not anchored outside D1.

## Launch gate (must be done by the owner before inviting Indian partners)
- Terms and Conditions: `public/terms.html` is a short plain summary taken from the existing footer text. The owner should replace it with the final Terms before launch.
- Before applying migration 0003 (unique index on `sales.razorpay_payment_id`), run on D1: `SELECT razorpay_payment_id, COUNT(*) AS n FROM sales WHERE razorpay_payment_id IS NOT NULL GROUP BY razorpay_payment_id HAVING n > 1;` It must return no rows; otherwise the migration fails.
- DONE 23 Nov 2026: the grievance contact was decided by the owner and added (footer, `public/privacy.html`, `docs/PRIVACY.md`). Still gated: apply D1 migrations 0003-0006 only after the audits pass.
