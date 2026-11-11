// Node-only helpers for local dev, seeding and tests (never imported by the Worker bundle).
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sqliteDb } from '../src/db.js';
import { seedSiteStmts } from '../src/policy.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function migrationFiles() {
  const dir = join(ROOT, 'migrations');
  return readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort().map((f) => ({ name: f, sql: readFileSync(join(dir, f), 'utf8') }));
}

export function openDb(path = ':memory:') {
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  const have = new Set();
  try { raw.prepare('SELECT name FROM _migrations').all().forEach((r) => have.add(r.name)); } catch { raw.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)'); }
  for (const m of migrationFiles()) {
    if (have.has(m.name)) continue;
    raw.exec(m.sql);
    raw.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(m.name, Date.now());
  }
  return { raw, db: sqliteDb(raw) };
}

export async function seedSites(db, now = Date.now()) {
  await db.batch(seedSiteStmts(now));
}
