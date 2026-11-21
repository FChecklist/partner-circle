# Partner Circle

A standalone growth-partner product: links, discount codes, click / lead / sale attribution, an append-only commission
ledger, payout approval, and a small integration API that lets any of our sites report a sale **without changing the
site's own code beyond one server call and one script tag**.

- Backend: Cloudflare Pages Functions (plain Web-standard JS, no framework) on **D1** (SQLite). Free tier only.
- Web app: no-build vanilla JS in `public/` (sign-in with an API key, role-based screens, owner console).
- Same source runs under Node 22.13+/24+ using `node:sqlite` for local dev and tests. No runtime dependencies at all.
- Policy and money rules: `ASSUMPTIONS.md`. Integration guide for site developers: `docs/INTEGRATION.md`.

## Roles

| Role | How they get in | What they do |
|---|---|---|
| Owner | key minted by `scripts/mint-owner-key.mjs` | everything; the only one who can approve people, KYC, payouts, schemes, policy, keys |
| AI master | scoped `ai` key minted by the owner | read all, propose staff/codes/scheme drafts, suspend on fraud flags; every action is in the action log; **can never approve, verify, change policy or mint keys** (enforced at key creation and again per route) |
| Sales Manager > Team Leader > Executive | created by owner (or proposed by AI) | team tree, personal links and codes, overrides on team sales |
| Growth Partner | self-registers (e-mail + mobile mandatory), owner approves | links, discount codes (only where policy allows), prospect registration |
| Refer and Earn | self-registers with just a name, active at once | share links only, lower reward rate, no codes; must verify e-mail + KYC before first payout |
| Site | `site` key and/or a signed webhook | resolve links, validate codes, post leads / sales / refunds |

## Run it locally

```
node -v                                   # 22.13 or newer (24+ recommended)
node scripts/seed.mjs --demo              # creates .data/dev.sqlite with 9 sites and a fake demo organisation
node scripts/dev-server.mjs               # http://127.0.0.1:8788  (PORT=... to change)
```

Seeding writes owner / AI / demo-user keys to `.data/` (git-ignored) and never prints them. To sign the browser in as someone:
open `http://127.0.0.1:8788/dev/login/owner` (or `/dev/login/imran`, `/dev/login/anita`, `/dev/login/rita` ...). That route exists
only in the dev server. The dev server uses a mock payout provider and a mock mailbox
(`GET /v1/dev/outbox` shows pending verification codes).

## Tests

```
npm test            # node --test "test/*.test.js"  (no dependencies; run it for the current count)
npm run build       # syntax-checks every JS file, replays migrations on an empty DB, seeds the sites
```

Last run (11 Nov 2026, after the independent-review hardening): **108 / 108 pass** on this laptop (Node 26.3) and, from a fresh copy of the sources, on the partner laptop (Node 22.23.4). Both were real runs of `node --test test/*.test.js`. What the suites prove:

| File | Covers |
|---|---|
| `test/core.test.js` | hash-chained ledger + action log (append-only triggers, tamper / gap detection, concurrent writers), API keys (hashed at rest, revoke), AI cannot hold owner scopes, rate limits, signed webhooks (bad secret, replay window, tampered body), idempotency keys, input limits, field encryption |
| `test/users-links.test.js` | registration rules, hierarchy, sponsor codes, AI-proposed staff pending owner approval, e-mail verification, KYC (India / abroad, encrypted, masked), links (no open redirect, click logging, raw IP never stored), codes (only where allowed, capped, expiry, limits), policy validation |
| `test/sales.test.js` | attribution precedence, hold days per product (37 / 7), overrides, self-referral, suspended partner, refer rate, order idempotency, code consumption, Razorpay confirmation gating, refunds, partial refunds, timeline, double-entry self-check |
| `test/payouts.test.js` | payout gating, owner-only approval, provider webhook, reject / fail / retry, **no clawback**, refund-then-failed-payout, overrides payout, TDS, audit trail, RazorpayX adapter shape (fake fetch), env adapter selection |
| `test/schemes-embed.test.js` | schemes (AI drafts, owner activates / settles), leaderboard privacy, embed snippet in a VM, public sites endpoint, site secret derive / rotate |
| `test/extras.test.js` | prospect registration + protection window, non-India manual payouts, strict key minting |
| `test/hardening.test.js` | one regression test per finding of the 10-11 Nov independent review: public register cannot self-activate, one payment = one sale (app + unique index), frozen payout destination and masked KYC, payout reversal / out-of-state events, disputes and claim holds, refunds that cancel waiting payouts and arrive before the sale, `paid_at` clamp, phone self-referral, atomic audited key operations, `access.denied` / `ai.read` logging, owner-key bootstrap into the log, site-host confirmation and owned-domain redirects, RazorpayX mode vs key prefix, mail-not-configured + owner e-mail verify, parallel code-guess cap, notification e-mails, suspended keys, placement, per-request actor, incremental verify, retention purge, DPDP erasure, D1 100-variable limit, static CSP check, and the mutation check for the route-level AI owner-only guard |
| `test/platform.test.js` | Pages Function on a faithful D1 fake, fail-closed without secrets, migration replay, DB-level constraints, concurrency (duplicate deliveries, bursts, double payout request) |

## Deploy (Cloudflare free tier) — owner steps, nothing here has been deployed

1. `wrangler d1 create partner-circle`, copy the id into `wrangler.toml`.
2. `wrangler d1 migrations apply partner-circle --remote` (uses `migrations/`).
3. Seed the nine sites: `wrangler d1 execute partner-circle --remote --command "<INSERT OR IGNORE ... from src/policy.js DEFAULT_SITES>"`, or run `node scripts/seed.mjs` against a local file and `wrangler d1 export` / import. (A one-line SQL generator is in `scripts/sites-sql.mjs`.)
4. Secrets (never in git): `wrangler pages secret put PC_PEPPER`, `SITE_SECRET_MASTER`, `RAZORPAY_WEBHOOK_SECRET`, `KYC_KEY` (each 32+ random chars; `openssl rand -hex 32`). Optional, only when going live: `RESEND_API_KEY` + `MAIL_FROM`, and for payouts `PAYOUT_MODE` (`test` or `live`) with `RAZORPAYX_KEY_ID`, `RAZORPAYX_KEY_SECRET`, `RAZORPAYX_ACCOUNT_NUMBER`.
5. `node scripts/mint-owner-key.mjs`, then `wrangler d1 execute partner-circle --remote --file=.data/owner-key.sql`. The key stays in `.data/owner-key.txt` (not printed) until you move it to a password manager and delete the file.
6. `wrangler pages deploy public` (the `functions/` folder is picked up automatically; `public/_routes.json` limits the function to `/v1/*` and `/r/*`).
7. Point the Razorpay webhook at `https://<host>/v1/webhooks/razorpay` (events: `payment.captured`, `refund.processed`, `payout.processed`, `payout.failed`, `payout.reversed`).

**Safe by default:** with no payout variables the app uses the mock provider and nothing can move money. `PAYOUT_MODE=live`
is the one switch that makes the RazorpayX adapter real; it needs the owner's own credentials and decision.

## Layout

```
migrations/   0001_init.sql ... 0006_audit_index.sql      (D1 / SQLite)
src/          app.js (router) auth.js users.js links.js prospects.js sales.js payouts.js razorpay.js schemes.js
              chain.js (hash-chained ledger + audit)  policy.js  adapters.js (payout + mail)  db.js (D1 / sqlite)
functions/    [[path]].js   Cloudflare Pages Function entry
public/       index.html, js/app.js, css/app.css, embed.js (site snippet), _headers, _routes.json
scripts/      dev-server.mjs seed.mjs mint-owner-key.mjs build-check.mjs lib.mjs
test/         node:test suites (no dependencies)
```

## Honest limits

See `ASSUMPTIONS.md` ("Not done / needs the owner"). In short: nothing is deployed, no live Razorpay / RazorpayX / Resend
call has ever been made, real Cloudflare D1 has never been exercised (only a D1-shaped fake that also enforces the 100-bound-variable limit), the browser UI was not re-driven by hand after the hardening (the automated checks are API-level plus a static CSP check), TDS / GST / foreign-payee tax is a recorded placeholder until a CA confirms, salary / target pay for
managers is not modelled, and the hash chains detect tampering but are not an external timestamped notary.
