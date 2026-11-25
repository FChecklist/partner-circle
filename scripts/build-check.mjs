// "Build" for a no-bundler project: syntax-check every JS file, make sure migrations apply to an empty DB and seed cleanly.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, openDb, seedSites, migrationFiles } from './lib.mjs';

const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? (f === 'node_modules' || f === '.data' || f === '.git' ? [] : walk(p)) : [p]; });
const js = walk(ROOT).filter((f) => /\.(m?js)$/.test(f));
let bad = 0;
for (const f of js) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) { bad++; console.error(`SYNTAX ${f}\n${r.stderr}`); }
}
const { db } = openDb();
await seedSites(db);
const sites = (await db.first('SELECT COUNT(*) AS n FROM sites')).n;
console.log(`checked ${js.length} JS files, ${migrationFiles().length} migrations, ${sites} seeded sites`);
if (bad || sites !== 9) process.exit(1);
