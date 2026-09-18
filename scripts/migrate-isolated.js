import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { splitSqlStatements } from './lib/sql-statements.js';
import { openDatabase } from '../src/database.js';
import { wrangler } from './lib/cloudflare-release.js';

const config = JSON.parse(await readFile('wrangler.json', 'utf8'));
const database = process.env.CLOUDFLARE_D1_DATABASE_ID;
assert(config.env?.staging,'Provision a fresh isolated staging binding first');
assert.equal(database, config.env.staging.d1_databases[0].database_id);
assert.notEqual(database, config.d1_databases[0].database_id, 'Only an isolated pre-promotion DB');
const db = await openDatabase(true);
try {
  const applied = (await db.query('SELECT name FROM d1_migrations ORDER BY name')).results.map(r => r.name);
  assert.equal(applied.length, 7);
  const results = [];
  for (const file of ['0008_category_fts.sql', '0009_display_order.sql']) {
    const sql = await readFile(`migrations/${file}`, 'utf8');
    if (file.startsWith('0008') && process.argv.includes('--reconcile-imported-0008')) {
      // One-off recovery after a successful bulk import without history. Compare
      // every created object before recording it; never infer success from counts.
      const schema = new Map((await db.query('SELECT name,sql FROM sqlite_schema')).results.map(r => [r.name, r.sql]));
      const normalized = s => s.replace(/;$/, '').replace(/\s+/g, ' ').trim();
      for (const statement of splitSqlStatements(sql)) {
        const text = statement.replace(/^--[^\n]*\n/, '');
        const create = text.match(/^CREATE (?:VIRTUAL )?(?:TABLE|TRIGGER) (\w+)/);
        if (create) assert.equal(normalized(schema.get(create[1]) ?? ''), normalized(text), create[1]);
        const drop = text.match(/^DROP (?:TABLE|TRIGGER) (\w+)/);
        if (drop && !sql.includes(`CREATE TRIGGER ${drop[1]} `)) assert(!schema.has(drop[1]));
      }
      await db.query('INSERT INTO d1_migrations(name) VALUES(?)', [file]);
      results.push({ file, result: 'full imported schema reconciled; history recorded' });
    } else {
      // D1 /query's multi-statement parser rejects this valid nested CASE trigger.
      // Bulk import uses SQLite statement boundaries and rolls back on failure.
      const path = `.cache/transition-${file}`;
      await writeFile(path, `${sql}\nINSERT INTO d1_migrations(name) VALUES('${file}');\n`);
      try {
        const output = await wrangler(['d1', 'execute', 'DB', '--env', 'staging', '--remote', '--file', path]);
        results.push({ file, output });
      } finally { await unlink(path); }
    }
    console.log(`${file}: passed`);
  }
  await writeFile('.cache/transition-migrations.json', JSON.stringify(results, null, 2) + '\n');
} finally { await db.close(); }
