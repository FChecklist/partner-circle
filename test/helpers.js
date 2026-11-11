// Test harness: fresh in-memory SQLite per test, injectable clock, helper to call the real handler with a real Request.
import { openDb, seedSites } from '../scripts/lib.mjs';
import { makeCtx } from '../src/ctx.js';
import { handle } from '../src/app.js';
import { createKey, siteSecret, signBody } from '../src/auth.js';
import { nullMailer, mockPayoutAdapter } from '../src/adapters.js';
import { hmacHex } from '../src/util.js';

export const T0 = Date.UTC(2026, 10, 1, 6, 0, 0); // 1 Nov 2026
export const DAY = 86400000;

export const ENV = {
  PC_PEPPER: 'test-pepper-0123456789abcdef',
  SITE_SECRET_MASTER: 'test-site-master-0123456789abcdef',
  RAZORPAY_WEBHOOK_SECRET: 'test-rzp-webhook-secret-0123456789',
  KYC_KEY: 'test-kyc-key-0123456789abcdef',
};

export async function mk(opts = {}) {
  const { raw, db } = openDb();
  const clock = { t: T0 };
  await seedSites(db, T0);
  // stands in for the owner confirming the best-guess hosts (see policy.js DEFAULT_SITES): tests exercise every site
  await db.run('UPDATE sites SET active=1, host_confirmed=1');
  const mailer = nullMailer();
  const payouts = opts.payouts || mockPayoutAdapter();
  const ctx = makeCtx({ db, env: { ...ENV, ...(opts.env || {}) }, now: () => clock.t, mailer, payouts });
  const owner = await createKey(ctx, { kind: 'owner', label: 'test owner' });
  const ai = await createKey(ctx, { kind: 'ai', label: 'test ai' });
  const h = {
    raw, db, ctx, clock, mailer, payouts, owner: owner.token, ai: ai.token,
    advance(ms) { clock.t += ms; },
    async call(method, path, { body, key, headers = {}, rawBody } = {}) {
      const init = { method, headers: { ...headers } };
      if (key) init.headers.authorization = `Bearer ${key}`;
      if (body !== undefined || rawBody !== undefined) {
        init.body = rawBody ?? JSON.stringify(body);
        init.headers['content-type'] = 'application/json';
      }
      const res = await handle(ctx, new Request(`https://pc.test${path}`, init));
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      return { status: res.status, data, headers: res.headers };
    },
    /** Signed "site webhook" call, the way a real site would make it. */
    async signed(siteId, method, path, body, { ts, secretOverride } = {}) {
      const site = await db.first('SELECT * FROM sites WHERE id=?', [siteId]);
      const raw = body === undefined ? '' : JSON.stringify(body);
      const stamp = String(ts ?? clock.t);
      const sig = await signBody(secretOverride ?? (await siteSecret(ctx, site)), stamp, raw);
      return h.call(method, path, { rawBody: raw, headers: { 'x-pc-site': siteId, 'x-pc-timestamp': stamp, 'x-pc-signature': sig } });
    },
    async rzp(event, { eventId, secret = ENV.RAZORPAY_WEBHOOK_SECRET } = {}) {
      const raw = JSON.stringify(event);
      const headers = { 'x-razorpay-signature': await hmacHex(secret, raw) };
      if (eventId) headers['x-razorpay-event-id'] = eventId;
      return h.call('POST', '/v1/webhooks/razorpay', { rawBody: raw, headers });
    },
    /** Create an active staff/partner user via the owner API; returns {id, handle, key}. */
    async staff(role, name, parent) {
      const r = await h.call('POST', '/v1/admin/users', { key: owner.token, body: { role, name, email: `${name.toLowerCase().replace(/\W/g, '')}@example.test`, phone: '9876543210', parent_id: parent?.id } });
      if (r.status !== 201) throw new Error(`staff(${role}) failed: ${JSON.stringify(r.data)}`);
      return { id: r.data.user.id, handle: r.data.user.handle, key: r.data.api_key, email: `${name.toLowerCase().replace(/\W/g, '')}@example.test` };
    },
    /** Verify e-mail + KYC for a user end-to-end through the API (owner verifies). */
    async verifyUser(u, kyc = { pan: 'ABCDE1234F', upi_id: 'partner@okbank' }) {
      await h.call('POST', '/v1/me/email/send-code', { key: u.key });
      const code = mailer.outbox.at(-1)._code;
      const v = await h.call('POST', '/v1/me/email/verify', { key: u.key, body: { code } });
      if (v.status !== 200) throw new Error('verify failed ' + JSON.stringify(v.data));
      const k = await h.call('PUT', '/v1/me/kyc', { key: u.key, body: kyc });
      if (k.status !== 200) throw new Error('kyc failed ' + JSON.stringify(k.data));
      const r = await h.call('POST', `/v1/admin/users/${u.id}/kyc/review`, { key: owner.token, body: { approve: true } });
      if (r.status !== 200) throw new Error('review failed ' + JSON.stringify(r.data));
    },
    /** Post a sale the way a site would. Unless rzp is false, also deliver the matching Razorpay capture. */
    async sale(siteId, fields, { rzp = true } = {}) {
      const payId = fields.razorpay_payment_id || `pay_${fields.order_id}`;
      const body = { amount_minor: 100000, tax_minor: 0, razorpay_payment_id: payId, ...fields };
      const r = await h.signed(siteId, 'POST', '/v1/integration/sales', body);
      if (rzp && r.status < 300) {
        await h.rzp({ event: 'payment.captured', payload: { payment: { entity: { id: payId, amount: body.amount_minor, order_id: `order_${fields.order_id}` } } } }, { eventId: `evt_${payId}` });
      }
      return r;
    },
  };
  return h;
}

export const rs = (n) => Math.round(n * 100);
