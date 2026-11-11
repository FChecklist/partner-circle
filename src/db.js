// Database adapters. The app talks to this tiny async interface only:
//   all(sql, params) -> rows[]   first(sql, params) -> row|null   run(sql, params) -> {changes}
//   batch([{sql, params}])       -> executes atomically (all or nothing)
// d1Db wraps Cloudflare D1; sqliteDb wraps node:sqlite (local dev and tests).

export function d1Db(d1) {
  const bind = (s) => d1.prepare(s.sql).bind(...(s.params || []));
  return {
    async all(sql, params = []) {
      return (await d1.prepare(sql).bind(...params).all()).results || [];
    },
    async first(sql, params = []) {
      return (await d1.prepare(sql).bind(...params).first()) || null;
    },
    async run(sql, params = []) {
      const r = await d1.prepare(sql).bind(...params).run();
      return { changes: r.meta?.changes ?? 0 };
    },
    async batch(stmts) {
      if (stmts.length) await d1.batch(stmts.map(bind));
    },
  };
}

export function sqliteDb(raw) {
  const norm = (p = []) => p.map((v) => (v === undefined ? null : v));
  return {
    async all(sql, params) {
      return raw.prepare(sql).all(...norm(params)).map((r) => ({ ...r }));
    },
    async first(sql, params) {
      const r = raw.prepare(sql).get(...norm(params));
      return r ? { ...r } : null;
    },
    async run(sql, params) {
      const r = raw.prepare(sql).run(...norm(params));
      return { changes: Number(r.changes) };
    },
    async batch(stmts) {
      raw.exec('BEGIN');
      try {
        for (const s of stmts) raw.prepare(s.sql).run(...norm(s.params));
        raw.exec('COMMIT');
      } catch (e) {
        try { raw.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw e;
      }
    },
  };
}
