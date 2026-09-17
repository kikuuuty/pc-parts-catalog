import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile, appendFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fetchUpstream, loadSnapshot } from '../src/upstream.js';
import { openDatabase } from '../src/database.js';
import { syncSnapshot } from '../src/sync.js';
import { catalogState } from '../src/quality/catalog.js';
import { productionConfig, migrationGate, readiness, searchGate, safeDatabase, withReleaseLease, releaseIdentity } from './lib/release-gates.js';
import { cloudflareRelease, assertDeployedVars, wrangler } from './lib/cloudflare-release.js';
import { verifyProduction } from './lib/production-smoke.js';

const { positionals: [command], values: args } = parseArgs({ allowPositionals: true, options: {
  local: { type: 'boolean', default: false },
} });
assert(['pin', 'sync', 'verify', 'deploy'].includes(command), 'Use pin, sync, verify or deploy');
assert(!args.local || command === 'verify', '--local is only for read-only gate verification');
const report = { phase: command, result: 'running', golden: 'not run', deploy: 'not run', post_deploy: 'not run' };
const output = `.cache/release-${command}-report.json`;
const pinFile = '.cache/release-pin.json';
const positive = (value, fallback) => {
  const n = Number(value ?? fallback);
  assert(Number.isSafeInteger(n) && n > 0, 'Budget must be a positive integer'); return n;
};
const stage = value => { report.phase = value; console.log(`Release phase: ${value}`); };
async function pin() {
  let value;
  if (Number(process.env.GITHUB_RUN_ATTEMPT ?? 1) > 1) {
    // download-artifact must restore the immutable first-attempt pin. Fail
    // closed if unavailable; never silently resolve a moving main on retry.
    value = JSON.parse(await readFile(pinFile, 'utf8'));
    assert.equal(value.run_id, process.env.GITHUB_RUN_ID);
  } else {
    const config = productionConfig(JSON.parse(await readFile('wrangler.json', 'utf8')));
    // Catch missing Worker management access before mutating the catalog.
    await (await cloudflareRelease(config)).current();
    const db = safeDatabase(await openDatabase(true));
    let base;
    try { await migrationGate(db); base = await catalogState(db); }
    finally { await db.close(); }
    const commit = await fetchUpstream({ ref: process.env.UPSTREAM_REF || 'main' });
    value = { commit, run_id: process.env.GITHUB_RUN_ID ?? 'manual', base_sync_id: base?.id ?? null };
    await writeFile(pinFile, JSON.stringify(value) + '\n');
  }
  assert.match(value.commit, /^[a-f0-9]{40}$/);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `commit=${value.commit}\n`);
}

async function sync(db) {
  const pinned = JSON.parse(await readFile(pinFile, 'utf8'));
  assert.match(pinned.commit, /^[a-f0-9]{40}$/);
  stage('validate snapshot');
  await fetchUpstream({ ref: pinned.commit });
  const snapshot = await loadSnapshot();
  assert.equal(snapshot.commit, pinned.commit);
  await migrationGate(db);
  const current = await catalogState(db);
  assert(current?.id === pinned.base_sync_id || current?.source_commit === pinned.commit, 'Pin superseded by a different catalog snapshot; start a new workflow');
  const maxProducts = positive(process.env.MAX_PRODUCTS, 10000);
  const writeBudget = positive(process.env.WRITE_BUDGET, 2000000);
  const counts = Object.fromEntries(Object.entries(snapshot.report.categories).map(([key, value]) => [key, value.count]));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  assert(total >= 20000 && total <= 100000, 'Snapshot count outside reviewed envelope');
  const previous = (await db.query('SELECT category,count(*) AS n FROM products WHERE active=1 GROUP BY category')).results;
  for (const row of previous) assert(counts[row.category] >= row.n * 0.8 && counts[row.category] <= row.n * 1.5, 'Unexpected category count delta; review upstream');
  stage('production sync');
  const result = await syncSnapshot(db, snapshot, { maxProducts, writeBudget, reuseComplete: true, baseSyncId: pinned.base_sync_id });
  await writeFile('.cache/sync-report.json', JSON.stringify(result, null, 2) + '\n');
  report.sync_id = result.run_id; report.sync_status = result.status; report.reused = result.reused ?? false;
  assert.equal(result.status, 'complete', 'Partial sync: resume same pin with reviewed budget');
  const ready = await readiness(db, { commit: pinned.commit, expectedCounts: counts });
  Object.assign(report, { active: ready.active, completed_at: ready.sync.finished_at, cache_epoch: ready.cache_epoch });
  await writeFile('.cache/release-snapshot.json', JSON.stringify({ sync_id: ready.sync.id, commit: pinned.commit, counts }) + '\n');
}

async function release(db, config, deploy) {
  const operation = async (locked, renew = async () => {}) => {
    stage('readiness / integrity');
    let expected;
    // Workflow deploy must match the sync step, even if another operator has
    // synchronized between jobs. Manual deploy operates on the latest complete.
    if (deploy && process.env.GITHUB_ACTIONS === 'true') expected = JSON.parse(await readFile('.cache/release-snapshot.json', 'utf8'));
    const ready = await readiness(locked, { commit: expected?.commit, expectedCounts: expected?.counts });
    if (expected) assert.equal(ready.sync.id, expected.sync_id, 'Completed sync changed before release');
    Object.assign(report, { sync_id: ready.sync.id, active: ready.active, completed_at: ready.sync.finished_at, cache_epoch: ready.cache_epoch,fts_integrity:ready.fts.pass });
    stage('search quality / plans');
    Object.assign(report, await searchGate(locked));
    await renew();
    const confirm = await readiness(locked, { commit: ready.sync.source_commit, expectedCounts: ready.counts });
    assert.equal(confirm.sync.id, ready.sync.id);
    if(args.local) { report.deploy='not run (local read-only verification)';return; }
    stage('compile deploy configuration');
    const vars = { ...config.vars, CATALOG_CACHE_EPOCH: ready.cache_epoch };
    // Root-level temporary config preserves ALL relative path semantics. Every
    // production var/binding stays present; local env can never be selected.
    const generated = { ...config, vars };
    delete generated.env;
    const file = `.catalog-release-${randomUUID()}.json`;
    await writeFile(file, JSON.stringify(generated, null, 2));
    try {
      await wrangler(['deploy', '--config', file, '--env', '', '--dry-run']);
      if (!deploy) { report.deploy = 'dry-run passed'; return; }
      const api = await cloudflareRelease(config);
      const tag = await releaseIdentity(config, ready.cache_epoch);
      const before = await api.current();
      report.previous_worker_version = before.id;
      // Dashboard-only vars would otherwise be deleted by Wrangler. Require
      // them to be declared before proceeding, rather than silently losing them.
      assert(before.bindings.filter(b => ['plain_text', 'json'].includes(b.type)).every(b => Object.hasOwn(vars, b.name)), 'Undeclared production vars; reconcile configuration');
      await renew();
      stage('Worker deploy');
      if (before.tag === tag) {
        assertDeployedVars(before, vars);
        report.deploy = 'already deployed';
        report.worker_version = before.id;
      } else {
        report.deploy = 'submitted (outcome may be unknown on transport failure)';
        // No blind write retry. On rerun the live tag reconciles a lost response.
        const text = await wrangler(['deploy', '--config', file, '--env', '', '--tag', tag, '--message', 'Verified catalog snapshot release']);
        const version = text.match(/Current Version ID:\s*([a-f0-9-]{36})/i)?.[1];
        const current = await api.current();
        assert.equal(current.tag, tag, 'Active release tag differs');
        if (version) assert.equal(current.id, version, 'Concurrent Worker deployment');
        assertDeployedVars(current, vars);
        report.worker_version = current.id;
        report.deploy = 'success';
      }
      stage('production smoke / contract / Golden');
      report.post_deploy = 'running';
      report.verification = await verifyProduction(locked, 'https://pc-parts-catalog.kikuuuty.workers.dev');
      await renew();
      const after = await api.current();
      assert.equal(after.id, report.worker_version, 'Worker changed during verification');
      assertDeployedVars(after, vars);
      report.post_deploy = 'pass';
    } finally { await unlink(file); }
  };
  if (deploy) await withReleaseLease(db, operation);
  else await operation(db);
}

try {
  await mkdir('.cache', { recursive: true });
  if (command === 'pin') await pin();
  else {
    // Generator check is cheap; npm test is run once by the workflow or npm
    // worker:deploy wrapper, not duplicated inside each gate.
    await promisify(execFile)(process.execPath, ['scripts/generate-schema.js', '--check']);
    const config = productionConfig(JSON.parse(await readFile('wrangler.json', 'utf8')));
    const db = safeDatabase(await openDatabase(!args.local));
    try {
      if (command === 'sync') await sync(db);
      else await release(db, config, command === 'deploy');
    } finally { await db.close(); }
  }
  report.result = 'success';
} catch (error) {
  report.result = 'failed';
  // Assertion labels are authored here (no SQL or provider response bodies).
  if (error.code === 'ERR_ASSERTION') report.reason = error.message.split('\n')[0].slice(0, 180);
  if (report.phase === 'search quality / plans') report.golden = 'failed';
  if (report.post_deploy === 'running') report.post_deploy = 'failed';
  console.error(`Release stopped at: ${report.phase}. See docs/catalog-release.md for recovery. Provider errors and SQL are intentionally not logged.`);
  process.exitCode = 1;
} finally {
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Catalog ${command}\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`);
}
