// Create the FIRST owner key for a real deployment WITHOUT printing it, and write it into the action log in the same go.
//   node scripts/mint-owner-key.mjs        -> secret to .data/owner-key.txt (git-ignored), SQL to .data/owner-key.sql
//   wrangler d1 execute partner-circle --remote --file=.data/owner-key.sql
// Only sha256(secret) goes into the SQL; the secret itself stays in the local file until you move it to a password manager.
//
// The SQL inserts the key AND action-log row #1 ("key.bootstrap") so the very first privileged key is in the hash chain like every other.
// Both statements are guarded so they only apply to a FRESH database (no owner key and an empty action log). For any later key use
// POST /v1/admin/keys with the existing owner key, which audits it atomically.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ROOT } from './lib.mjs';
import { GENESIS, auditFields } from '../src/chain.js';

const q = (v) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

/** Pure function so the test can run the exact SQL against an empty database and then verify the chain. */
export function ownerKeySql({ id, secret, now }) {
  const hash = createHash('sha256').update(secret).digest('hex');
  const row = { seq: 1, ts: now, actor_type: 'bootstrap', actor_id: null, key_id: id, action: 'key.bootstrap', target: `key:${id}`, meta: JSON.stringify({ kind: 'owner', via: 'scripts/mint-owner-key.mjs' }) };
  const h = createHash('sha256').update([GENESIS, ...auditFields(row)].join('|')).digest('hex');
  const fresh = "NOT EXISTS (SELECT 1 FROM audit_log) AND NOT EXISTS (SELECT 1 FROM api_keys WHERE kind='owner')";
  return [
    `INSERT INTO api_keys (id,kind,label,hash,scopes,rate_per_min,created_by,created_at) SELECT ${[id, 'owner', 'first owner key', hash, '["*"]', 120, 'bootstrap', now].map(q).join(',')} WHERE ${fresh};`,
    `INSERT INTO audit_log (seq,ts,actor_type,actor_id,key_id,action,target,meta,prev_hash,hash) SELECT ${[row.seq, row.ts, row.actor_type, row.actor_id, row.key_id, row.action, row.target, row.meta, GENESIS, h].map(q).join(',')} WHERE NOT EXISTS (SELECT 1 FROM audit_log) AND EXISTS (SELECT 1 FROM api_keys WHERE id=${q(id)});`,
    '',
  ].join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const id = randomBytes(6).toString('hex');
  const secret = randomBytes(24).toString('hex');
  mkdirSync(join(ROOT, '.data'), { recursive: true });
  writeFileSync(join(ROOT, '.data', 'owner-key.txt'), `pck_${id}.${secret}\n`, { mode: 0o600 });
  writeFileSync(join(ROOT, '.data', 'owner-key.sql'), ownerKeySql({ id, secret, now: Date.now() }));
  console.log('Owner key saved to .data/owner-key.txt (not printed). SQL written to .data/owner-key.sql (fresh database only).');
}
