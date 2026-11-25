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

## Money-rule recheck, 25 Nov 2026 (version 1.0.7): ten questions
The builder applied the decisions already given on 14 Nov (minimum 500 rupees, 80% after 7 days and the rest later for money-back products, pay days 15th and last day, joining bonus 500 rupees for 30 days, Corporate Tambola 25% and 25%, codes off for games, team share off) and left these for the owner. Full text and the decision-by-decision table: `docs/MONEY-RULES-RECHECK-2026-11-25.md`.
1. The last 20% of a money-back product: paid at day 30 (as noted) or day 37 (30 days plus the 7-day buffer, as built)?
2. May the owner approve a payout before its pay day at all (it is allowed on purpose and logged today)?
3. Team share: yes or no, how much, and is it paid out of the 25% or on top?
4. Discount codes on DPDP and MOM (10% sample today): keep or remove?
5. Rate cards for every product other than Corporate Tambola; the 25/30/35 levels and the Growth Partner incentives (not built).
6. Joining bonus on a money-back product is released with the last part (day 37); is that right, and is there a cap on total bonus cost?
7. Deal protection: 14 days (built) or 30 days (the games' rule)?
8. The exact spelling of the payee name on the pages (it is a record now: `PUT /v1/admin/tenant { "payee_name": ... }`).
9. TDS rate (placeholder 0%) and the CA's answer.
10. A separate pass to remove "my, mine, your, yours" from all screens and notices (about 85 places).
- Gate: migration `0007_money_recheck.sql` (additive columns only) is applied by the owner after the audits pass, together with 0003-0006.
