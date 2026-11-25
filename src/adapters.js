// OWNER RULE: payments run only through Moneypenny -> IT Services -> Razorpay. The direct RazorpayX adapter below stays OFF and unreachable by default
// (PAYOUT_MODE unset = mock). Do NOT switch it on without a written owner decision. Do not delete the mock.
// Outbound adapters. Everything that could touch real money or real e-mail sits behind these small interfaces,
// and the defaults are inert mocks. Nothing here is live until the owner supplies credentials AND flips the mode.

import { HttpError } from './util.js';

/** Mock payout provider (default). Records the call, never moves money. */
export function mockPayoutAdapter() {
  const calls = [];
  return {
    mode: 'mock',
    calls,
    async createPayout(req) {
      calls.push(req);
      return { provider: 'mock', provider_ref: `pout_mock_${req.payout_id.slice(-10)}`, status: 'processing' };
    },
  };
}

/**
 * RazorpayX payout adapter. Written against the documented Payouts API shape ("composite" payout with an inline fund account)
 * and tested only with an injected fake fetch; it has NEVER talked to Razorpay.
 *
 * Razorpay has no separate sandbox host: test mode and live mode share https://api.razorpay.com/v1 and are told apart ONLY by the key
 * id prefix (rzp_test_ vs rzp_live_). So the mode is enforced against that prefix, not just used as a label:
 *   mode 'test'  -> the key id must start with rzp_test_  (a live key is refused, so "test" can never pay real money)
 *   mode 'live'  -> the key id must start with rzp_live_  (a test key is refused, so "live" cannot silently run against the sandbox)
 */
export function razorpayXAdapter({ keyId, keySecret, accountNumber, fetchImpl, baseUrl = 'https://api.razorpay.com/v1', mode = 'test' }) {
  if (!keyId || !keySecret || !accountNumber) throw new HttpError(500, 'server_misconfigured', 'RazorpayX credentials are incomplete');
  if (!['test', 'live'].includes(mode)) throw new HttpError(500, 'server_misconfigured', 'PAYOUT_MODE must be "test" or "live"');
  const want = mode === 'live' ? 'rzp_live_' : 'rzp_test_';
  if (!String(keyId).startsWith(want)) {
    throw new HttpError(500, 'server_misconfigured', `PAYOUT_MODE=${mode} needs a key id starting with ${want}; refusing to run with a mismatched key`);
  }
  const auth = 'Basic ' + btoa(`${keyId}:${keySecret}`);
  return {
    mode,
    async createPayout({ payout_id, amount_minor, method, destination, name, narration }) {
      const body = {
        account_number: accountNumber,
        amount: amount_minor,
        currency: 'INR',
        mode: method === 'upi' ? 'UPI' : 'IMPS',
        purpose: 'payout',
        queue_if_low_balance: false,
        reference_id: payout_id,
        narration: (narration || 'Partner Circle payout').slice(0, 30),
        fund_account:
          method === 'upi'
            ? { account_type: 'vpa', vpa: { address: destination.upi_id }, contact: { name, type: 'vendor', reference_id: payout_id } }
            : { account_type: 'bank_account', bank_account: { name, ifsc: destination.bank_ifsc_swift, account_number: destination.bank_account }, contact: { name, type: 'vendor', reference_id: payout_id } },
      };
      const res = await fetchImpl(`${baseUrl}/payouts`, {
        method: 'POST',
        headers: { authorization: auth, 'content-type': 'application/json', 'X-Payout-Idempotency': payout_id },
        body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new HttpError(502, 'provider_error', j?.error?.description || `provider returned ${res.status}`);
      return { provider: 'razorpayx', provider_ref: j.id, status: j.status === 'processed' ? 'paid' : 'processing', mode };
    },
  };
}

/** Capturing mailer for local dev and tests: keeps messages in `outbox`, sends nothing. */
export function nullMailer() {
  const outbox = [];
  return { outbox, async send(m) { outbox.push(m); return { queued: false, captured: true }; } };
}

/**
 * The default in a real deployment until Resend is configured. It FAILS LOUDLY instead of discarding messages: a partner asking for a
 * verification code must be told e-mail is not set up (and the owner can verify the address by hand), not left waiting for a mail
 * that was never sent.
 */
export function unconfiguredMailer() {
  return {
    configured: false,
    async send() {
      throw new HttpError(503, 'mail_not_configured', 'e-mail sending is not set up yet; ask the owner to verify the address');
    },
  };
}

/** E-mail goes only through the existing Resend free-limit setup. */
export function resendMailer({ apiKey, from, fetchImpl }) {
  if (!apiKey || !from) throw new HttpError(500, 'server_misconfigured', 'Resend is not configured');
  return {
    async send({ to, subject, text }) {
      const res = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text }),
      });
      if (!res.ok) throw new HttpError(502, 'mail_failed', `mail provider returned ${res.status}`);
      return { queued: true };
    },
  };
}

/** Pick adapters from env. A RazorpayX adapter exists only when PAYOUT_MODE is "test" or "live" AND all RazorpayX variables exist AND the key matches the mode. */
export function adaptersFromEnv(env, fetchImpl) {
  const out = {};
  if (env.PAYOUT_MODE === 'live' || env.PAYOUT_MODE === 'test') {
    out.payouts = razorpayXAdapter({
      keyId: env.RAZORPAYX_KEY_ID, keySecret: env.RAZORPAYX_KEY_SECRET, accountNumber: env.RAZORPAYX_ACCOUNT_NUMBER,
      fetchImpl, mode: env.PAYOUT_MODE,
    });
  } else out.payouts = mockPayoutAdapter();
  if (env.RESEND_API_KEY && env.MAIL_FROM) out.mailer = resendMailer({ apiKey: env.RESEND_API_KEY, from: env.MAIL_FROM, fetchImpl });
  return out;
}
