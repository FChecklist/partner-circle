// Print the INSERT statements that seed the nine sites, for a real D1 database:
//   node scripts/sites-sql.mjs > .data/sites.sql
//   wrangler d1 execute partner-circle --remote --file=.data/sites.sql
import { DEFAULT_SITES } from '../src/policy.js';

const q = (v) => (typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const now = Date.now();
for (const s of DEFAULT_SITES) {
  console.log(
    `INSERT OR IGNORE INTO sites (id,host,name,return_days,buffer_days,early_release_bps,commission_bps,refer_bps,discount_allowed,max_discount_bps,active,host_confirmed,created_at) VALUES (${[
      s.id, s.host, s.name, s.return_days, 7, s.early_release_bps, s.commission_bps, s.refer_bps, s.discount_allowed, s.max_discount_bps, s.confirmed, s.confirmed, now,
    ].map(q).join(',')});`,
  );
}
