import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

// Shared existing in-memory adapter for offline tests. Production tools use openDatabase().
export function database({ through, filename = ':memory:' } = {}) {
  const existing = filename !== ':memory:' && existsSync(filename);
  const sqlite = new DatabaseSync(filename);
  sqlite.exec('PRAGMA foreign_keys=ON');
  const directory = new URL('../migrations/', import.meta.url);
  if (!existing) for (const name of readdirSync(directory).filter(name => name.endsWith('.sql') && (!through || name <= through)).sort()) sqlite.exec(readFileSync(new URL(name, directory), 'utf8'));
  return {
    sqlite,
    async query(sql, params = []) {
      const before = sqlite.prepare('SELECT total_changes() AS n').get().n;
      const results = sqlite.prepare(sql).all(...params);
      return { results, meta: { changes: sqlite.prepare('SELECT changes() AS n').get().n, rows_written: sqlite.prepare('SELECT total_changes() AS n').get().n - before, rows_read: results.length } };
    },
  };
}
