# Partner Circle: version notes

Format: newest first. Every release also updates `public/version.json` (shown in the page footer) and `package.json`.

## 1.0.0 - 21 Nov 2026 11:00 IST
- Front door for the Moneypenny / Corporate Monopoly / Partner Circle suite: one dashboard (Moneypenny credits owned with the 100 = 1 US$ rate and real money beside it, Monopoly targets and achievements, commissions), signed provisioning, degraded mode when an engine is down.
- Commission to Moneypenny is built but OFF in v1 (`MNP_COMMISSION_ENABLED` server switch; commissions stay in the ledger and the owner-approved payout flow). Payouts are off by default (mock adapter).
- Tenant profile, OpenAPI with read/write and money flags, AI keys barred from money routes, audit log.
- Hardened through five independent audit passes (no double pay, refund after send, release only when no credit can exist, erase waits for Monopoly).
- Known limits: erase check not atomic with a concurrent claim; Moneypenny has no suspend call.
- Version number, version notes (this file) and footer version line added.
