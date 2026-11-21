// Balances, payout requests, the owner approval queue and payout settlement.
//
// Rules (owner, 9-11 Nov): a commission is payable only when (1) the sale is recorded and not refunded, (2) Razorpay confirmed
// the same payment, (3) no claim/chargeback is open on it, and (4) eligible_at has passed (return window + 7-day buffer).
// No clawback after a payout is SENT. Every payout needs the owner's approval; the AI can prepare but never approve.
// Payout RECORDING lives here; the money movement itself goes through ctx.payouts (mock by default).
//
// The destination (UPI id / bank account) is copied, encrypted, onto the payout when it is requested and only that copy is ever paid to,
// so editing the partner's KYC afterwards cannot redirect an existing payout.

import { HttpError, newId, encryptField, decryptField } from './util.js';
import { atomic, auditStmts, ledgerStmts } from './chain.js';
import { getPolicy } from './policy.js';
import { decryptKyc, kycReviewView, destinationHint } from './users.js';
import { reconcilePending } from './sales.js';
import { notify } from './notify.js';

const OPEN = ['pending_approval', 'approved', 'processing'];

const AVAILABLE_SQL = `
  FROM ledger l LEFT JOIN sales s ON s.id = l.sale_id
 WHERE l.account_id = ? AND l.eligible_at <= ?
   AND ((l.kind IN ('commission','override') AND s.status = 'recorded' AND s.rzp_status = 'confirmed' AND COALESCE(s.dispute_status,'') <> 'open') OR l.kind = 'adjustment')
   AND NOT EXISTS (SELECT 1 FROM payout_items pi WHERE pi.ledger_seq = l.seq)
   AND NOT EXISTS (SELECT 1 FROM mp_postings mp WHERE mp.ledger_seq = l.seq)`; // an entry handed to Moneypenny can never also be paid out here

export async function availableEntries(ctx, userId) {
  return ctx.db.all(`SELECT l.seq, l.amount_minor ${AVAILABLE_SQL} ORDER BY l.seq`, [userId, ctx.now()]);
}

export async function balances(ctx, userId) {
  const now = ctx.now();
  const sum = async (sql, params) => (await ctx.db.first(sql, params)).n || 0;
  const available = await sum(`SELECT SUM(l.amount_minor) AS n ${AVAILABLE_SQL}`, [userId, now]);
  const live = `FROM ledger l LEFT JOIN sales s ON s.id = l.sale_id
     WHERE l.account_id = ? AND NOT EXISTS (SELECT 1 FROM payout_items pi WHERE pi.ledger_seq = l.seq)
       AND NOT EXISTS (SELECT 1 FROM mp_postings mp WHERE mp.ledger_seq = l.seq)
       AND ((l.kind IN ('commission','override') AND s.status = 'recorded') OR l.kind = 'adjustment')`;
  const pendingAll = await sum(`SELECT SUM(l.amount_minor) AS n ${live}`, [userId]);
  const awaitingRzp = await sum(`SELECT SUM(l.amount_minor) AS n ${live} AND l.kind <> 'adjustment' AND l.eligible_at <= ? AND s.rzp_status <> 'confirmed'`, [userId, now]);
  const onClaim = await sum(`SELECT SUM(l.amount_minor) AS n ${live} AND l.kind <> 'adjustment' AND s.dispute_status = 'open'`, [userId]);
  const inPayout = await sum(`SELECT SUM(gross_minor) AS n FROM payouts WHERE user_id=? AND status IN ('pending_approval','approved','processing')`, [userId]);
  const paid = await sum(`SELECT SUM(gross_minor) AS n FROM payouts WHERE user_id=? AND status='paid'`, [userId]);
  const ledgerTotal = await sum('SELECT SUM(amount_minor) AS n FROM ledger WHERE account_id=?', [userId]);
  return {
    available_minor: available,
    pending_minor: pendingAll - available,
    awaiting_razorpay_minor: awaitingRzp,
    on_claim_minor: onClaim,
    in_payout_minor: inPayout,
    paid_minor: paid,
    ledger_total_minor: ledgerTotal, // always equals available + pending: the double-entry self-check
  };
}

export const payoutView = (p) => ({
  id: p.id, user_id: p.user_id, gross_minor: p.gross_minor, tds_bps: p.tds_bps, tds_minor: p.tds_minor, net_minor: p.net_minor, status: p.status,
  method: p.method, destination_masked: p.destination_masked, provider: p.provider, provider_mode: p.provider_mode ?? null, provider_ref: p.provider_ref, paid_ref: p.paid_ref,
  paid_at: p.paid_at, approved_at: p.approved_at, note: p.note, created_at: p.created_at, reversed_at: p.reversed_at ?? null,
});

export async function requestPayout(ctx, user) {
  if (user.status !== 'active') throw new HttpError(403, 'not_active', 'your account is not active');
  if (!user.email_verified) throw new HttpError(409, 'email_unverified', 'verify your e-mail before your first payout');
  const kycRow = await ctx.db.first('SELECT status FROM user_kyc WHERE user_id=?', [user.id]);
  if (!kycRow || kycRow.status !== 'verified') throw new HttpError(409, 'kyc_required', 'payout details must be submitted and verified first');
  const policy = await getPolicy(ctx);
  await reconcilePending(ctx, user.id);
  if (await ctx.db.first(`SELECT 1 AS x FROM payouts WHERE user_id=? AND status IN ('pending_approval','approved','processing')`, [user.id])) {
    throw new HttpError(409, 'payout_open', 'you already have a payout in progress');
  }
  const entries = await availableEntries(ctx, user.id);
  const gross = entries.reduce((a, e) => a + e.amount_minor, 0);
  if (gross <= 0 || gross < policy.min_payout_minor) {
    throw new HttpError(422, 'below_minimum', `available balance ${gross} is below the minimum payout ${policy.min_payout_minor} (paise)`, { available_minor: gross, min_payout_minor: policy.min_payout_minor });
  }
  const india = user.country === 'IN';
  const kyc = await decryptKyc(ctx, user.id);
  const method = india ? 'upi' : 'bank';
  const tdsBps = india ? policy.tds_bps_default : 0;
  const tds = Math.floor((gross * tdsBps) / 10000);
  const id = newId('po');
  const snapshot = india ? { upi_id: kyc.upi_id } : { bank_account: kyc.bank_account, bank_ifsc_swift: kyc.bank_ifsc_swift, bank_name: kyc.bank_name };
  const destEnc = await encryptField(ctx.secret('KYC_KEY'), JSON.stringify({ ...snapshot, name: user.name }));
  try {
    await atomic(ctx, async () => {
      // re-select inside the builder: a refund / claim / hold that landed since the read above changes the set, and the request is refused (never built from a stale list)
      const now = await availableEntries(ctx, user.id);
      if (now.length !== entries.length || now.some((e, i) => e.seq !== entries[i].seq || e.amount_minor !== entries[i].amount_minor)) {
        throw new HttpError(409, 'balance_changed', 'your balance changed while the request was being made; check it and ask again');
      }
      return [
      {
        sql: `INSERT INTO payouts (id,user_id,gross_minor,tds_bps,tds_minor,net_minor,status,requested_by_key,method,destination_masked,dest_enc,created_at)
              VALUES (?,?,?,?,?,?, 'pending_approval', ?,?,?,?,?)`,
        params: [id, user.id, gross, tdsBps, tds, gross - tds, ctx.actor?.keyId || 'system', method, destinationHint(kyc, india), destEnc, ctx.now()],
      },
      ...entries.map((e) => ({ sql: 'INSERT INTO payout_items (ledger_seq,payout_id,amount_minor) VALUES (?,?,?)', params: [e.seq, id, e.amount_minor] })),
      ...(await ledgerStmts(ctx, [{ account_id: user.id, kind: 'payout_reserve', amount_minor: -gross, payout_id: id, eligible_at: ctx.now(), ref: `reserve:${id}`, memo: 'payout requested' }])),
      ...(await auditStmts(ctx, [{ action: 'payout.request', target: `payout:${id}`, meta: { gross_minor: gross, tds_minor: tds, items: entries.length } }])),
      ];
    });
  } catch (e) {
    if (/one_open_payout|UNIQUE constraint failed: (payouts\.user_id|payout_items)/.test(String(e.message))) throw new HttpError(409, 'payout_open', 'a payout is already in progress');
    if (/already posted to Moneypenny/.test(String(e.message))) throw new HttpError(409, 'balance_changed', 'part of your balance just moved to Moneypenny; check your balance and ask again');
    throw e;
  }
  return payoutView(await ctx.db.first('SELECT * FROM payouts WHERE id=?', [id]));
}

async function getPayout(ctx, id) {
  const p = await ctx.db.first('SELECT * FROM payouts WHERE id=?', [id]);
  if (!p) throw new HttpError(404, 'not_found', 'payout not found');
  return p;
}

/** The frozen destination of a payout, decrypted. Owner-only (the manual, non-India payment needs it). Every reveal is audited. */
export async function revealPayoutDestination(ctx, id) {
  const p = await getPayout(ctx, id);
  if (!p.dest_enc) throw new HttpError(404, 'not_found', 'no destination stored for this payout');
  await atomic(ctx, () => auditStmts(ctx, [{ action: 'payout.destination_revealed', target: `payout:${id}` }]));
  return { payout_id: id, method: p.method, net_minor: p.net_minor, destination: JSON.parse(await decryptField(ctx.secret('KYC_KEY'), p.dest_enc)) };
}

/** Release the reserved balance back to the partner (rejected, failed or reversed payout) and free its ledger entries. */
async function releaseStmts(ctx, p, why) {
  // A sale refunded while its commission sat in this (now released) payout must not become payable again: void it now
  // (unless the refund already voided it).
  const refunded = await ctx.db.all(
    `SELECT l.id, l.account_id, l.amount_minor, l.sale_id, l.eligible_at FROM payout_items pi JOIN ledger l ON l.seq = pi.ledger_seq
       JOIN sales s ON s.id = l.sale_id WHERE pi.payout_id=? AND s.status='refunded'
        AND NOT EXISTS (SELECT 1 FROM ledger v WHERE v.ref = 'void:' || l.id)`, [p.id]);
  return [
    { sql: 'DELETE FROM payout_items WHERE payout_id=?', params: [p.id] },
    ...(await ledgerStmts(ctx, [
      { account_id: p.user_id, kind: 'payout_release', amount_minor: p.gross_minor, payout_id: p.id, eligible_at: ctx.now(), ref: `release:${p.id}`, memo: why },
      ...refunded.map((e) => ({ account_id: e.account_id, kind: 'void', amount_minor: -e.amount_minor, sale_id: e.sale_id, eligible_at: e.eligible_at, ref: `void:${e.id}`, memo: 'refund after payout released' })),
    ])),
  ];
}

export async function rejectPayout(ctx, id, note) {
  const p = await getPayout(ctx, id);
  if (!['pending_approval', 'approved'].includes(p.status)) throw new HttpError(409, 'bad_state', `a ${p.status} payout cannot be rejected`);
  await atomic(ctx, async () => {
    const cur = await ctx.db.first('SELECT status, sent_at FROM payouts WHERE id=?', [id]);
    if (!cur || !['pending_approval', 'approved'].includes(cur.status)) throw new HttpError(409, 'bad_state', 'the payout changed; reload it');
    // the provider may have been contacted (sent_at): the outcome is unknown, so it can never be rejected as "not sent"
    if (cur.sent_at != null) throw new HttpError(409, 'maybe_sent', 'the provider may already have paid this; check there, then mark it paid or failed');
    return [
      { sql: "UPDATE payouts SET status='rejected', note=? WHERE id=? AND status IN ('pending_approval','approved') AND sent_at IS NULL", params: [note || null, id] },
      ...(await releaseStmts(ctx, p, 'payout rejected')),
      ...(await auditStmts(ctx, [{ action: 'payout.reject', target: `payout:${id}`, meta: { note: note || null } }])),
    ];
  });
  await notify(ctx, p.user_id, 'Your payout request was not approved', 'Your payout request was not approved this time. The money is back in your balance.');
  return payoutView(await getPayout(ctx, id));
}

/** Owner approval. Moves pending_approval -> approved, then hands the payout to the provider adapter. */
export async function approvePayout(ctx, id, { execute = true } = {}) {
  const p = await getPayout(ctx, id);
  if (p.status !== 'pending_approval') throw new HttpError(409, 'bad_state', `payout is ${p.status}, not pending_approval`);
  const kyc = await ctx.db.first('SELECT status FROM user_kyc WHERE user_id=?', [p.user_id]);
  if (kyc?.status !== 'verified') throw new HttpError(409, 'kyc_required', 'KYC is no longer verified for this partner');
  await atomic(ctx, async () => {
    // re-checked inside the builder: a concurrent approve, or a sale refunded / put on hold since the request, stops this one
    const cur = await ctx.db.first('SELECT status FROM payouts WHERE id=?', [id]);
    if (!cur || cur.status !== 'pending_approval') throw new HttpError(409, 'bad_state', 'the payout is no longer waiting for approval');
    const bad = await ctx.db.first(`SELECT 1 AS x FROM payout_items pi JOIN ledger l ON l.seq = pi.ledger_seq LEFT JOIN sales s ON s.id = l.sale_id
       WHERE pi.payout_id=? AND l.kind IN ('commission','override') AND (s.status <> 'recorded' OR COALESCE(s.dispute_status,'') = 'open') LIMIT 1`, [id]);
    if (bad) throw new HttpError(409, 'sale_changed', 'a sale in this payout was refunded or put on hold; reject the payout');
    return [
      { sql: "UPDATE payouts SET status='approved', approved_by_key=?, approved_at=? WHERE id=? AND status='pending_approval'", params: [ctx.actor.keyId, ctx.now(), id] },
      ...(await auditStmts(ctx, [{ action: 'payout.approve', target: `payout:${id}`, meta: { gross_minor: p.gross_minor, net_minor: p.net_minor } }])),
    ];
  });
  return execute ? executePayout(ctx, id) : payoutView(await getPayout(ctx, id));
}

export async function executePayout(ctx, id) {
  const p = await getPayout(ctx, id);
  if (p.status !== 'approved') throw new HttpError(409, 'bad_state', `payout is ${p.status}, not approved`);
  const user = await ctx.db.first('SELECT * FROM users WHERE id=?', [p.user_id]);
  if (user.country !== 'IN') {
    // RazorpayX pays Indian UPI/IMPS only. Cross-border payouts are recorded here and paid by the owner outside the API.
    await atomic(ctx, async () => [
      { sql: "UPDATE payouts SET status='processing', provider='manual' WHERE id=? AND status='approved'", params: [id] },
      ...(await auditStmts(ctx, [{ action: 'payout.manual', target: `payout:${id}`, meta: { country: user.country, note: 'pay outside the API, then POST /v1/admin/payouts/:id/mark-paid' } }])),
    ]);
    return payoutView(await getPayout(ctx, id));
  }
  if (!p.dest_enc) throw new HttpError(409, 'no_destination', 'this payout has no stored destination');
  const destination = JSON.parse(await decryptField(ctx.secret('KYC_KEY'), p.dest_enc));
  // Mark "the provider may now have been contacted" BEFORE the call (compare-and-set on attempts: a concurrent execute loses and stops).
  await atomic(ctx, async () => {
    const cur = await ctx.db.first('SELECT status, attempts FROM payouts WHERE id=?', [id]);
    if (!cur || cur.status !== 'approved' || cur.attempts !== p.attempts) throw new HttpError(409, 'bad_state', 'another request is already executing this payout');
    return [
      { sql: "UPDATE payouts SET sent_at=COALESCE(sent_at, ?), attempts=attempts+1 WHERE id=? AND status='approved'", params: [ctx.now(), id] },
      ...(await auditStmts(ctx, [{ action: 'payout.sending', target: `payout:${id}`, meta: { attempt: p.attempts + 1 } }])),
    ];
  });
  let res;
  try {
    res = await ctx.payouts.createPayout({ payout_id: p.id, amount_minor: p.net_minor, method: p.method, destination, name: user.name });
  } catch (e) {
    await atomic(ctx, () => auditStmts(ctx, [{ action: 'payout.execute_failed', target: `payout:${id}`, meta: { error: String(e.message).slice(0, 200) } }]));
    throw e instanceof HttpError ? e : new HttpError(502, 'provider_error', 'the payout provider call failed; the outcome is unknown, so the payout stays approved (retry with the same id, or reconcile with the provider)');
  }
  await atomic(ctx, async () => [
    { sql: "UPDATE payouts SET status='processing', provider=?, provider_ref=?, provider_mode=? WHERE id=? AND status='approved'", params: [res.provider, res.provider_ref, res.mode || ctx.payouts.mode || null, id] },
    ...(await auditStmts(ctx, [{ action: 'payout.submitted', target: `payout:${id}`, meta: { provider: res.provider, provider_ref: res.provider_ref, mode: res.mode || ctx.payouts.mode || null } }])),
  ]);
  if (res.status === 'paid') return markPaid(ctx, id, res.provider_ref);
  return payoutView(await getPayout(ctx, id));
}

export async function markPaid(ctx, id, utr) {
  const p = await getPayout(ctx, id);
  if (p.status === 'paid') return payoutView(p);
  if (!['processing', 'approved'].includes(p.status)) throw new HttpError(409, 'bad_state', `a ${p.status} payout cannot be marked paid`);
  await atomic(ctx, async () => [
    { sql: "UPDATE payouts SET status='paid', paid_ref=?, paid_at=? WHERE id=? AND status IN ('processing','approved')", params: [utr || null, ctx.now(), id] },
    ...(await auditStmts(ctx, [{ action: 'payout.paid', target: `payout:${id}`, meta: { paid_ref: utr || null, gross_minor: p.gross_minor, net_minor: p.net_minor } }])),
  ]);
  await notify(ctx, p.user_id, 'Your payout has been sent', `Your payout of ${(p.net_minor / 100).toFixed(2)} rupees has been sent${utr ? ` (reference ${utr})` : ''}.`);
  return payoutView(await getPayout(ctx, id));
}

/**
 * The payout did not arrive: release the money back to the partner. With { reversal: true } this is also allowed on a payout we had
 * already marked 'paid' (the provider reversed it afterwards): status goes to 'failed' with reversed_at set, the reserve is released,
 * and the original paid_ref / paid_at stay on the row as history.
 */
export async function markFailed(ctx, id, reason, { reversal = false, definitive = false } = {}) {
  const p = await getPayout(ctx, id);
  if (p.status === 'failed') return payoutView(p);
  const allowed = reversal ? ['approved', 'processing', 'paid'] : ['approved', 'processing'];
  if (!allowed.includes(p.status)) throw new HttpError(409, 'bad_state', `a ${p.status} payout cannot be marked failed`);
  const wasPaid = p.status === 'paid';
  // A payout the provider may have been contacted about is only released on a DEFINITE answer (provider webhook failed/reversed, or the owner confirmed with the provider that nothing was sent).
  if (p.sent_at != null && !reversal && !definitive) throw new HttpError(409, 'maybe_sent', 'the provider may have paid this; confirm with the provider that nothing was sent, then mark it failed with confirmed_not_sent');
  await atomic(ctx, async () => [
    { sql: `UPDATE payouts SET status='failed', note=?, reversed_at=? WHERE id=? AND status IN (${allowed.map((s) => `'${s}'`).join(',')})`, params: [reason || null, wasPaid ? ctx.now() : null, id] },
    ...(await releaseStmts(ctx, p, wasPaid ? 'payout reversed by the provider' : 'payout failed')),
    ...(await auditStmts(ctx, [{ action: wasPaid ? 'payout.reversed' : 'payout.failed', target: `payout:${id}`, meta: { reason: reason || null, was_paid: wasPaid } }])),
  ]);
  await notify(ctx, p.user_id, 'Your payout could not be completed', 'Your payout could not be completed. The money is back in your balance and you can request it again.');
  return payoutView(await getPayout(ctx, id));
}

export async function listPayouts(ctx, userId) {
  return (await ctx.db.all('SELECT * FROM payouts WHERE user_id=? ORDER BY created_at DESC', [userId])).map(payoutView);
}

/** The owner's queue: what is waiting on a decision, with enough context to decide. */
export async function approvalQueue(ctx) {
  const policy = await getPolicy(ctx);
  const partners = await ctx.db.all("SELECT * FROM users WHERE status='pending' ORDER BY created_at");
  const kycRows = await ctx.db.all("SELECT k.user_id, k.country, k.submitted_at, u.name, u.handle FROM user_kyc k JOIN users u ON u.id = k.user_id WHERE k.status='submitted' ORDER BY k.submitted_at");
  const kyc = [];
  for (const k of kycRows) kyc.push({ ...k, details: await kycReviewView(ctx, k.user_id) });
  const payouts = await ctx.db.all(
    `SELECT p.*, u.name, u.handle,
        (SELECT COUNT(*) FROM payout_items pi JOIN ledger l ON l.seq = pi.ledger_seq JOIN sales s ON s.id = l.sale_id
          WHERE pi.payout_id = p.id AND s.refund_after_payout = 1) AS flagged_refunds
       FROM payouts p JOIN users u ON u.id = p.user_id WHERE p.status = 'pending_approval' ORDER BY p.created_at`);
  const claims = await ctx.db.all(
    `SELECT s.id, s.site_id, s.order_id, s.net_minor, s.disputed_at, s.dispute_note, u.name FROM sales s LEFT JOIN users u ON u.id = s.user_id
      WHERE s.dispute_status = 'open' ORDER BY s.disputed_at`);
  return {
    partners: partners.map((u) => ({ id: u.id, role: u.role, name: u.name, handle: u.handle, country: u.country, created_at: u.created_at })),
    kyc,
    payouts: payouts.map((p) => ({ ...payoutView(p), name: p.name, handle: p.handle, flagged_refunds: p.flagged_refunds })),
    claims,
    tds_confirmed: !!policy.tds_confirmed,
  };
}

export { OPEN as OPEN_PAYOUT_STATES };
