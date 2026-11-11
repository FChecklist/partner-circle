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
 * RazorpayX payout adapter. Written against the documented Payouts API shape and tested only with an injected fake fetch.
 * It refuses to run unless the owner has set mode 'live' on purpose (live money needs the owner's own act).
 */
export function razorpayXAdapter({ keyId, keySecret, accountNumber, fetchImpl, baseUrl = 'https://api.razorpay.com/v1', mode = 'test' }) {
  if (!keyId || !keySecret || !accountNumber) throw new HttpError(500, 'server_misconfigured', 'RazorpayX credentials are incomplete');
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
      return { provider: 'razorpayx', provider_ref: j.id, status: j.status === 'processed' ? 'paid' : 'processing' };
    },
  };
}

/** E-mail goes only through the existing Resend free-limit setup. Default is a capturing no-op. */
export function nullMailer() {
  const outbox = [];
  return { outbox, async send(m) { outbox.push(m); return { queued: false }; } };
}

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

/** Pick adapters from env. Live payouts only when PAYOUT_MODE === 'live' AND all RazorpayX variables exist. */
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
