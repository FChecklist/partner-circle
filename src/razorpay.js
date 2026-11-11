// Razorpay webhook receiver (payments + RazorpayX payout events). Signature-checked, replay-safe (event id), idempotent.

import { HttpError, hmacHex, timingSafeEqualStr } from './util.js';
import { atomic, auditStmts } from './chain.js';
import { confirmPayment, applyRefund } from './sales.js';
import { markPaid, markFailed } from './payouts.js';

export async function verifyRazorpaySignature(ctx, req, rawBody) {
  const sig = req.headers.get('x-razorpay-signature');
  if (!sig) throw new HttpError(401, 'signature_required', 'X-Razorpay-Signature missing');
  const expect = await hmacHex(ctx.secret('RAZORPAY_WEBHOOK_SECRET'), rawBody);
  if (!timingSafeEqualStr(expect, sig.toLowerCase())) throw new HttpError(401, 'invalid_signature', 'signature does not match');
}

/** Razorpay sends X-Razorpay-Event-Id; if absent we derive a stable id from the body so replays still dedupe. */
export async function handleRazorpayWebhook(ctx, req, rawBody) {
  await verifyRazorpaySignature(ctx, req, rawBody);
  let evt;
  try { evt = JSON.parse(rawBody); } catch { throw new HttpError(400, 'invalid_json', 'body is not JSON'); }
  const type = String(evt.event || '');
  if (!type) throw new HttpError(422, 'invalid_event', 'event type missing');
  const eventId = req.headers.get('x-razorpay-event-id') || `body:${await ctx.hash(rawBody)}`;
  const pay = evt.payload?.payment?.entity;
  const ref = evt.payload?.refund?.entity;
  const po = evt.payload?.payout?.entity;
  const paymentId = pay?.id || ref?.payment_id || null;
  const amount = pay?.amount ?? ref?.amount ?? po?.amount ?? null;

  const ins = await ctx.db.run(
    'INSERT OR IGNORE INTO razorpay_events (event_id,type,payment_id,order_id,amount_minor,ts) VALUES (?,?,?,?,?,?)',
    [eventId, type, paymentId, pay?.order_id || null, Number.isInteger(amount) ? amount : null, ctx.now()]);
  if (ins.changes === 0) return { ok: true, duplicate: true };

  const actx = { ...ctx, actor: { type: 'razorpay', id: eventId } };
  const result = { ok: true, type };
  try {
    await processEvent(ctx, actx, { type, pay, ref, po, result });
  } catch (e) {
    // Forget the event so the provider's retry gets processed instead of being swallowed as a duplicate.
    await ctx.db.run('DELETE FROM razorpay_events WHERE event_id=?', [eventId]);
    throw e;
  }
  return result;
}

async function processEvent(ctx, actx, { type, pay, ref, po, result }) {
  if (type === 'payment.captured' && pay?.id) {
    result.confirmed = await confirmPayment(actx, pay.id, pay.amount);
  } else if (type === 'refund.processed' && ref?.payment_id) {
    const sale = await ctx.db.first('SELECT * FROM sales WHERE razorpay_payment_id=?', [ref.payment_id]);
    if (sale && ref.amount >= sale.amount_minor) {
      await applyRefund(actx, sale, { reason: 'razorpay refund.processed' });
      result.refunded = true;
    } else if (sale) {
      // Partial refunds are not auto-applied: they need a human decision on how much commission to give back.
      await atomic(actx, () => auditStmts(actx, [{ action: 'sale.partial_refund_review', target: `sale:${sale.id}`, meta: { refund_minor: ref.amount, sale_minor: sale.amount_minor } }]));
      result.needs_review = true;
    }
  } else if (type.startsWith('payout.') && po?.id) {
    const payout = await ctx.db.first('SELECT * FROM payouts WHERE provider_ref=? OR id=?', [po.id, po.reference_id || '']);
    if (payout) {
      if (type === 'payout.processed') await markPaid(actx, payout.id, po.utr || po.id);
      else if (type === 'payout.failed' || type === 'payout.reversed' || type === 'payout.rejected') await markFailed(actx, payout.id, po.failure_reason || type);
      result.payout = payout.id;
    }
  }
}
