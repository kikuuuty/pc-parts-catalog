// One isolated, local-only job. No remote config, production credentials or DB reuse.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { getPlatformProxy } from 'wrangler';
import { fetchUpstream, loadSnapshot } from '../src/upstream.js';
import { syncSnapshot, planSync } from '../src/sync.js';
import { readState } from '../src/database.js';
import { loadQualityCatalog } from '../src/quality/catalog.js';
import { readiness, searchGate, withReleaseLease, cacheEpoch } from './lib/release-gates.js';
import { sourceIntegrityGate } from './lib/source-integrity-gate.js';
import { captureProjection, compareProjection } from './lib/fts-verification.js';
import { verifyProduction } from './lib/production-smoke.js';
import { categoryCountDeltaError } from './lib/category-count-guard.js';
import { saveValidationReport } from './lib/validation-report.js';

const A = 'eec0df175504ebd15f0f3e3a8249a18a22f00940';
const B = '07e5be1dad48b1913a90a1b6f34e702cce3c475a';
const { values: args } = parseArgs({ options: { resume: { type: 'string' } } });
await mkdir('.cache', { recursive: true });
const root = path.resolve(args.resume ?? await mkdtemp('.cache/cross-snapshot-'));
assert(root.startsWith(path.resolve('.cache', 'cross-snapshot-')), 'Only isolated cross-snapshot directories can be resumed');
const manifestFile = path.join(root, 'manifest.json'), output = path.join(root, 'report.json');
const configPath = path.join(root, 'wrangler.json'), statePath = path.join(root, 'state');
const repo = path.join(root, 'upstream');
const report = { schema_version: 1, status: 'running', engine: 'local D1/workerd (not remote D1)', root, snapshots: { A, B },
  phases: { migration: 'not_run', snapshot_a: 'not_run', delta_sync: 'not_run', readiness: 'not_run', release_gates: 'not_run', reuse: 'not_run', http: 'not_run' }, deploy: 'not_run' };
const run = promisify(execFile), wrangler = path.resolve('node_modules/wrangler/bin/wrangler.js');
let manifest, proxy, worker, failure, current;
const fds = [];
const phase = async name => { current = name; report.phases[name] = 'running'; console.log(`Cross-snapshot phase: ${name}`); await saveValidationReport(output, report); };
const passed = () => { report.phases[current] = 'passed'; };
const counts = snapshot => Object.fromEntries(Object.entries(snapshot.report.categories).map(([c, r]) => [c, r.count]));
const open = async () => {
  proxy = await getPlatformProxy({ configPath, persist: { path: path.join(statePath, 'v3') } });
  return { query: (sql, params = []) => proxy.env.DB.prepare(sql).bind(...params).all() };
};
try {
  if (args.resume) {
    manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    assert.deepEqual(manifest.snapshots, { A, B }); assert.equal(manifest.root, root);
    Object.assign(report, JSON.parse(await readFile(output, 'utf8')), { status: 'running' });
    if (report.failure) (report.previous_failures ??= []).push({ ...report.failure, validation: structuredClone(report.validation ?? {}) });
    delete report.failure;
    // Completed A->B evidence is required; resume never resets or substitutes a DB.
    assert.equal(report.phases.delta_sync, 'passed', 'Only completed delta sync can resume downstream gates');
    for (const name of ['readiness', 'release_gates', 'reuse', 'http']) report.phases[name] = 'not_run';
    for (const key of ['readiness', 'gates', 'reuse', 'http', 'validation']) delete report[key];
  } else {
    manifest = { root, configPath, statePath, snapshots: { A, B }, database_id: randomUUID() };
    await writeFile(manifestFile, JSON.stringify(manifest, null, 2));
    await writeFile(configPath, JSON.stringify({ name: 'cross-snapshot-local', main: path.resolve('src/worker.js'), compatibility_date: '2026-09-01',
      d1_databases: [{ binding: 'DB', database_name: 'cross-snapshot-local', database_id: manifest.database_id, remote: false, migrations_dir: path.resolve('migrations') }],
      ratelimits: JSON.parse(await readFile('wrangler.json', 'utf8')).ratelimits,
      vars: { CATALOG_CACHE_EPOCH: 'cross-snapshot-initial', SEARCH_CACHE_TTL_SECONDS: '300' } }, null, 2));
    await phase('migration');
    await run(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'DB', '--local', '--config', configPath, '--persist-to', statePath], { env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' }, maxBuffer: 4 * 1024 * 1024 });
    passed();
    await phase('snapshot_a');
    await fetchUpstream({ repo, ref: A, reportDirectory: path.join(root, 'source-a') });
    const a = await loadSnapshot(repo, { reportDirectory: path.join(root, 'source-a') }); assert.equal(a.commit, A);
    const db = await open();
    report.sync_a = await syncSnapshot(db, a); assert.equal(report.sync_a.status, 'complete');
    const readyA = await readiness(db, { commit: A, expectedCounts: counts(a) });
    const before = await loadQualityCatalog(db);
    await sourceIntegrityGate(db, before, a, path.join(root, 'source-a-integrity.json'));
    passed();
    await phase('delta_sync');
    await fetchUpstream({ repo, ref: B, reportDirectory: path.join(root, 'source-b') });
    const b = await loadSnapshot(repo, { reportDirectory: path.join(root, 'source-b') }); assert.equal(b.commit, B);
    const total = b.records.length; assert(total >= 20000 && total <= 100000);
    for (const [category, n] of Object.entries(readyA.counts)) assert.equal(categoryCountDeltaError(category, n, counts(b)[category]), null);
    const state = await readState(db), plan = planSync(b, state), ingested = new Set();
    report.plan = { changed: plan.changed.length, deleted: plan.deleted.length, unchanged: plan.unchanged,
      added: plan.changed.filter(r => !state.has(r.product.upstream_key)).length };
    report.sync_b = await syncSnapshot({ ...db, async query(sql, params) {
      if (/^INSERT INTO ingest/.test(sql)) for (const r of JSON.parse(params[0])) ingested.add(r.product.upstream_key);
      return db.query(sql, params);
    } }, b, { maxProducts: 10000, writeBudget: 2000000, reuseComplete: true, baseSyncId: report.sync_a.run_id });
    assert.equal(report.sync_b.status, 'complete');
    assert.equal(report.sync_b.added, report.plan.added);
    assert.equal(report.sync_b.added + report.sync_b.updated + report.sync_b.reactivated, report.plan.changed);
    assert.equal(report.sync_b.deleted, report.plan.deleted); assert.equal(report.sync_b.unchanged, report.plan.unchanged);
    assert.deepEqual(ingested, new Set(plan.changed.map(r => r.product.upstream_key)));
    const after = await loadQualityCatalog(db), byKey = new Map(after.products.map(p => [p.upstream_key, p]));
    let unchangedVerified = 0;
    for (const p of before.products) if (byKey.get(p.upstream_key)?.active === 1 && !ingested.has(p.upstream_key)) {
      assert.deepEqual(byKey.get(p.upstream_key), p, 'Unchanged product projection was rewritten'); unchangedVerified++;
    }
    assert.equal(unchangedVerified, plan.unchanged); report.unchanged_verified = unchangedVerified;
    // Measure every old-comparator product-field difference, not just the suspected field.
    report.legacy_product_field_differences = {};
    for (const r of b.records) for (const [field, value] of Object.entries(r.product)) if (byKey.get(r.product.upstream_key)[field] !== value)
      report.legacy_product_field_differences[field] = (report.legacy_product_field_differences[field] ?? 0) + 1;
    report.row_source_commits = (await db.query('SELECT source_commit,count(*) n FROM products WHERE active=1 GROUP BY source_commit')).results;
    passed(); await saveValidationReport(output, report);
    await proxy.dispose(); proxy = null;
  }
  const snapshot = await loadSnapshot(repo, { reportDirectory: path.join(root, 'source-b') }); assert.equal(snapshot.commit, B);
  const db = await open();
  await phase('readiness');
  report.readiness = await readiness(db, { commit: B, expectedCounts: counts(snapshot) }); passed();
  await phase('release_gates');
  report.validation = { source_integrity: 'not_run', filter_metadata: 'not_run', search_quality: 'not_run', query_plans: 'not_run' };
  report.gates = await withReleaseLease(db, locked => searchGate(locked, { snapshot, output: path.join(root, 'release-ux-report.json'),
    onPhase: (name, state) => { (report.validation ??= {})[name] = state; console.log(`${name}: ${state}`); } }));
  passed();
  await phase('reuse');
  const before = await captureProjection(db), epoch = cacheEpoch(report.readiness.sync); let ingests = 0;
  report.reuse = await syncSnapshot({ ...db, async query(sql, params) { if (/^INSERT INTO ingest/.test(sql)) ingests++; return db.query(sql, params); } }, snapshot, { reuseComplete: true });
  assert.equal(report.reuse.reused, true); assert.equal(report.reuse.run_id, report.sync_b.run_id); assert.equal(ingests, 0);
  const after = await captureProjection(db), diff = compareProjection(before, after);
  assert.deepEqual(diff.data_changed_tables, []); assert.equal(diff.fts_difference_count, 0); assert.equal(cacheEpoch(after.sync), epoch);
  report.reuse.ingest_statements = ingests; passed();
  await proxy.dispose(); proxy = null;
  const config = JSON.parse(await readFile(configPath, 'utf8')); config.vars.CATALOG_CACHE_EPOCH = epoch;
  await writeFile(configPath, JSON.stringify(config, null, 2));
  await phase('http');
  const origin = 'http://127.0.0.1:8791';
  // Do not reuse somebody else's server/DB; fail if the reserved local port is occupied.
  const { createConnection } = await import('node:net');
  const occupied = await new Promise(resolve => { const socket = createConnection({ host: '127.0.0.1', port: 8791 }); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); });
  assert(!occupied, 'Port 8791 already in use');
  fds.push(openSync(path.join(root, 'worker.stdout.log'), 'w'), openSync(path.join(root, 'worker.stderr.log'), 'w'));
  worker = spawn(process.execPath, [wrangler, 'dev', '--local', '--config', configPath, '--persist-to', statePath, '--ip', '127.0.0.1', '--port', '8791', '--inspector-port', '0'], {
    stdio: ['ignore', ...fds], windowsHide: true, detached: process.platform !== 'win32', env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' } });
  const deadline = Date.now() + 60000;
  while (true) {
    try { if ((await fetch(`${origin}/v1/health`, { signal: AbortSignal.timeout(2000) })).ok) break; } catch { /* Wait for local readiness only. */ }
    assert(Date.now() < deadline && worker.exitCode === null, 'Isolated Worker readiness failed'); await delay(500);
  }
  const direct = await open();
  report.http = {};
  await verifyProduction(direct, origin, { snapshot, report: report.http });
  passed(); report.status = 'passed';
} catch (error) {
  failure = error; report.status = 'failed';
  if (current && report.phases[current] === 'running') report.phases[current] = 'failed';
  report.failure = { phase: current, reason: error.code === 'ERR_ASSERTION' ? error.message.split('\n')[0].slice(0, 180) : 'Verification failed; inspect phase reports (provider details withheld)' };
  console.error(JSON.stringify(report.failure)); process.exitCode = 1;
} finally {
  if (proxy) await proxy.dispose();
  if (worker?.pid && worker.exitCode === null) {
    if (process.platform === 'win32') await run('taskkill', ['/PID', String(worker.pid), '/T', '/F']).catch(() => {});
    else { try { process.kill(-worker.pid, 'SIGTERM'); } catch { /* Already stopped. */ } }
  }
  for (const fd of fds) closeSync(fd);
  await saveValidationReport(output, report, failure);
  await saveValidationReport('.cache/cross-snapshot-latest.json', { directory: root, status: report.status }, failure);
  console.log(JSON.stringify({ output, status: report.status, phases: report.phases }));
}
