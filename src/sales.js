// Sale attribution, commission posting, refunds and Razorpay payment confirmation.
//
// A "sale completed" event comes from one of our sites (signed). We attribute it (code > click > lead), post commission
// and upline override entries to the append-only ledger, and set when they mature:
//   eligible_at = paid_at + (site.return_days + site.buffer_days)   (37 days Veridian/PROJEXA, 7 days games/Townhall)
// Money only becomes payable once Razorpay has confirmed the same payment (rzp_status = 'confirmed').

import { HttpError, newId, needStr, isInt, DAY } from './util.js';
import { atomic, auditStmts, ledgerStmts } from './chain.js';
import { getPolicy, holdDays } from './policy.js';
import { RANK, uplineOf } from './users.js';

const MAX_AMOUNT = 100_000_000_00; // Rs 10 crore in paise: a sanity cap, not a business rule

export const saleView = (s) => ({
  id: s.id, site_id: s.site_id, order_id: s.order_id, amount_minor: s.amount_minor, net_minor: s.net_minor, currency: s.currency,
  paid_at: s.paid_at, eligible_at: s.eligible_at, attribution: s.attribution, status: s.status, block_reason: s.block_reason,
  rzp_status: s.rzp_status, refunded_at: s.refunded_at, refund_after_payout: !!s.refund_after_maturity,
});

function parseSale(body, now) {
  if (!body || typeof body !== 'object') throw new HttpError(422, 'invalid_body', 'JSON object expected');
  const order_id = needStr(body.order_id, 'order_id', 120);
  if (!isInt(body.amount_minor, 1, MAX_AMOUNT)) throw new HttpError(422, 'invalid_field', 'amount_minor must be a positive integer (paise)');
  const tax = body.tax_minor ?? 0;
  if (!isInt(tax, 0, body.amount_minor - 1)) throw new HttpError(422, 'invalid_field', 'tax_minor must be 0..amount_minor-1');
  const currency = String(body.currency || 'INR').toUpperCase();
  if (currency !== 'INR') throw new HttpError(422, 'unsupported_currency', 'only INR sales are supported in this version');
  const paid_at = body.paid_at ?? now;
  if (!isInt(paid_at, 1) || paid_at > now + 5 * 60000) throw new HttpError(422, 'invalid_field', 'paid_at must be a past epoch-ms timestamp');
  for (const f of ['razorpay_payment_id', 'razorpay_order_id', 'click_id', 'code', 'customer_email']) {
    if (body[f] != null && (typeof body[f] !== 'string' || body[f].length > 254)) throw new HttpError(422, 'invalid_field', f);
  }
  return { order_id, amount_minor: body.amount_minor, tax_minor: tax, currency, paid_at };
}

async function attribute(ctx, site, body, customerHash, paidAt, policy) {
  const windowMs = policy.attribution_window_days * DAY;
  // 1. discount code
  if (body.code) {
    const code = String(body.code).toUpperCase().trim();
    const c = await ctx.db.first('SELECT * FROM codes WHERE code=? AND site_id=? AND active=1', [code, site.id]);
    if (c && (!c.expires_at || c.expires_at >= paidAt) && c.used_count < c.max_uses && site.discount_allowed && c.discount_bps <= site.max_discount_bps) {
      const r = await ctx.db.run('UPDATE codes SET used_count = used_count + 1 WHERE id=? AND used_count < max_uses', [c.id]);
      if (r.changes === 1) return { user_id: c.user_id, attribution: 'code', code: c.code, consumedCode: c.id };
    }
  }
  // 2. a prospect a partner registered, protected for deal_protection_days (beats a later click by someone else)
  if (customerHash) {
    const pr = await ctx.db.first("SELECT * FROM leads WHERE site_id=? AND customer_hash=? AND source='registered'", [site.id, customerHash]);
    if (pr && paidAt >= pr.ts && paidAt - pr.ts <= policy.deal_protection_days * DAY) return { user_id: pr.user_id, attribution: 'prospect' };
  }
  // 3. click id from the embed snippet
  if (body.click_id) {
    const k = await ctx.db.first('SELECT * FROM clicks WHERE id=? AND site_id=?', [String(body.click_id), site.id]);
    if (k && paidAt >= k.ts && paidAt - k.ts <= windowMs) return { user_id: k.user_id, attribution: 'click', click_id: k.id };
  }
  // 4. earlier sign-up by the same customer
  if (customerHash) {
    const l = await ctx.db.first('SELECT * FROM leads WHERE site_id=? AND customer_hash=?', [site.id, customerHash]);
    if (l && paidAt >= l.ts && paidAt - l.ts <= windowMs) return { user_id: l.user_id, attribution: 'lead', click_id: l.click_id };
  }
  return { user_id: null, attribution: 'none' };
}

async function rzpState(ctx, paymentId, amount) {
  if (!paymentId) return 'pending';
  const ev = await ctx.db.first("SELECT * FROM razorpay_events WHERE payment_id=? AND type='payment.captured' ORDER BY ts LIMIT 1", [paymentId]);
  if (!ev) return 'pending';
  return ev.amount_minor === amount ? 'confirmed' : 'mismatch';
}

export async function recordSale(ctx, site, body) {
  const p = parseSale(body, ctx.now());
  const dup = await ctx.db.first('SELECT * FROM sales WHERE site_id=? AND order_id=?', [site.id, p.order_id]);
  if (dup) {
    if (dup.amount_minor !== p.amount_minor) throw new HttpError(409, 'order_conflict', 'this order_id was already recorded with a different amount');
    return { ...saleView(dup), duplicate: true };
  }
  const policy = await getPolicy(ctx);
  const net = p.amount_minor - p.tax_minor;
  const customerHash = body.customer_email ? await ctx.pepper(body.customer_email) : null;
  const attr = await attribute(ctx, site, body, customerHash, p.paid_at, policy);

  let user = attr.user_id ? await ctx.db.first('SELECT * FROM users WHERE id=?', [attr.user_id]) : null;
  let status = 'recorded';
  let blockReason = null;
  if (user) {
    if (user.email_hash && customerHash && user.email_hash === customerHash) { status = 'blocked'; blockReason = 'self_referral'; }
    else if (user.status !== 'active') { status = 'blocked'; blockReason = 'partner_not_active'; }
  }

  const holdD = holdDays(site);
  const eligible = p.paid_at + holdD * DAY;
  const id = newId('sl');
  const rzpPaymentId = body.razorpay_payment_id || null;
  const rzp = await rzpState(ctx, rzpPaymentId, p.amount_minor);

  const entries = [];
  const summary = { commission_minor: 0, overrides: [] };
  if (user && status === 'recorded') {
    const rate = user.role === 'refer' ? site.refer_bps : site.commission_bps;
    const amt = Math.floor((net * rate) / 10000);
    if (amt > 0) {
      entries.push({ account_id: user.id, kind: 'commission', amount_minor: amt, sale_id: id, eligible_at: eligible, ref: `commission:${id}:${user.id}`, memo: `${site.id} order ${p.order_id}` });
      summary.commission_minor = amt;
    }
    for (const up of await uplineOf(ctx, user.id)) {
      const bps = policy.override_bps[up.role];
      if (up.status !== 'active' || !bps || RANK[up.role] <= RANK[user.role]) continue;
      const o = Math.floor((net * bps) / 10000);
      if (o > 0) {
        entries.push({ account_id: up.id, kind: 'override', amount_minor: o, sale_id: id, eligible_at: eligible, ref: `override:${id}:${up.id}`, memo: `team sale by ${user.handle}` });
        summary.overrides.push({ user_id: up.id, amount_minor: o });
      }
    }
  }

  const actorCtx = { ...ctx, actor: { type: 'site', id: site.id } };
  try {
    await atomic(ctx, async () => [
      {
        sql: `INSERT INTO sales (id,site_id,order_id,amount_minor,tax_minor,net_minor,currency,paid_at,hold_days,eligible_at,user_id,attribution,click_id,code,customer_hash,
                razorpay_payment_id,razorpay_order_id,rzp_status,status,block_reason,created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        params: [id, site.id, p.order_id, p.amount_minor, p.tax_minor, net, p.currency, p.paid_at, holdD, eligible, user?.id ?? null, attr.attribution, attr.click_id ?? null,
          attr.code ?? null, customerHash, rzpPaymentId, body.razorpay_order_id || null, rzp, status, blockReason, ctx.now()],
      },
      ...(await ledgerStmts(ctx, entries)),
      ...(await auditStmts(actorCtx, [{ action: status === 'blocked' ? 'sale.blocked' : 'sale.recorded', target: `sale:${id}`,
        meta: { site_id: site.id, order_id: p.order_id, net_minor: net, attribution: attr.attribution, partner: user?.id ?? null, reason: blockReason, eligible_at: eligible } }])),
    ]);
  } catch (e) {
    if (attr.consumedCode) await ctx.db.run('UPDATE codes SET used_count = used_count - 1 WHERE id=? AND used_count > 0', [attr.consumedCode]);
    if (/UNIQUE constraint failed: sales\.site_id, sales\.order_id/.test(String(e.message))) {
      return { ...saleView(await ctx.db.first('SELECT * FROM sales WHERE site_id=? AND order_id=?', [site.id, p.order_id])), duplicate: true };
    }
    throw e;
  }
  const row = await ctx.db.first('SELECT * FROM sales WHERE id=?', [id]);
  return { ...saleView(row), partner_handle: user?.handle ?? null, ...summary, duplicate: false };
}

/**
 * Apply a refund. Entries not yet swept into a payout are voided. Entries already in a payout are NOT clawed back
 * (owner policy: pay late, never claw back) and the sale is flagged for the owner instead.
 */
export async function applyRefund(ctx, sale, meta = {}) {
  if (sale.status === 'refunded') return { ...saleView(sale), already_refunded: true };
  const entries = await ctx.db.all("SELECT * FROM ledger WHERE sale_id=? AND kind IN ('commission','override')", [sale.id]);
  const settled = new Set(
    (await ctx.db.all(
      `SELECT pi.ledger_seq FROM payout_items pi JOIN payouts p ON p.id = pi.payout_id
        WHERE p.status NOT IN ('rejected','failed') AND pi.ledger_seq IN (SELECT seq FROM ledger WHERE sale_id=?)`, [sale.id])).map((r) => r.ledger_seq));
  const voids = entries
    .filter((e) => !settled.has(e.seq))
    .map((e) => ({ account_id: e.account_id, kind: 'void', amount_minor: -e.amount_minor, sale_id: sale.id, eligible_at: e.eligible_at, ref: `void:${e.id}`, memo: meta.reason || 'refund' }));
  const flag = settled.size > 0 ? 1 : 0;
  await atomic(ctx, async () => [
    { sql: "UPDATE sales SET status='refunded', refunded_at=?, refund_after_maturity=? WHERE id=? AND status<>'refunded'", params: [ctx.now(), flag, sale.id] },
    ...(await ledgerStmts(ctx, voids)),
    ...(await auditStmts(ctx, [{ action: flag ? 'sale.refunded_after_payout' : 'sale.refunded', target: `sale:${sale.id}`,
      meta: { voided: voids.length, kept_paid: settled.size, reason: meta.reason || null, usage_verified: meta.usage_verified ?? null } }])),
  ]);
  return saleView(await ctx.db.first('SELECT * FROM sales WHERE id=?', [sale.id]));
}

export async function recordRefund(ctx, site, body) {
  const orderId = needStr(body?.order_id, 'order_id', 120);
  const sale = await ctx.db.first('SELECT * FROM sales WHERE site_id=? AND order_id=?', [site.id, orderId]);
  if (!sale) throw new HttpError(404, 'sale_not_found', 'no sale recorded for this order_id');
  return applyRefund({ ...ctx, actor: { type: 'site', id: site.id } }, sale, {
    reason: body.reason ? String(body.reason).slice(0, 200) : null,
    usage_verified: typeof body.usage_verified === 'boolean' ? body.usage_verified : null,
  });
}

/** Razorpay says payment X was captured for amount Y: confirm (or flag) every sale carrying that payment id. */
export async function confirmPayment(ctx, paymentId, amountMinor) {
  const sales = await ctx.db.all("SELECT * FROM sales WHERE razorpay_payment_id=? AND rzp_status='pending'", [paymentId]);
  for (const s of sales) {
    const st = s.amount_minor === amountMinor ? 'confirmed' : 'mismatch';
    await atomic(ctx, async () => [
      { sql: "UPDATE sales SET rzp_status=? WHERE id=? AND rzp_status='pending'", params: [st, s.id] },
      ...(await auditStmts(ctx, [{ action: `sale.rzp_${st}`, target: `sale:${s.id}`, meta: { payment_id: paymentId, razorpay_amount: amountMinor, sale_amount: s.amount_minor } }])),
    ]);
  }
  return sales.length;
}

export async function listSales(ctx, userId, limit = 50) {
  return (await ctx.db.all('SELECT * FROM sales WHERE user_id=? ORDER BY paid_at DESC LIMIT ?', [userId, limit])).map(saleView);
}

/** Catch any sale/event pair that crossed in flight: confirm pending sales whose Razorpay capture event already arrived. */
export async function reconcilePending(ctx, userId = null) {
  const rows = await ctx.db.all(
    `SELECT s.razorpay_payment_id AS pid, e.amount_minor AS amt FROM sales s JOIN razorpay_events e
       ON e.payment_id = s.razorpay_payment_id AND e.type='payment.captured'
      WHERE s.rzp_status='pending' ${userId ? 'AND s.id IN (SELECT sale_id FROM ledger WHERE account_id=?)' : ''} GROUP BY s.razorpay_payment_id`,
    userId ? [userId] : []);
  let n = 0;
  for (const r of rows) n += await confirmPayment(ctx, r.pid, r.amt);
  return n;
}
