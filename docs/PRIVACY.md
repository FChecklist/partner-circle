# Partner Circle: privacy notice (version 2026-11-21)

Plain-language notice shown (in short form) at sign-up. The same text is served at /privacy.html. The owner must fill the grievance contact (in both places) before real partners join.

- **What we keep:** name, e-mail, mobile number, role, sales and commissions, and payout details (UPI id or bank account, PAN), encrypted.
- **Why:** to run your account, attribute sales, pay you, and meet tax rules.
- **Who sees it:** your name and e-mail go to Moneypenny and Corporate Monopoly so you have one login; payout details go to Razorpay / RazorpayX when you are paid. Customers' e-mails are stored only as a one-way code.
- **Your choices:** `GET /v1/me/export` shows what is held; `POST /v1/me/erase-request` asks for erasure; `POST /v1/me/keys/rotate` replaces your key.
- **Erasure limits:** the owner completes erasure after money owed and any open payout are settled. Moneypenny and Corporate Monopoly hold their own copy: erasure there goes through those products (they have no delete call yet; Partner Circle only suspends).
- **Consent:** the sign-up form shows this notice and needs a tick; the consent and notice version are written to the audit log (`user.consent`).
- **Grievance contact:** OWNER TO FILL (name, e-mail).
- **Embed snippet:** sets a first-party cookie and local storage with the partner click id for 30 days on our own sites; the sites' own cookie notice must mention it.
