import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

// Shared existing in-memory adapter for offline tests. Production tools use openDatabase().
export function database({ through } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  const directory = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(directory).filter(name => name.endsWith('.sql') && (!through || name <= through)).sort()) sqlite.exec(readFileSync(new URL(name, directory), 'utf8'));
  return {
    sqlite,
    async query(sql, params = []) {
      const before = sqlite.prepare('SELECT total_changes() AS n').get().n;
      const results = sqlite.prepare(sql).all(...params);
      return { results, meta: { changes: sqlite.prepare('SELECT changes() AS n').get().n, rows_written: sqlite.prepare('SELECT total_changes() AS n').get().n - before, rows_read: results.length } };
    },
  };
}
