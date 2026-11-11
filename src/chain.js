// Append-only hash chains for the money ledger and the action (audit) log.
// Each row stores prev_hash + hash = sha256(prev_hash | fields). Database triggers reject UPDATE/DELETE,
// and verifyChain() recomputes every hash so any out-of-band tampering is detectable.

import { sha256Hex, newId } from './util.js';

const GENESIS = '0'.repeat(64);

const ledgerFields = (r) => [r.seq, r.id, r.ts, r.account_id, r.kind, r.amount_minor, r.sale_id ?? '', r.payout_id ?? '', r.eligible_at, r.ref, r.memo ?? ''];
const auditFields = (r) => [r.seq, r.ts, r.actor_type, r.actor_id ?? '', r.key_id ?? '', r.action, r.target ?? '', r.meta ?? ''];

async function tail(db, table) {
  const r = await db.first(`SELECT seq, hash FROM ${table} ORDER BY seq DESC LIMIT 1`);
  return r ? { seq: r.seq, hash: r.hash } : { seq: 0, hash: GENESIS };
}

/** Build INSERT statements that extend the ledger chain. entries: [{account_id, kind, amount_minor, sale_id, payout_id, eligible_at, ref, memo}] */
export async function ledgerStmts(ctx, entries) {
  let { seq, hash } = await tail(ctx.db, 'ledger');
  const out = [];
  for (const e of entries) {
    seq += 1;
    const row = {
      seq,
      id: newId('le'),
      ts: ctx.now(),
      account_id: e.account_id,
      kind: e.kind,
      amount_minor: e.amount_minor,
      sale_id: e.sale_id ?? null,
      payout_id: e.payout_id ?? null,
      eligible_at: e.eligible_at,
      ref: e.ref,
      memo: e.memo ?? null,
    };
    const h = await sha256Hex([hash, ...ledgerFields(row)].join('|'));
    out.push({
      sql: 'INSERT INTO ledger (seq,id,ts,account_id,kind,amount_minor,sale_id,payout_id,eligible_at,ref,memo,prev_hash,hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      params: [row.seq, row.id, row.ts, row.account_id, row.kind, row.amount_minor, row.sale_id, row.payout_id, row.eligible_at, row.ref, row.memo, hash, h],
    });
    hash = h;
  }
  return out;
}

/** Build INSERT statements for the action log. entries: [{action, target, meta}] — actor comes from ctx.actor. */
export async function auditStmts(ctx, entries) {
  let { seq, hash } = await tail(ctx.db, 'audit_log');
  const a = ctx.actor || { type: 'system' };
  const out = [];
  for (const e of entries) {
    seq += 1;
    const row = {
      seq,
      ts: ctx.now(),
      actor_type: a.type,
      actor_id: a.id ?? null,
      key_id: a.keyId ?? null,
      action: e.action,
      target: e.target ?? null,
      meta: e.meta ? JSON.stringify(e.meta) : null,
    };
    const h = await sha256Hex([hash, ...auditFields(row)].join('|'));
    out.push({
      sql: 'INSERT INTO audit_log (seq,ts,actor_type,actor_id,key_id,action,target,meta,prev_hash,hash) VALUES (?,?,?,?,?,?,?,?,?,?)',
      params: [row.seq, row.ts, row.actor_type, row.actor_id, row.key_id, row.action, row.target, row.meta, hash, h],
    });
    hash = h;
  }
  return out;
}

const SEQ_CONFLICT = /UNIQUE constraint failed: (ledger|audit_log)\.(seq|id)|PRIMARY KEY/i;

/**
 * Run `build()` (which returns statements, reading chain tails itself) as one atomic batch.
 * If a concurrent writer took the same seq, rebuild from the new tail and retry.
 */
export async function atomic(ctx, build) {
  let lastErr;
  for (let i = 0; i < 8; i++) {
    const stmts = await build();
    try {
      await ctx.db.batch(stmts);
      return;
    } catch (e) {
      lastErr = e;
      if (!SEQ_CONFLICT.test(String(e?.message || e))) throw e;
    }
  }
  throw lastErr;
}

export async function audit(ctx, action, target, meta) {
  await atomic(ctx, () => auditStmts(ctx, [{ action, target, meta }]));
}

async function verifyChain(db, table, fieldsFn) {
  const rows = await db.all(`SELECT * FROM ${table} ORDER BY seq`);
  let prev = GENESIS;
  let expectSeq = 1;
  for (const r of rows) {
    if (r.seq !== expectSeq) return { ok: false, rows: rows.length, broken_at: r.seq, reason: 'sequence gap' };
    if (r.prev_hash !== prev) return { ok: false, rows: rows.length, broken_at: r.seq, reason: 'prev_hash mismatch' };
    const h = await sha256Hex([prev, ...fieldsFn(r)].join('|'));
    if (h !== r.hash) return { ok: false, rows: rows.length, broken_at: r.seq, reason: 'hash mismatch' };
    prev = r.hash;
    expectSeq += 1;
  }
  return { ok: true, rows: rows.length };
}

export const verifyLedger = (db) => verifyChain(db, 'ledger', ledgerFields);
export const verifyAudit = (db) => verifyChain(db, 'audit_log', auditFields);
