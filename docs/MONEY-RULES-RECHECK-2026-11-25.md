# Money rules: recheck against the owner's decisions (25 Nov 2026)

What was checked: every rule in the code that moves, holds, names or promises money (sales, commissions, joining bonus, payouts, pay days, schemes, holds, refunds, who is the payee, which gateway is named) against the owner's decisions of 29 Oct, 1 Nov, 9 Nov, 14 Nov (review and v3 design), 16 Nov, 17 Nov and 20-23 Nov 2026 (suite rules v1.1 and v1.2, gentle words, fairness wording).

Money stays OFF. Nothing here was deployed, no database was changed, migration 0007 is a draft the owner applies after the audits pass, and the payout adapter is still the mock one unless `PAYOUT_MODE` is set on purpose.

## Result in one table

| # | Owner decision | Before this change | Now | Test |
|---|---|---|---|---|
| 1 | Minimum payout is 500 rupees (14 Nov) | Default was 1,000 rupees | `min_payout_minor` 50,000 paise | `minimum payout is 500 rupees` |
| 2 | Money-back products: 80% after 7 days, the last 20% after the money-back days (14 Nov) | Whole commission waited 37 days | Two ledger entries per commission: the early share at 7 days, the rest at 37 (`sites.early_release_bps`, 8,000 for DPDP, MOM, Veridian AI OS, PROJEXA). A refund cancels both parts, or only the unsent part when the first was already sent | four `split release` tests, `flagged sales` test |
| 3 | Pay days are the 15th and the last day of the month (14 Nov, v3) | No pay days: any day | `policy.pay_days` [15, 31]; a payout remembers its next pay day (`payouts.pay_on`, India time) and cannot be approved before it unless the owner approves early on purpose (written in the action log) | `nextPayDay`, two `pay days` tests |
| 4 | Joining bonus of 500 rupees released with the first sale; gone if no first sale within 30 days of approval (14 Nov) | Did not exist | One extra commission entry on the first sale, once per person, only if the sale was paid within 30 days of approval, mature when that sale is fully mature; a refund of the sale takes it back; Refer and Earn people get none | five `joining bonus` tests |
| 5 | Team share: yes or no and how much is still open; "until then do not show the line" (14 Nov) | On by default (1%, 0.75%, 0.5%) | Off by default (0, 0, 0). When the owner switches it on it follows the same split | `team share is off by default` |
| 6 | Corporate Tambola: Refer and Earn 25%, Growth Partner 25% (14 Nov) | 12% and 4% (placeholders) | 25% and 25% | `Corporate Tambola pays` |
| 7 | Discount codes off for the games until decided (14 Nov, review item 8) | 5% codes on Tambola and Elections | Off on Tambola, Voter List, Townhall Records, Elections, Meetings. DPDP and MOM keep their sample 10% (see questions) | same test |
| 8 | One payout sentence per product, with the real wait (14 Nov, review item 2) | One fixed sentence in the app, wrong for money-back products after the split | `GET /v1/public/sites` carries `payout_wait` per product, computed from the product's own numbers, and the earnings screen lists them | `each product shows its own payout wait` |
| 9 | Payee is IT Services by Rajat Agarwal through Razorpay, and the name comes from the payee record, never from code (29 Oct, 16 Nov) | The name was typed into the home page footer and the terms page | `tenant_profile.payee_name`, served by `/v1/public/brand`, filled into the pages by `public/js/payee.js`. The owner can change it in one place (`PUT /v1/admin/tenant`) | `the payee is read from the payee record` |
| 10 | One gateway name: Razorpay (29 Oct) | The screens, the privacy page and the data export said "RazorpayX" | Say "Razorpay". The adapter code keeps its own name and stays OFF | `words people see` |
| 11 | Rupee sign (fairness wording, 29 Oct) | "Rs" on every screen and in Moneypenny lines | The rupee sign | same test, `dashboard` test |
| 12 | Each credit is one sale reference at Moneypenny ("one sale_ref per commission") | A second part of the same sale would have been refused as a repeat | Each part and the bonus has its own reference (`pay_1`, `pay_1:final`, `pay_1:bonus`) | `Moneypenny takes each part`, `postingSaleRef` |
| 13 | No clawback after a payout is sent (9-11 Nov) | Correct | Rechecked with split sales: only the unsent part is cancelled; the owner queue counts flagged sales, not parts | `split release: a refund ...` |
| 14 | Pay only if the payment is confirmed, no refund and no claim open (9-11 Nov) | Correct | Unchanged, applies to every part and to the bonus | existing tests |
| 15 | No salaries shown, no buyer names shown (14 Nov, items 4 and 7) | Not in this engine | Rechecked: no salary field, buyers kept only as a one-way code | read, not changed |
| 16 | No tick boxes, no "I agree" (v1.3) | Correct | Rechecked: sign-up has none | existing tests |
| 17 | Money flag stays OFF | Correct | Rechecked: payouts mock by default, Moneypenny commissions need `MNP_COMMISSION_ENABLED`, nothing deployed | existing tests |

## Not built, on purpose

These are in the owner's v3 design but are new products, not rule corrections. They are listed so nobody thinks they exist:

- Growth Partner "incentives" on top of 25%, the three Growth Partner types (freelancer, on-roll, call-centre agent) each with its own commission, and the 25/30/35 levels. The engine has one commission rate per product and one for Refer and Earn.
- Public wording "up to 50% as per policy". Not added anywhere; the owner has to say where it goes.
- AI coaches (they stay OFF until a monthly limit is set).
- Language choice (Hindi first), call and WhatsApp buttons with a Do-Not-Disturb check, the contest reward screens.
- Payment of commission as Moneypenny credits stays built but OFF (`MNP_COMMISSION_ENABLED`). Which path is switched on first, direct payout or Moneypenny, is the owner's call.

## Questions for the owner

1. **The last 20%: day 30 or day 37?** The note says "the rest after 30 days". The code pays it at 37 days (30 money-back days plus the 7-day buffer that was already the rule), so a refund asked on day 30 cannot be missed. Say "30" and it is one setting per product.
2. **Pay days: should an early approval be allowed at all?** Today the owner can approve before the pay day on purpose and it is logged. Say "never" and the early button goes.
3. **Team share: yes or no, and how much?** Off until you decide. Also: is the sales team paid out of the 25%, or on top?
4. **Discount codes on DPDP and MOM.** The v3 design shows none. They are still on at 10% until you say.
5. **Rates for every product other than Corporate Tambola** and the 25/30/35 levels. All other rates are still samples.
6. **Joining bonus on a money-back product**: it is released with the last part (day 37), not the first. Also, is there a cap on the total cost of bonuses?
7. **Deal protection:** a registered prospect stays the seller's for 14 days here; the games count a click for 30 days (review item 10). Make it 30?
8. **Payee name record.** The record starts as "IT Services by Rajat Agarwal". Confirm the exact spelling and capitals you want on the pages.
9. **TDS.** Payouts still carry a placeholder 0% until a CA gives the rate.
10. **Wording sweep.** The rule "no my, mine, your, yours in what people read" is not applied everywhere: about 85 places in the screens, notices and privacy page still use "your". Sweeping them touches many sentences and their tests; do you want it as one separate change?

## What was not checked

Real e-mail, Razorpay, Moneypenny and Monopoly were never called: everything above ran against the in-memory test database and the mock engines.

Migration 0007 was applied to an empty in-memory database and, in `test/migration-0007.test.js`, to an in-memory database built the way version 1.0.6 left it (migrations 0001 to 0006 and rows written with the old columns: two products, four people, one matured sale with its single commission entry, one paid payout). That test shows: no row added or lost and the ledger byte for byte unchanged; the Veridian product row gets the 80/20 split and the games product does not; people approved before count from their sign-up day (no surprise joining bonus for a partner approved long ago, the bonus still arrives for a recent one); the old sale keeps its one release date while a new sale of the same product splits; one payout can carry the old entry; a payout that has no pay day is approved as before; refunds void the old single entry and both parts of a new sale; both hash chains still verify. It was NOT applied to the real D1 database (the owner does that after the audits), and no copy of real data was used.
