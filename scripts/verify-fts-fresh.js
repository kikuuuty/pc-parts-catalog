import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getPlatformProxy } from 'wrangler';
import { loadSnapshot, defaultRepo } from '../src/upstream.js';
import { syncSnapshot } from '../src/sync.js';
import { verifyPlans } from '../src/queries.js';
import { loadQualityCatalog } from '../src/quality/catalog.js';
import { loadSearchFixture } from '../src/quality/fixtures.js';
import { benchmarkSearch } from '../src/quality/benchmark.js';
import { createHash } from 'node:crypto';
import { captureProjection } from './lib/fts-verification.js';

// Always create a new isolated LOCAL D1, never overwrite/recreate an existing DB.
const snapshot = await loadSnapshot(defaultRepo);
const directory = path.resolve(await mkdtemp('.cache/fts-fresh-'));
const configPath = path.join(directory, 'wrangler.json');
const config = { name: 'pc-parts-catalog-fts-fresh', compatibility_date: '2026-09-12',
  d1_databases: [{ binding: 'DB', database_name: 'fts-fresh', database_id: '00000000-0000-0000-0000-000000000006', migrations_dir: path.resolve('migrations') }] };
await writeFile(configPath, JSON.stringify(config, null, 2));
console.log(`Fresh local verification DB: ${directory}`);
execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'migrations', 'apply', 'DB', '--local', '--config', configPath,
  '--persist-to', path.join(directory, 'state')], { stdio: 'inherit', env: { ...process.env, CI: 'true' } });
const proxy = await getPlatformProxy({ configPath, persist: { path: path.join(directory, 'state/v3') } });
const db = { query: (sql, params = []) => proxy.env.DB.prepare(sql).bind(...params).all() };
try {
  const sync = await syncSnapshot(db, snapshot);
  const report = await captureProjection(db, { search: true });
  const input = await loadSearchFixture();
  const implementation = await Promise.all(['queries.js', 'search-intent.js'].map(file => readFile(new URL(`../src/${file}`, import.meta.url), 'utf8')));
  const benchmark = await benchmarkSearch(db, await loadQualityCatalog(db), input.fixture, { fixtureHash: input.hash,
    searchImplementationHash: createHash('sha256').update(JSON.stringify(implementation)).digest('hex') });
  const plans = await verifyPlans(db);
  for (const [name, data] of Object.entries({ snapshot: report, sync, benchmark, plans })) await writeFile(path.join(directory, `${name}.json`), JSON.stringify(data, null, 2) + '\n');
  await writeFile('.cache/fts-fresh-location.json', JSON.stringify({ directory, configPath }, null, 2));
  console.log(JSON.stringify({ directory, sync, count: report.fts.count, sha256: report.fts.sha256, summary: benchmark.summary,
    plans_passed: plans.filter(p => p.index_check).length, queries: report.ranking.length }, null, 2));
  const baseline = { query_count: 120, hit_at_1: 118 / 120, hit_at_5: 1, hit_at_10: 1, mrr: 118.75 / 120,
    precision_at_5: 216 / 220, precision_at_10: 434 / 440, zero_result_count: 0 };
  const qualityFailed = Object.entries(baseline).some(([key, value]) =>
    typeof benchmark.summary[key] !== 'number' || Math.abs(benchmark.summary[key] - value) > 1e-12);
  if (sync.status !== 'complete' || plans.some(p => !p.index_check) || qualityFailed) throw new Error('Fresh verification failed');
} finally { await proxy.dispose(); }
