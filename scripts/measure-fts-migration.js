import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/database.js';
import { readRemoteConfig, remoteDatabaseId } from '../src/remote-config.js';

// Explicit, one-time 0006 application with statement-level D1 metadata.
// Uses precisely Wrangler 4.131.1's migration wrapper: file contents followed by
// INSERT INTO d1_migrations(name), sent as one /query multi-statement request.
// `migrations apply` uses the same request but discards the cost fields in stdout.
const { values: args } = parseArgs({ options: { remote: { type: 'boolean' }, output: { type: 'string' } } });
if (!args.remote || !args.output) throw new Error('Use --remote --output <cost-report.json> after all local gates pass');
const name = '0006_fts_projection_consistency.sql';
const migration = await readFile(`migrations/${name}`, 'utf8');
const { config, database } = await readRemoteConfig();
assert.equal(database, remoteDatabaseId(config), 'CLI override differs from production binding');
const db = await openDatabase(true);
try {
  const state = async () => ({
    active: (await db.query('SELECT count(*) AS n FROM products WHERE active=1')).results[0].n,
    latest: (await db.query('SELECT * FROM sync_runs ORDER BY started_at DESC,id DESC LIMIT 1')).results[0],
    leases: (await db.query('SELECT count(*) AS n FROM sync_lock WHERE expires_at>unixepoch()')).results[0].n,
    foreign_key_errors: (await db.query('PRAGMA foreign_key_check')).results,
    size_bytes: (await db.query('SELECT 1')).meta.size_after,
  });
  const before = await state();
  assert.equal(before.active, 29599); assert.equal(before.latest.status, 'complete');
  assert.equal(before.leases, 0); assert.deepEqual(before.foreign_key_errors, []);
  const applied = (await db.query('SELECT name FROM d1_migrations ORDER BY id')).results.map(r => r.name);
  if (applied.includes(name)) throw new Error('0006 already applied; do not rerun a completed migration for measurement');
  assert.deepEqual(applied, ['0001_catalog.sql', '0002_specs_ingest.sql', '0003_query_plan_tuning.sql', '0004_search_relevance.sql', '0005_spec_search_indexes.sql']);
  const command = `${migration}\nINSERT INTO "d1_migrations" (name) values ('${name}');`;
  const start = performance.now();
  // No automatic write retry. On an ambiguous failure, inspect migration history
  // and DB state before any recovery; never delete/recreate the database.
  const result = JSON.parse(execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'DB',
    '--remote', '--env', '', `--command=${command}`, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, CI: 'true' } }));
  const elapsed = performance.now() - start;
  const after = await state();
  const report = { migration: name, migration_sha256: createHash('sha256').update(migration).digest('hex'), database_id: database,
    elapsed_ms: elapsed, rows_read: result.reduce((n, r) => n + r.meta.rows_read, 0), rows_written: result.reduce((n, r) => n + r.meta.rows_written, 0),
    sql_duration_ms: result.reduce((n, r) => n + r.meta.duration, 0), before, after, statements: result };
  await writeFile(args.output, JSON.stringify(report, null, 2) + '\n');
  assert(result.every(r => r.success));
  assert.equal(after.active, before.active); assert.deepEqual(after.latest, before.latest);
  assert.equal(after.leases, 0); assert.deepEqual(after.foreign_key_errors, []);
  assert.equal((await db.query('SELECT count(*) AS n FROM d1_migrations WHERE name=?', [name])).results[0].n, 1);
  console.log(JSON.stringify({ ...report, statements: result.map(r => r.meta), before: { active: before.active, size_bytes: before.size_bytes }, after: { active: after.active, size_bytes: after.size_bytes } }, null, 2));
} finally { await db.close(); }
