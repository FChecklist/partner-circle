// Razorpay webhook receiver (payments, refunds, claims + RazorpayX payout events). Signature-checked, replay-safe (event id), idempotent.
//
// Events can arrive in any order: a refund or claim for a payment we have not yet seen a sale for is stored and replayed when the sale
// is recorded (see sales.js applyBufferedEvents). Payout events that do not fit the payout's current state never make Razorpay retry
// forever: they are acknowledged and written to the action log as "needs review" for the owner.

import { HttpError, hmacHex, timingSafeEqualStr } from './util.js';
import { atomic, auditStmts } from './chain.js';
import { confirmPayment, applyRefund, setDispute, disputeStateFor } from './sales.js';
import { markPaid, markFailed } from './payouts.js';

export async function verifyRazorpaySignature(ctx, req, rawBody) {
  const sig = req.headers.get('x-razorpay-signature');
  if (!sig) throw new HttpError(401, 'signature_required', 'X-Razorpay-Signature missing');
  const expect = await hmacHex(ctx.secret('RAZORPAY_WEBHOOK_SECRET'), rawBody);
  if (!timingSafeEqualStr(expect, sig.toLowerCase())) throw new HttpError(401, 'invalid_signature', 'signature does not match');
}

/** The event id is derived from the SIGNED body (event type + entity id), never from a header, so a replay with a new header still dedupes. */
export async function handleRazorpayWebhook(ctx, req, rawBody) {
  await verifyRazorpaySignature(ctx, req, rawBody);
  let evt;
  try { evt = JSON.parse(rawBody); } catch { throw new HttpError(400, 'invalid_json', 'body is not JSON'); }
  const type = String(evt.event || '');
  if (!type) throw new HttpError(422, 'invalid_event', 'event type missing');
  const pay = evt.payload?.payment?.entity;
  const ref = evt.payload?.refund?.entity;
  const po = evt.payload?.payout?.entity;
  const disp = evt.payload?.dispute?.entity;
  const entityId = ref?.id || disp?.id || po?.id || pay?.id;
  const eventId = entityId ? `${type}:${entityId}` : `body:${await ctx.hash(rawBody)}`;
  const paymentId = pay?.id || ref?.payment_id || disp?.payment_id || null;
  const amount = pay?.amount ?? ref?.amount ?? disp?.amount ?? po?.amount ?? null;

  const ins = await ctx.db.run(
    'INSERT OR IGNORE INTO razorpay_events (event_id,type,payment_id,order_id,amount_minor,ts) VALUES (?,?,?,?,?,?)',
    [eventId, type, paymentId, pay?.order_id || null, Number.isInteger(amount) ? amount : null, ctx.now()]);
  if (ins.changes === 0) return { ok: true, duplicate: true };

  const actx = { ...ctx, actor: { type: 'razorpay', id: eventId } };
  const result = { ok: true, type };
  try {
    await processEvent(ctx, actx, { type, pay, ref, po, disp, result });
  } catch (e) {
    // Forget the event so the provider's retry gets processed instead of being swallowed as a duplicate.
    await ctx.db.run('DELETE FROM razorpay_events WHERE event_id=?', [eventId]);
    throw e;
  }
  return result;
}

const review = (actx, action, target, meta) => atomic(actx, () => auditStmts(actx, [{ action, target, meta }]));

async function processEvent(ctx, actx, { type, pay, ref, po, disp, result }) {
  if (type === 'payment.captured' && pay?.id) {
    result.confirmed = await confirmPayment(actx, pay.id, pay.amount, pay.order_id || null);
  } else if (type === 'refund.processed' && ref?.payment_id) {
    const sale = await ctx.db.first('SELECT * FROM sales WHERE razorpay_payment_id=?', [ref.payment_id]);
    if (sale) {
      // Cumulative: several partial refunds that add up to the whole payment count as a full refund. The row for THIS event is already stored.
      const total = (await ctx.db.first("SELECT COALESCE(SUM(amount_minor),0) AS n FROM razorpay_events WHERE payment_id=? AND type='refund.processed'", [ref.payment_id])).n;
      if (total >= sale.amount_minor) {
        await applyRefund(actx, sale, { reason: 'razorpay refund.processed' });
        result.refunded = true;
      } else {
        // Partial refunds are not auto-applied: they need a human decision on how much commission to give back.
        await review(actx, 'sale.partial_refund_review', `sale:${sale.id}`, { refund_minor: ref.amount, refunded_total_minor: total, sale_minor: sale.amount_minor });
        result.needs_review = true;
      }
    }
  } else if (type.startsWith('payment.dispute.') && disp?.payment_id) {
    const sale = await ctx.db.first('SELECT * FROM sales WHERE razorpay_payment_id=?', [disp.payment_id]);
    const state = disputeStateFor(type, null);
    if (sale && state) {
      await setDispute(actx, sale, state, `razorpay ${type}${disp.id ? ' ' + disp.id : ''}`);
      result.claim = state;
    } else if (sale) {
      // 'closed' on its own does not say who won: leave the hold in place and ask the owner.
      await review(actx, 'sale.claim_review', `sale:${sale.id}`, { event: type, dispute_id: disp.id || null });
      result.needs_review = true;
    }
  } else if (type.startsWith('payout.') && po?.id) {
    const payout = await ctx.db.first('SELECT * FROM payouts WHERE provider_ref=? OR id=?', [po.id, po.reference_id || '']);
    if (!payout) return;
    result.payout = payout.id;
    try {
      if (type === 'payout.processed') {
        if (!['processing', 'approved'].includes(payout.status)) {
          // e.g. the owner never approved it, or it was rejected: a provider event must never turn that into "paid".
          await review(actx, 'payout.event_unexpected', `payout:${payout.id}`, { event: type, payout_status: payout.status });
          result.needs_review = true;
        } else if (Number.isInteger(po.amount) && po.amount !== payout.net_minor) {
          await review(actx, 'payout.amount_mismatch', `payout:${payout.id}`, { event: type, provider_amount: po.amount, expected: payout.net_minor });
          result.needs_review = true;
        } else await markPaid(actx, payout.id, po.utr || po.id);
      } else if (type === 'payout.failed' || type === 'payout.reversed' || type === 'payout.rejected') {
        // A payout we already recorded as paid can still bounce: that releases the money back to the partner.
        await markFailed(actx, payout.id, po.failure_reason || type, { reversal: true, definitive: true });
      }
    } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 409) throw e;
      await review(actx, 'payout.event_conflict', `payout:${payout.id}`, { event: type, payout_status: payout.status, error: e.code });
      result.needs_review = true;
    }
  }
}
