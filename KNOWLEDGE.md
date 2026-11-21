# Partner Circle: knowledge file

## Version
- Current version: **1.0.0** (see `public/version.json`, shown in the page footer, and `CHANGELOG.md` for version notes).
- Rule (owner order, 21 Nov 2026): every product, site and page update carries a version number and version notes, saved in git. Bump `package.json`, `public/version.json` and add a `CHANGELOG.md` entry for every release.

## Where things are
- Money: `src/payouts.js`, `src/sales.js`, `src/chain.js` (hash-chained ledger and audit log). Suite front door: `src/suite.js`, `src/engines.js`.
- Handover and status: `docs/STATE.md`; open owner choices: `docs/OWNER-DECISIONS.md`; privacy: `docs/PRIVACY.md`; audits: PR comments and `docs/AUDIT-pass*.md`.
- Switches: `PAYOUT_MODE` (unset = mock, nothing real is paid), `MNP_COMMISSION_ENABLED=1` (commission to Moneypenny; off in v1), `ALLOW_OWNER_VOUCH=1` (emergency only).
- Tests: `npm test` (node 22). Build check: `npm run build`.
