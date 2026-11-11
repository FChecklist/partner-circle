// Append-only hash chains for the money ledger and the action (audit) log.
// Each row stores prev_hash + hash = sha256(prev_hash | fields). Database triggers reject UPDATE/DELETE,
// and verifyChain() recomputes every hash so any out-of-band tampering is detectable.

import { sha256Hex, newId } from './util.js';

export const GENESIS = '0'.repeat(64);

const ledgerFields = (r) => [r.seq, r.id, r.ts, r.account_id, r.kind, r.amount_minor, r.sale_id ?? '', r.payout_id ?? '', r.eligible_at, r.ref, r.memo ?? ''];
export const auditFields = (r) => [r.seq, r.ts, r.actor_type, r.actor_id ?? '', r.key_id ?? '', r.action, r.target ?? '', r.meta ?? ''];

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

// Writers in one isolate queue up here, so contention only remains between separate isolates / servers.
let gateTail = Promise.resolve();

/**
 * Run `build()` (which returns statements, reading chain tails itself) as one atomic batch.
 * If a concurrent writer (another isolate) took the same seq, rebuild from the new tail and retry with jittered backoff.
 */
export async function atomic(ctx, build) {
  const prev = gateTail;
  let release;
  gateTail = prev.then(() => new Promise((r) => { release = r; }));
  await prev;
  try {
    let lastErr;
    for (let i = 0; i < 25; i++) {
      const stmts = await build();
      try {
        await ctx.db.batch(stmts);
        return;
      } catch (e) {
        lastErr = e;
        if (!SEQ_CONFLICT.test(String(e?.message || e))) throw e;
        await new Promise((r) => setTimeout(r, Math.random() * 15 * (i + 1)));
      }
    }
    throw lastErr;
  } finally {
    release();
  }
}

export async function audit(ctx, action, target, meta) {
  await atomic(ctx, () => auditStmts(ctx, [{ action, target, meta }]));
}

const PAGE = 500;

/**
 * Re-hash a chain. Default = the whole chain from genesis (used by tests and offline checks).
 * { incremental: true, now } = the cheap path for the live endpoint: re-check that the last checkpoint row still carries the hash
 * we recorded (which anchors everything before it, since each hash covers its predecessor), then verify at most `max` newer rows
 * and move the checkpoint forward. One call never reads more than `max` rows, so it stays inside Workers/D1 free-tier limits.
 */
async function verifyChain(db, table, fieldsFn, { incremental = false, max = 2000, now = Date.now() } = {}) {
  let prev = GENESIS;
  let expectSeq = 1;
  if (incremental) {
    const cp = await db.first('SELECT * FROM chain_checkpoints WHERE chain=?', [table]);
    if (cp) {
      const anchor = await db.first(`SELECT hash FROM ${table} WHERE seq=?`, [cp.seq]);
      if (!anchor || anchor.hash !== cp.hash) return { ok: false, broken_at: cp.seq, reason: 'checkpoint row changed or missing', mode: 'incremental' };
      prev = cp.hash;
      expectSeq = cp.seq + 1;
    }
  }
  const total = (await db.first(`SELECT COUNT(*) AS n FROM ${table}`)).n;
  const limit = incremental ? max : Infinity;
  let checked = 0;
  let lastSeq = expectSeq - 1;
  while (checked < limit) {
    const rows = await db.all(`SELECT * FROM ${table} WHERE seq >= ? ORDER BY seq LIMIT ?`, [expectSeq, Math.min(PAGE, limit - checked)]);
    if (!rows.length) break;
    for (const r of rows) {
      if (r.seq !== expectSeq) return { ok: false, rows: total, broken_at: r.seq, reason: 'sequence gap' };
      if (r.prev_hash !== prev) return { ok: false, rows: total, broken_at: r.seq, reason: 'prev_hash mismatch' };
      const h = await sha256Hex([prev, ...fieldsFn(r)].join('|'));
      if (h !== r.hash) return { ok: false, rows: total, broken_at: r.seq, reason: 'hash mismatch' };
      prev = r.hash;
      lastSeq = r.seq;
      expectSeq += 1;
      checked += 1;
    }
  }
  if (!incremental) return { ok: true, rows: total };
  if (checked) {
    await db.run('INSERT INTO chain_checkpoints (chain,seq,hash,verified_at) VALUES (?,?,?,?) ON CONFLICT(chain) DO UPDATE SET seq=excluded.seq, hash=excluded.hash, verified_at=excluded.verified_at', [table, lastSeq, prev, now]);
  }
  return { ok: true, rows: total, checked, verified_through: lastSeq, complete: lastSeq >= total, mode: 'incremental' };
}

export const verifyLedger = (db, opts) => verifyChain(db, 'ledger', ledgerFields, opts);
export const verifyAudit = (db, opts) => verifyChain(db, 'audit_log', auditFields, opts);
