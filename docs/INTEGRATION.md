# Integrating a site with Partner Circle

Everything is server-to-server plus one script tag. The site needs **no database change**: it keeps a click id / code with
the order and sends one signed call when the payment is confirmed.

Base URL below is `https://PC` (the Partner Circle host). Money is always **integer paise** (Rs 499 = `49900`), INR only.
Errors are `{"error":{"code":"...","message":"..."}}` with a normal HTTP status.

## 1. Credentials (the owner creates these)

| What | How | Used for |
|---|---|---|
| Site id | one of `dpdp mom aios projexa tam voter th el mt` | header `X-PC-Site` |
| Signing secret | `GET /v1/admin/sites/:id/secret` (owner key; derived, never stored, rotate with `POST .../rotate-secret`) | HMAC for sales / refunds |
| Site API key | `POST /v1/admin/keys {"kind":"site","site_id":"mom"}` -> `pck_<id>.<secret>`, shown once | `Authorization: Bearer ...` for read calls (link / code / lead) |

## 2. The embed snippet (front end, optional but recommended)

```html
<script src="https://PC/embed.js" async></script>
```

A partner link `https://PC/r/<slug>` logs the click and redirects to your page with `?pc=ck_<16 hex>`. The snippet stores
that click id (and an optional `?pcode=CODE`) in a first-party cookie / localStorage for 30 days. At checkout read
`PartnerCircle.clickId()` and `PartnerCircle.code()` (or call `PartnerCircle.attach(form)` to add hidden fields
`pc_click_id` and `pc_code`) and send them to **your server** with the order. Nothing personal leaves the browser.

## 3. Validate a discount code before the buyer pays (server -> PC, site key)

```
POST /v1/integration/codes/validate        Authorization: Bearer <site key>
{"code":"IMRAN10"}
-> {"valid":true,"code":"IMRAN10","discount_bps":1000,"partner_handle":"...","uses_left":4}
-> {"valid":false,"reason":"expired|exhausted|inactive|unknown_code|partner_inactive|discount_not_allowed"}
```
Apply `discount_bps` to your price yourself; PC never sets your price. Discount codes exist only for sites whose policy allows
them (`aios`, `projexa`, `voter`, `th`, `mt` allow none by default).

## 4. Record a lead (a sign-up), optional (server -> PC, site key)

```
POST /v1/integration/leads
{"customer_email":"buyer@example.com","click_id":"ck_...","code":"IMRAN10"}
```
The e-mail is converted to a keyed one-way hash immediately; PC never stores it. A later sale by the same person (even with
no click id) is attributed to the partner who brought the sign-up.

## 5. Sale completed (server -> PC, **signed**) — the one call that matters

```
POST /v1/integration/sales
X-PC-Site: mom
X-PC-Timestamp: <epoch ms>
X-PC-Signature: hex( HMAC_SHA256( signing_secret, "<timestamp>.<raw request body>" ) )

{
  "order_id": "MOM-10432",            // your id; the pair (site, order_id) is unique, so retries are safe
  "amount_minor": 49900,              // what the customer paid, incl. tax, after any discount
  "tax_minor": 7612,                  // GST part, 0 if unknown (commission is on amount - tax)
  "paid_at": 1796112000000,           // optional, epoch ms, default now
  "razorpay_payment_id": "pay_...",   // needed so the payout can wait for Razorpay's own confirmation
  "razorpay_order_id": "order_...",   // optional
  "click_id": "ck_...", "code": "IMRAN10",   // from the snippet / checkout form, both optional
  "customer_email": "buyer@example.com"       // hashed on arrival; used for the self-referral check
}
-> 201 {"id":"sl_..","attribution":"code|prospect|click|lead|none","status":"recorded|blocked","eligible_at":...,"duplicate":false,...}
-> 200 same body with "duplicate":true when the same order_id is re-delivered (identical amount)
-> 409 order_conflict when the same order_id arrives with a different amount
```

Timestamp must be within 5 minutes of PC's clock. Sign the exact bytes you send. Node example:

```js
import { createHmac } from 'node:crypto';
const body = JSON.stringify({ order_id: 'MOM-10432', amount_minor: 49900, tax_minor: 7612, razorpay_payment_id: 'pay_x', click_id });
const ts = String(Date.now());
const sig = createHmac('sha256', process.env.PC_SIGNING_SECRET).update(`${ts}.${body}`).digest('hex');
await fetch('https://PC/v1/integration/sales', { method: 'POST', body, headers: { 'X-PC-Site': 'mom', 'X-PC-Timestamp': ts, 'X-PC-Signature': sig } });
```

Attribution order: discount code, then a prospect the partner registered (protected 14 days), then click id (30-day window),
then an earlier sign-up. A buyer whose e-mail matches the partner's own is blocked as self-referral (no commission).
Commission is posted to the ledger at once but is **payable only when** (a) `paid_at + refund window + 7 days` has passed
(37 days for `dpdp mom aios projexa`, 7 days for `tam voter th el mt`) **and** (b) Razorpay's own `payment.captured` webhook
confirmed the same payment id and amount.

## 6. Refund (server -> PC, signed the same way)

```
POST /v1/integration/refunds
{"order_id":"MOM-10432","reason":"unused within 30 days","usage_verified":false}
```
Before payout the commission and overrides are voided. After a payout the money is **not** clawed back (owner policy);
the sale is flagged for the owner. Refunds are the site's decision: PC records them. Refund only for users who really used
the product (daily use or complete end-to-end use cases), and show the condition before payment.

## 7. Idempotency, limits

- Add `Idempotency-Key: <unique>` to any POST to get the first response replayed on retry (a different body with the same key is `422`).
- Site keys are limited to 120 requests/minute by default, signed calls to 600/minute per site. `429` carries `Retry-After`.
- All endpoints return `Cache-Control: no-store`.

## 8. Razorpay

Point Razorpay's webhook at `https://PC/v1/webhooks/razorpay`; it is verified with `X-Razorpay-Signature` using the webhook
secret and de-duplicated by `X-Razorpay-Event-Id`. PC consumes `payment.captured` (confirms sales), `refund.processed`
(full refunds are applied; partial refunds are flagged for review) and `payout.processed|failed|reversed` (settles payouts).
