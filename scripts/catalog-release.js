import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fetchUpstream, loadSnapshot } from '../src/upstream.js';
import { openDatabase } from '../src/database.js';
import { syncSnapshot } from '../src/sync.js';
import { catalogState } from '../src/quality/catalog.js';
import { productionConfig, migrationGate, readiness, safeDatabase } from './lib/release-gates.js';
import { cloudflareRelease } from './lib/cloudflare-release.js';
import { publishCatalog } from './lib/catalog-publication.js';
import { phaseTiming, diagnosticHeartbeat } from './lib/phase-timing.js';
import { saveValidationReport } from './lib/validation-report.js';
import { readPlan, planForSync, latestSync, savePlan, PLAN_DIRECTORY } from '../src/application-plan.js';
import path from 'node:path';
import { assertReleasePin, prepareReleasePlan, assertSavedPlan, loadReleaseSnapshot } from './lib/plan-artifact.js';

const { positionals: [command], values: args } = parseArgs({ allowPositionals: true, options: {
  local: { type: 'boolean', default: false },
  representative: { type: 'boolean', default: false },
} });
assert(['pin', 'plan', 'sync', 'verify', 'deploy'].includes(command), 'Use pin, plan, sync, verify or deploy');
assert(!args.local || command === 'verify', '--local is only for read-only gate verification');
const report = { phase: command, result: 'running', golden: 'not run', deploy: 'not run', post_deploy: 'not run' };
report.validation = { input_contract: 'not_run', application_plan: 'not_run', sync_completion: 'not_run', source_integrity: 'not_run', filter_metadata: 'not_run', search_quality: 'not_run', query_plans: 'not_run' };
let originalFailure;
const output = `.cache/release-${command}-report.json`;
const pinFile = '.cache/release-pin.json';
const planFile = '.cache/release-plan.json';
const positive = (value, fallback) => {
  const n = Number(value ?? fallback);
  assert(Number.isSafeInteger(n) && n > 0, 'Budget must be a positive integer'); return n;
};
const timing = phaseTiming(report, () => saveValidationReport(output, report));
let currentStage;
const stage = value => {
  if (currentStage) timing.mark(currentStage, 'passed');
  currentStage = value; timing.mark(value, 'running');
  report.phase = value; console.log(`Release phase: ${value}`);
};
let stopDiagnostics;
async function baselineEvidence(db) {
  const base = await latestSync(db);
  if (!base || base.status !== 'complete') return {};
  if (!base.plan_hash) {
    stage('verify legacy baseline source');
    const repo = '.cache/release-baseline-upstream';
    await fetchUpstream({ repo, ref: base.source_commit, reportDirectory: '.cache/baseline-inspection' });
    return { baselineSource: await loadSnapshot(repo, { reportDirectory: '.cache/baseline-inspection' }) };
  }
  try { await planForSync(base); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const run = JSON.parse(base.report_json ?? '{}').artifact_run_id;
    assert(process.env.GITHUB_ACTIONS === 'true' && /^\d+$/.test(run ?? ''), 'Restore previous complete application plan before planning');
    const directory = path.join('.cache', 'baseline-artifact', base.plan_hash);
    await mkdir(directory, { recursive: true });
    await promisify(execFile)('gh', ['run', 'download', run, '--name', 'catalog-application-plan', '--dir', directory]);
    const restored = await planForSync(base, path.join(directory, 'release-plan.json'));
    await savePlan(restored, path.join(PLAN_DIRECTORY, `${restored.hash}.json`));
  }
  return {};
}
async function pin() {
  let value;
  if (Number(process.env.GITHUB_RUN_ATTEMPT ?? 1) > 1) {
    // download-artifact must restore the immutable first-attempt pin. Fail
    // closed if unavailable; never silently resolve a moving main on retry.
    value = JSON.parse(await readFile(pinFile, 'utf8'));
    assertReleasePin(value, process.env.GITHUB_RUN_ID);
  } else {
    const config = productionConfig(JSON.parse(await readFile('wrangler.json', 'utf8')));
    // Catch missing Worker management access before mutating the catalog.
    await (await cloudflareRelease(config)).current();
    const db = safeDatabase(await openDatabase(true));
    let base;
    try { await migrationGate(db); base = await catalogState(db); }
    finally { await db.close(); }
    const commit = await fetchUpstream({ ref: process.env.UPSTREAM_REF || 'main' });
    value = { commit, run_id: process.env.GITHUB_RUN_ID ?? 'manual', base_sync_id: base?.id ?? null,
      base_plan_hash: base?.plan_hash ?? null, base_source_commit: base?.source_commit ?? null };
    await writeFile(pinFile, JSON.stringify(value) + '\n');
  }
  assertReleasePin(value, process.env.GITHUB_RUN_ID ?? 'manual');
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `commit=${value.commit}\n`);
}

async function sync(db, prepareOnly = false) {
  const pinned = JSON.parse(await readFile(pinFile, 'utf8'));
  const runId = process.env.GITHUB_RUN_ID ?? 'manual';
  assertReleasePin(pinned, runId);
  // This receipt is issued only by successful run-scoped artifact enumeration /
  // restoration, not inferred from a missing local file or report.
  const receipt = JSON.parse(await readFile('.cache/release-plan-artifact.json', 'utf8'));
  stage('validate snapshot');
  report.validation.input_contract = 'running';
  const snapshot = await loadReleaseSnapshot(pinned, runId, { fetchUpstream, loadSnapshot });
  report.validation.input_contract = 'passed';
  report.diagnostics = snapshot.report.diagnostics;
  await migrationGate(db);
  const maxProducts = positive(process.env.MAX_PRODUCTS, 10000);
  const writeBudget = positive(process.env.WRITE_BUDGET, 2000000);
  let applicationPlan;
  if (prepareOnly) {
    report.plan_recovery = { artifact_state: receipt.state, reason: receipt.state === 'absent' ? 'plan_verifying_unstarted_base' : 'plan_verifying_saved_plan', upload_required: null };
    report.validation.application_plan = 'running';
    stage('freeze application plan');
    let prepared;
    const decision = await prepareReleasePlan({ pin: pinned, runId, receipt, load: () => readPlan(planFile), async create() {
      const evidence = await baselineEvidence(db);
      prepared = await syncSnapshot(db, snapshot, { prepareOnly: true, planFile, baseSyncId: pinned.base_sync_id, recoveryPin: pinned, workflowRunId: runId, ...evidence });
      return prepared.applicationPlan;
    } });
    if (!prepared) prepared = await syncSnapshot(db, snapshot, { prepareOnly: true, applicationPlan: decision.plan, planFile, baseSyncId: pinned.base_sync_id });
    const total = Object.values(prepared.expected_counts).reduce((a,b) => a+b, 0);
    assert(total >= 20000 && total <= 100000, 'Planned publication outside reviewed envelope');
    Object.assign(report, { plan_hash: prepared.plan_hash, snapshot_commit: pinned.commit, expected_counts: prepared.expected_counts, quality: prepared.quality, retained: prepared.retained, quarantined: prepared.quarantined });
    report.validation.application_plan = 'passed';
    report.plan_recovery = { artifact_state: receipt.state, reason: decision.reason, upload_required: decision.uploadRequired };
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `upload_required=${decision.uploadRequired}\nplan_ready=true\n`);
    return;
  }
  applicationPlan = await readPlan(planFile);
  assertSavedPlan(applicationPlan, pinned, runId, receipt);
  report.plan_recovery = { artifact_state: receipt.state, reason: receipt.reason, plan_hash: applicationPlan.hash };
  const counts = applicationPlan.counts;
  const total = Object.values(counts).reduce((a,b) => a+b, 0);
  assert(total >= 20000 && total <= 100000, 'Planned publication outside reviewed envelope');
  stage('production sync');
  report.validation.sync_completion = 'running';
  const result = await syncSnapshot(db, snapshot, { maxProducts, writeBudget, reuseComplete: true, baseSyncId: pinned.base_sync_id, applicationPlan });
  await writeFile('.cache/sync-report.json', JSON.stringify(result, null, 2) + '\n');
  report.sync_id = result.run_id; report.sync_status = result.status; report.reused = result.reused ?? false;
  Object.assign(report, { plan_hash: result.plan_hash, quality: result.quality, retained: result.retained, quarantined: result.quarantined });
  assert.equal(result.status, 'complete', 'Partial sync: resume same pin with reviewed budget');
  report.validation.sync_completion = 'passed';
  const ready = await readiness(db, { commit: pinned.commit, expectedCounts: counts });
  Object.assign(report, { active: ready.active, completed_at: ready.sync.finished_at, cache_epoch: ready.cache_epoch });
  await writeFile('.cache/release-snapshot.json', JSON.stringify({ sync_id: ready.sync.id, commit: pinned.commit, plan_hash: result.plan_hash, counts }) + '\n');
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
    `source_run_id=${runId}\nsource_attempt=${process.env.GITHUB_RUN_ATTEMPT}\nexpected_sync_id=${ready.sync.id}\nexpected_plan_hash=${result.plan_hash}\nexpected_upstream_commit=${pinned.commit}\n`);
}

async function release(db, config, deploy) {
  assert(!deploy || process.env.GITHUB_ACTIONS !== 'true', 'Use authenticated publication CLI in Actions');
  return publishCatalog({ db, config, deploy, local: args.local, representative: args.representative, report, timing,
    stage(value) { report.phase = value; console.log(`Release phase: ${value}`); } });
}

try {
  await mkdir('.cache', { recursive: true });
  stopDiagnostics = diagnosticHeartbeat(report, timing, output);
  if (command === 'pin') await pin();
  else {
    // Generator check is cheap; npm test is run once by the workflow or npm
    // worker:deploy wrapper, not duplicated inside each gate.
    await promisify(execFile)(process.execPath, ['scripts/generate-schema.js', '--check']);
    const config = productionConfig(JSON.parse(await readFile('wrangler.json', 'utf8')));
    const db = safeDatabase(await openDatabase(!args.local));
    try {
        if (command === 'sync' || command === 'plan') await sync(db, command === 'plan');
      else await release(db, config, command === 'deploy');
    } finally { await db.close(); }
  }
  report.result = 'success';
} catch (error) {
  originalFailure = error;
  report.result = 'failed';
  for (const [phase, state] of Object.entries(report.validation)) if (state === 'running') report.validation[phase] = 'failed';
  if (error.syncReport) {
    await saveValidationReport('.cache/sync-report.json', error.syncReport, error);
    Object.assign(report, { sync_status: error.syncReport.status, sync_id: error.syncReport.run_id, plan_hash: error.syncReport.plan_hash });
  }
  // Assertion labels are authored here (no SQL or provider response bodies).
  if (error.code === 'ERR_ASSERTION') report.reason = error.message.split('\n')[0].slice(0, 180);
  if (report.post_deploy === 'running') report.post_deploy = 'failed';
  console.error(`Release stopped at: ${report.phase}. See docs/catalog-release.md for recovery. Provider errors and SQL are intentionally not logged.`);
  process.exitCode = 1;
} finally {
  if (currentStage) timing.mark(currentStage, report.result === 'success' ? 'passed' : 'failed');
  if (stopDiagnostics) { try { await stopDiagnostics(); } catch (error) { if (!originalFailure) throw error; } }
  await saveValidationReport(output, report, originalFailure);
  console.log(JSON.stringify(report));
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Catalog ${command}\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`); }
    catch (error) { if (!originalFailure) throw error; }
  }
}
