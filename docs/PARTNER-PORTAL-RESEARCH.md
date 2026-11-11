# Partner portal research and design note (9 Nov 2026)

Method: a handful of web searches; most sources are vendor blogs and third-party directories, so every number below is "as reported", not verified against signed terms. Treat as direction, not as a rate card.

## What real companies do (and what we borrow)

| Company | What they do (as reported) | We borrow |
|---|---|---|
| **Freshworks** affiliate relaunch 2026 | Tiered commissions; tiers by qualified referrals, retained customers, influenced revenue. Reported 20% recurring for year one, 25% higher tier, custom for top partners. Referral must become paying within 3 months; commission runs 12 months. [relaunch post](https://www.freshworks.com/theworks/company-news/affiliate-relaunch-2026/), [terms](https://www.freshworks.com/company/affiliate-partner/terms-and-conditions/) | Tiers by retained customers, not clicks; "qualified referral" window |
| **Zoho** affiliate and partners | Official page: 15% of revenue for 12 months if the customer stays 60 days; first product only. Reseller commissions shown in a partner store portal with monthly statement. [affiliate FAQ](https://www.zoho.com/affiliate/faq.html), [partner commission](https://zoho.com/mail/help/partnerportal/partner-commission.html) | 60-day "stays" rule before commission is earned; monthly statement |
| **Notion** affiliate | Reported 50% for first period or up to a per-activation amount plus a share of year-one revenue; own page says it is now closed to new affiliates. Sources conflict. [partnero listing](https://www.partnero.com/list/notion) | Lesson: generous rates get closed; start modest, keep policy editable |
| **Dropbox** referral | Two-sided storage credit for inviter and invitee. [teardowns](https://track360.io/blog/saas-referral-program-examples-2026) | Two-sided reward for the Refer and Earn lane (friend gets a benefit too) |
| **HubSpot** | Two tracks: affiliates (reported 20-30% recurring for 12 months) and agency solutions partners. [overview](https://refgrow.com/blog/saas-affiliate-program-examples) | Separate lanes for casual referrers and serious partners (our Refer and Earn vs Growth Partner) |
| **Razorpay** partner program | Free enrolment; separate forms per partner type (referral, reseller, aggregator); fixed bonus or percentage of transactions. [partner program](https://razorpay.com/blog/introducing-razorpay-partner-program/), [terms](https://razorpay.com/partner-terms) | One signed partner agreement per type; Indian KYC mindset |
| **PartnerStack** guidance | Pay on revenue, not sign-ups; tiers unlock higher rate and support. [tiers](https://partnerstack.com/glossary/tiers), [commission structure](https://support.partnerstack.com/hc/en-us/articles/14657461808275) | Pay on paid sales only |
| **Deal registration** practice | Partner registers an opportunity to protect it; around 14-day protection window, reviewed regularly. [glossary](https://track360.io/glossary/deal-registration) | "Register a prospect" with 14-day protection |
| **Anti-fraud** guides | Block self-referral (same e-mail/IP/card), cap redemptions per code, ~30-day hold so refunds close, minimum payout, review spikes, check before each payout batch. [fraud guide](https://refgrow.com/blog/affiliate-fraud-detection-guide), [prevention](https://track360.io/glossary/affiliate-fraud-prevention) | All of these, shown in the demo as policy rules |
| **Sales pay mix** | Account executives commonly 50/50 base and variable at target; accelerators above target; SPIFs for short contests. [Pave](https://www.pave.com/blog-posts/getting-to-50-50-the-data-behind-sales-compensation), [Insight Partners](https://www.insightpartners.com/ideas/sales-compensation-primer) | Salary plus incentive with accelerator; weekly/monthly/quarterly schemes as SPIFs. Manager and team-lead splits were not found; left as owner decision |

## Five key borrowed ideas
1. Pay on **paid sales only**, after a **hold period** (reported ~30 days) so refunds close first.
2. **Tiers by retained customers** (Freshworks, Zoho 60-day rule), not by clicks.
3. **Two lanes**: casual refer-and-earn vs registered partners (HubSpot, Razorpay).
4. **Deal registration** with a protection window, and **discount codes only where policy allows**, capped per code, with self-referral blocking.
5. **Short contests (SPIFs) and a leaderboard** layered on top of base commission; salary plus variable with accelerators for the field team.

## Name
The owner's idea "Growth Partner Portal" is clear but long and sounds like a login page. Alternatives:
1. **Partner Circle** (short, friendly, works across 8 sites)
2. **Grow Together Hub**
3. **Veridian Rewards Club**

**Pick: Partner Circle**, with the role still called "Growth Partner" inside it. Demo uses it.

## Design decisions
- One portal, one registration (e-mail and mobile mandatory, mock code 123456), a personal link per product/site/page.
- Discount UI shown only where the policy table allows a discount for that product.
- AI layer gets a **scoped API key with its own audit log** ("AI actions" screen), never "no login".
- Refer and Earn lane: share link without e-mail check; verification required before first payout.
- Payments in the real product go only via IT Services plus Razorpay. No other payee is shown.
- All commission, salary and target figures in the demo are placeholders "sample, to be set by policy". Earnings depend on sales; no guarantees.

## Open questions for the owner
1. Commission % per product and per tier; one-time or recurring (12 months?).
2. Payout cycle (monthly?), hold period (30 days?), minimum payout.
3. Discount limits per product (max %, max uses per code, expiry); which products allow none.
4. KYC and tax: PAN, bank proof, TDS rate and who deducts, GST for GST-registered partners; partner agreement wording.
5. Salary/target figures and pay mix for Manager, Team Leader, Executive; who counts as employee vs partner.
6. Override: does a Manager or Executive earn a share on their partners' sales?
7. Deal protection window (14 days?) and conflict rule when two partners claim one buyer.
