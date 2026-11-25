# One dashboard over Moneypenny and Monopoly

Short design and API contract. Written 25 Nov 2026 from the code that already runs in this repo (`src/suite.js`, `src/engines.js`) and the owner's naming of 17 Nov 2026. Nothing here switches money on: commissions to Moneypenny stay OFF in this version.

## What it is

One page per person, the front door of the suite. Three blocks, one login:

| Block | What the person sees | Where the numbers come from |
|---|---|---|
| Commissions | Money earned through Partner Circle: ready to pay, on hold, in a payout, paid | This program's own ledger. The only block that ever decides money. |
| Moneypenny | Credits owned (100 credits = US$1), what they are worth in dollars and rupees, how many can be turned into money, how many are still settling | The Moneypenny engine (the credit ledger). Display only. |
| Monopoly | The office-target board game: this person's targets with progress, level and badges | The Monopoly engine. Display only. |

Partner Circle is the front door and the only gate to IT Services. Moneypenny is the single gate between the products and IT Services. Monopoly runs on Moneypenny credits.

## Rules the dashboard keeps

1. **One login.** A person never logs in to an engine. The browser asks Partner Circle; Partner Circle calls the engines from the server, signed, using the person's verified e-mail.
2. **An engine being down never breaks the page.** The block shows the last numbers it saw, labelled `stale`, or a soft line (`unavailable`, `setting_up`). Sign-up, approval, sales and the Commissions block carry on.
3. **Money decisions never use engine numbers or the cache.** Payouts, commission posting and refunds read the ledger only. Moneypenny and Monopoly figures are for display.
4. **Monopoly cannot touch pay.** Targets, rewards and penalties are points on the board. Nothing a Monopoly target says changes the Commissions block; the contract test proves the two are independent.
5. **Always real money beside credits.** Every credit figure is shown with its dollar value and, when the engine knows it, its rupee value.
6. **Engine text is untrusted.** Only the fields below are kept, clipped, and stripped of markup.
7. **Only after the e-mail is verified.** Engines are asked about an e-mail only once the person has proved they own it.

## API

### `GET /v1/me/dashboard`

Auth: the person's own key. Cached per block for 45 seconds. Never returns an error because an engine is down.

Response, with every block live (the example below is checked by `test/dashboard-contract.test.js`, so it cannot drift from the code):

<!-- contract:dashboard-live -->
```json
{
  "brand": { "product_name": "Partner Circle", "accent": "#2f855a", "logo_url": null, "currency_label": "Moneypenny" },
  "commissions": {
    "available_minor": 120000,
    "pending_minor": 30000,
    "awaiting_razorpay_minor": 0,
    "on_claim_minor": 0,
    "in_payout_minor": 0,
    "paid_minor": 0,
    "ledger_total_minor": 150000,
    "sent_to_moneypenny_minor": 0,
    "on_the_way_to_moneypenny_minor": 0,
    "destination": "ledger"
  },
  "moneypenny": {
    "status": "live",
    "as_of": 1793512800000,
    "credits": 1250,
    "can_convert": 625,
    "settling": 0,
    "conversion_enabled": true,
    "inr_minor": 103750,
    "lines": {
      "owned": "1,250 Moneypenny (credits) owned = US$12.50 (about ₹1,037.50)",
      "rate": "100 Moneypenny = 1 US$",
      "convert": "You can convert 625 Moneypenny (US$6.25) to money"
    }
  },
  "monopoly": {
    "status": "live",
    "as_of": 1793512800000,
    "targets": [
      { "name": "Sell 5 licences", "period": "monthly", "unit": "sales", "goal": 5, "progress": 2, "ends_at": 1796000000000 }
    ],
    "achievements": { "level": "3", "badges": [ { "name": "First sale", "earned_at": 1793000000000 } ] }
  },
  "notes": []
}
```

When both engines are down and nothing was seen before, the same shape comes back with soft lines instead of numbers:

<!-- contract:dashboard-down -->
```json
{
  "brand": { "product_name": "Partner Circle", "accent": "#2f855a", "logo_url": null, "currency_label": "Moneypenny" },
  "commissions": {
    "available_minor": 0,
    "pending_minor": 0,
    "awaiting_razorpay_minor": 0,
    "on_claim_minor": 0,
    "in_payout_minor": 0,
    "paid_minor": 0,
    "ledger_total_minor": 0,
    "sent_to_moneypenny_minor": 0,
    "on_the_way_to_moneypenny_minor": 0,
    "destination": "ledger"
  },
  "moneypenny": { "status": "unavailable", "as_of": null },
  "monopoly": { "status": "unavailable", "as_of": null, "targets": [], "achievements": { "level": null, "badges": [] } },
  "notes": [
    { "block": "moneypenny", "text": "This part is refreshing, back in a moment. Everything else on this page is up to date." }
  ]
}
```

### Fields

| Field | Meaning |
|---|---|
| `brand` | Name, colour, logo and the name of the credit, read from the tenant profile. Never hard-coded in a page. |
| `commissions.*_minor` | Paise (1/100 rupee), whole numbers, from the ledger. `available` = can be asked for now; `pending` = still waiting (including the last part of a split sale and the joining bonus); `awaiting_razorpay` = waiting for Razorpay to confirm the payment; `on_claim` = a claim is open; `in_payout` = in a payout that is not paid yet; `paid` = paid out. `ledger_total` always equals available plus pending: the self-check. |
| `commissions.sent_to_moneypenny_minor` | Commission already handed to Moneypenny as credits. Always 0 while commissions to Moneypenny are OFF. |
| `commissions.on_the_way_to_moneypenny_minor` | Claimed for Moneypenny and not yet confirmed there. |
| `commissions.destination` | `ledger` (paid out by the payout flow, today) or `moneypenny`. |
| `moneypenny.credits` | Whole credits the person owns. |
| `moneypenny.can_convert` | Credits the engine says can be turned into money now. |
| `moneypenny.settling` | Credits that have been granted but are still settling. |
| `moneypenny.conversion_enabled` | Whether conversion is switched on at Moneypenny. |
| `moneypenny.inr_minor` | Rupee value in paise, or `null` when the engine does not know it. |
| `moneypenny.lines` | Ready-made sentences (`owned`, `rate`, `convert`, and `settling` only when some credits are settling). `convert` is `null` when there is nothing to convert. |
| `monopoly.targets[]` | `name`, `period`, `unit`, `goal`, `progress`, `ends_at` (epoch ms or `null`). At most 20. |
| `monopoly.achievements` | `level` (text or `null`) and `badges[]` (`name`, `earned_at`). At most 20 badges. |
| `*.as_of` | When the numbers were fetched (epoch ms), `null` when none were. |
| `notes[]` | One soft line per block that is not `live`: `{ block, text }`. |

### Block status

| `status` | Meaning | What the block shows |
|---|---|---|
| `live` | Fetched now, or less than 45 seconds ago | Numbers |
| `stale` | The engine did not answer; these are the last numbers seen | Numbers, labelled, with `as_of` |
| `unavailable` | The engine did not answer and nothing was seen before | A soft line |
| `setting_up` | The engine does not know this person yet | A soft line |
| `not_connected` | No engine is configured for this block | A soft line, no invented numbers |
| `off` | The owner switched this engine off | A soft line |
| `verify_email` | The person's e-mail is not verified yet | A soft line |

The Monopoly block is `live` only when both of its calls (targets and achievements) answered, and `stale` when one of them did.

### `POST /v1/me/moneypenny/convert-request`

The person asks Moneypenny to turn credits into money. Body `{ "credits": 600 }`, header `Idempotency-Key` required. Always a live call (never cached). Moneypenny records the request and a person approves it there; nothing moves here. Refusals from Moneypenny that are definite come back as `422` with its short reason; an unclear answer comes back as `503` and nothing is changed, so asking again with the same key is safe.

## What the engines must give us

The server-side clients (`src/engines.js`) call these, signed (HMAC with a key id, timestamp and nonce), and treat any other answer as "not available":

| Engine | Call | Used for |
|---|---|---|
| Moneypenny | `GET /v1/balance?email=` | credits, can_convert, settling, conversion_enabled |
| Moneypenny | `GET /v1/quote?credits=` | rupee value (optional; the dashboard works without it) |
| Moneypenny | `POST /v1/convert_request` | the conversion request above |
| Moneypenny | `POST /v1/event` (`partner_commission`) | commission credits, **OFF in this version** |
| Monopoly | `POST /api/v1/people`, `POST /api/v1/people/suspend` | adding and pausing a person (no second login) |
| Monopoly | `GET /api/v1/people/targets?email=` | `monopoly.targets` |
| Monopoly | `GET /api/v1/people/achievements?email=` | `monopoly.achievements` |

These shapes were written from the mock engines in this repo. They have never run against the real Moneypenny or Monopoly services: the first live check must compare the real answers with this table before the dashboard is shown to a real person.

## Words on the page

Plain English, kind, in favour of the person. Credits are written as `Moneypenny`, never as a bare `$`, and always with the real price beside them. Monopoly penalties are points only; the page never says pay is reduced because of a target.

## Changing this contract

Any change to the response shape needs the example above changed in the same pull request: `test/dashboard-contract.test.js` compares every field of the real response with the example, in both directions, and fails when they differ.
