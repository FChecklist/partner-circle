# Partner Circle as the front door of the suite

Plain English. Written 17 Nov 2026. Status of the two engines: **contract-only** (built against their public contracts and fakes; neither is live).

## 1. What a partner sees
One login (Partner Circle). One dashboard: commissions (here), "Moneypenny (credits) owned" with the real money beside it
("1,250 Moneypenny (credits) owned = US$12.50 (about Rs 1,037.50)", "100 Moneypenny = 1 US$"), targets and achievements from
Monopoly. The browser talks only to Partner Circle. Partner Circle talks to the engines from the server, signed.
`GET /v1/me/dashboard` is the one read; `POST /v1/me/moneypenny/convert-request` is the one money-adjacent ask (people only, needs an
Idempotency-Key, always live, never from cache; Moneypenny records it and a person approves it there).

## 2. Verified in code: "Partner Circle payouts are OFF"
- Default payout adapter is the **mock** (`src/adapters.js`, `ctx.js`). A real RazorpayX adapter exists only when `PAYOUT_MODE` is `test` or `live` AND all RazorpayX keys exist AND the key prefix matches the mode. `PAYOUT_MODE` is unset in `wrangler.toml`.
- Even in mock mode a payout needs the **owner's approval** (AI keys cannot approve; test: `payouts.test.js`). Non-India payouts are recorded and paid by the owner outside the API.
- The new Moneypenny path is **off by default**: `tenant_profile.commission_dest = 'ledger'`. Only the owner key (`suite.write`, an owner-only scope) can switch it, and only when Moneypenny is connected. Test: `suite.test.js` "default policy".
- Honest wording for the owner: "OFF" is the build default plus mock mode, not a recorded owner rule (same finding as the architecture report).

## 3. Commission: paid in one place only
Partner Circle still computes every commission (rate card per site, overrides, hold, refund and claim rules). Then exactly one of:
1. `commission_dest = 'ledger'` (today): the partner requests a payout; the owner approves.
2. `commission_dest = 'moneypenny'`: a matured, Razorpay-confirmed, not-disputed entry is **claimed** (one atomic batch: claim row + a reserve ledger entry + action-log entry) and sent to Moneypenny as a `commission` credit (`POST /v1/event`, `event_type partner_commission`, stable `event_key pc:<ledger ref>`).

Guarantees (all tested): the claim row and the payout item cannot both exist for one entry (two database triggers, both directions); a retry after an unknown outcome reuses the same Idempotency-Key and event key; a refused posting is **held for the owner** (never re-routed); a refund before Moneypenny was told takes the claim back and voids; a refund after the credit is kept and flagged (owner rule: no clawback); the ledger self-check (`ledger_total = available + pending`) and both hash chains still verify. Scheme bonuses (`adjustment`) stay in the payout path.

## 4. Borders and open contract questions (for the Moneypenny and Monopoly sessions)
Moneypenny (real contract `contract/v1/openapi.json`; signing `x-mnp-*`): used `GET /v1/balance`, `GET /v1/quote`, `POST /v1/event`, `POST /v1/convert_request`, `GET /health`.
1. **Commission amount.** `POST /v1/event` computes credits from a tenant rule. Partner Circle sends `cash_minor` = the commission it already computed, so the tenant needs a rule `partner_commission` at **100% of cash**. A clean alternative: a `partner-circle` key role that may grant `commission` credits with `cash_minor > 0` (the architecture report's CHANGE).
2. **`payer_email`.** Partner Circle never stores customer e-mails (only a one-way hash). It sends `<hash>@payer.invalid`. Moneypenny must accept that or drop the requirement for this key class.
3. **`sale_ref`.** Commission uses the Razorpay payment id; an upline override uses `<payment id>:override:<user id>` because one payment can pay several people.
4. **Idempotency.** A definite "not granted" answer is replayed by Moneypenny for the same Idempotency-Key, so Partner Circle bumps a generation suffix (`#n`) when retrying after such an answer (event key unchanged).
5. **Refund after credit** needs the purchase-key `chargeback` route (Partner Circle holds no purchase key); today it only flags for the owner.

Monopoly (real contract `CONTRACT/signed-v1.md`; signing `X-Key-Id`, `X-Timestamp`, `X-Signature`): **per-person routes are not in v1 yet.** Partner Circle proposes (scopes `ingest` and `widgets`): `POST /api/v1/people {work_email,name,role,team_ref,source}`, `POST /api/v1/people/suspend {work_email}`, `GET /api/v1/people/targets?email=`, `GET /api/v1/people/achievements?email=`. Until they exist the dashboard shows "setting up".
Also needed: Monopoly employees log in with their own session today; partners must not (all access via these signed routes).

## 5. Tenants (other companies)
**Decision taken for now: one deployment per company** (own D1 database, own secrets). No cross-company query can exist, so no leak is possible by a forgotten `WHERE`. Per company, in `tenant_profile`: slug, product name, accent colour, logo (https only), currency wording (name is a setting; "Moneypenny" default), credits per US$, engine off-switches, commission destination. Rate cards are the `sites` table (commission_bps, refer_bps, hold days): per company by construction. Partners and keys: per deployment.
Not done, for the owner to decide (architecture decision 4): a shared database with a `tenant_id` on every table (about 2,500 lines touched, chains per tenant). Cost of the chosen path: one free D1 database per company (the free-plan limit is UNKNOWN: check before promising), and no cross-company reporting.
Payouts through IT Services stay for the owner's own tenant; other companies leave `commission_dest = 'ledger'` and run their own payouts or switch to Moneypenny points.

## 6. Degraded mode
Each block (Moneypenny balance, targets, achievements) is fetched in parallel with a 2-second limit and cached 45 seconds in `engine_cache`. Engine down: last numbers shown labelled "stale"; none yet: a soft line; the rest of the page still loads. Provisioning and posting are outboxes with back-off (max 10 tries, then the owner sees them under Suite → Needs the owner). Engine text is untrusted: whitelisted fields, clipped, markup stripped, rendered with `textContent`.

## 7. AI readiness
`src/openapi.js` builds the OpenAPI document from the live route table (`x-rw`, `x-money`, `x-ai`, `x-requires-idempotency-key`, `x-untrusted-fields`, `x-rate-limit`); `npm run openapi` writes `docs/openapi.json`. Test: no route that moves money is open to an AI key; AI answers carry `x-untrusted-text` and `_untrusted`. Existing: scoped keys, per-key rate limit, Idempotency-Key, hash-chained audit log with key id, owner-only scopes (now including `suite.write`).

## 8. Configuration (secrets via `wrangler pages secret put`, never in git)
`MNP_BASE_URL`, `MNP_KEY_ID`, `MNP_SECRET` (a Moneypenny `api`/spend-class key); `MONO_BASE_URL`, `MONO_KEY_ID`, `MONO_SECRET`. Absent = "not connected". `npm run dev -- --stub` runs with fake engines.
