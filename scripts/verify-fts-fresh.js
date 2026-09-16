import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getPlatformProxy } from 'wrangler';
import { loadSnapshot, defaultRepo } from '../src/upstream.js';
import { syncSnapshot } from '../src/sync.js';
import { verifyPlans } from '../src/queries.js';
import { loadQualityCatalog } from '../src/quality/catalog.js';
import { loadUXFixture,evaluateUX,sourceCatalog,qualityFailures } from '../src/quality/ux.js';
import { captureProjection } from './lib/fts-verification.js';
import { parseArgs } from 'node:util';

// Always create a new isolated LOCAL D1, never overwrite/recreate an existing DB.
const { values: args } = parseArgs({ options: {
  output: { type: 'string', default: '.cache/fts-fresh-location.json' },
  'verify-existing': { type: 'string' },
} });
const snapshot = await loadSnapshot(defaultRepo);
const directory = path.resolve(args['verify-existing'] ?? await mkdtemp('.cache/fts-fresh-'));
const configPath = path.join(directory, 'wrangler.json');
const config = { name: 'pc-parts-catalog-fts-fresh', compatibility_date: '2026-09-12',
  d1_databases: [{ binding: 'DB', database_name: 'fts-fresh', database_id: '00000000-0000-0000-0000-000000000006', migrations_dir: path.resolve('migrations') }] };
if (!args['verify-existing']) await writeFile(configPath, JSON.stringify(config, null, 2));
console.log(`Fresh local verification DB: ${directory}`);
if (!args['verify-existing']) execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'migrations', 'apply', 'DB', '--local', '--config', configPath,
  '--persist-to', path.join(directory, 'state')], { stdio: 'inherit', env: { ...process.env, CI: 'true' } });
const proxy = await getPlatformProxy({ configPath, persist: { path: path.join(directory, 'state/v3') } });
const db = { query: (sql, params = []) => proxy.env.DB.prepare(sql).bind(...params).all() };
try {
  const sync = await syncSnapshot(db, snapshot, args['verify-existing'] ? { reuseComplete: true } : {});
  const report = await captureProjection(db, { search: true });
  const input = await loadUXFixture(),catalog=await loadQualityCatalog(db);
  const benchmark = await evaluateUX(db,catalog,input.fixture,{fixtureHash:input.hash,source:sourceCatalog(snapshot,catalog)});
  benchmark.release_failures=qualityFailures(benchmark);
  const plans = await verifyPlans(db);
  for (const [name, data] of Object.entries({ snapshot: report, sync, benchmark, plans })) await writeFile(path.join(directory, `${name}.json`), JSON.stringify(data, null, 2) + '\n');
  await writeFile(args.output, JSON.stringify({ directory, configPath }, null, 2));
  console.log(JSON.stringify({ directory, sync, count: report.fts.count, sha256: report.fts.sha256, summary: benchmark.summary,
    plans_passed: plans.filter(p => p.index_check).length, queries: report.ranking.length }, null, 2));
  if (sync.status !== 'complete' || plans.some(p => !p.index_check)) throw new Error('Fresh verification failed');
  console.log(JSON.stringify({release_failures:benchmark.release_failures}));
} finally { await proxy.dispose(); }
