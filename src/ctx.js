// Request context: everything a handler needs, injected so tests can control time, secrets and adapters.
import { HttpError, sha256Hex, hmacHex } from './util.js';
import { mockPayoutAdapter, unconfiguredMailer } from './adapters.js';

export function makeCtx({ db, env = {}, now, mailer, payouts, fetchImpl, engines } = {}) {
  const ctx = {
    db,
    env,
    engines: engines || {}, // { mnp, mono }: absent = "not connected" (never fake numbers)
    now: now || (() => Date.now()),
    mailer: mailer || unconfiguredMailer(),
    payouts: payouts || mockPayoutAdapter(),
    fetchImpl: fetchImpl || globalThis.fetch,
    actor: null,
    secret(name) {
      const v = env[name];
      if (!v || String(v).length < 16) throw new HttpError(500, 'server_misconfigured', `${name} is not set (needs 16+ chars)`);
      return String(v);
    },
    /** HMAC of an identifier with the server pepper: customer e-mails are never stored, only this. */
    async pepper(value) {
      return hmacHex(ctx.secret('PC_PEPPER'), String(value).trim().toLowerCase());
    },
    hash: sha256Hex,
  };
  return ctx;
}
