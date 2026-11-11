// Create the first owner key for a real deployment WITHOUT printing it.
//   node scripts/mint-owner-key.mjs        -> writes the secret to .data/owner-key.txt (git-ignored) and the SQL to .data/owner-key.sql
//   wrangler d1 execute partner-circle --remote --file=.data/owner-key.sql
// Only sha256(secret) goes into the SQL; the secret itself stays in the local file until you move it to a password manager.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { ROOT } from './lib.mjs';

const id = randomBytes(6).toString('hex');
const secret = randomBytes(24).toString('hex');
const hash = createHash('sha256').update(secret).digest('hex');
mkdirSync(join(ROOT, '.data'), { recursive: true });
writeFileSync(join(ROOT, '.data', 'owner-key.txt'), `pck_${id}.${secret}\n`, { mode: 0o600 });
writeFileSync(join(ROOT, '.data', 'owner-key.sql'),
  `INSERT INTO api_keys (id,kind,label,hash,scopes,rate_per_min,created_by,created_at) VALUES ('${id}','owner','first owner key','${hash}','["*"]',120,'bootstrap',${Date.now()});\n`);
console.log('Owner key saved to .data/owner-key.txt (not printed). SQL written to .data/owner-key.sql.');
