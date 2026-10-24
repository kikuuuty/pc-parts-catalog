import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { assertReleasePlan, githubPlanAdapter } from './plan-artifact.js';
import { latestSync, storedCatalog, verifyPlanState } from '../../src/application-plan.js';

const sha = /^[a-f0-9]{40}$/;
const hash = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const positive = value => /^[1-9]\d*$/.test(value ?? '') && Number.isSafeInteger(Number(value));

export function publicationInputs(env) {
  const value = { source_run_id: env.SOURCE_RUN_ID, source_attempt: env.SOURCE_ATTEMPT,
    expected_sync_id: env.EXPECTED_SYNC_ID, expected_plan_hash: env.EXPECTED_PLAN_HASH,
    expected_upstream_commit: env.EXPECTED_UPSTREAM_COMMIT };
  assert(positive(value.source_run_id) && positive(value.source_attempt), 'publication_source_identity_required');
  assert(uuid.test(value.expected_sync_id ?? ''), 'publication_sync_id_required');
  assert(hash.test(value.expected_plan_hash ?? ''), 'publication_plan_hash_required');
  assert(sha.test(value.expected_upstream_commit ?? ''), 'publication_commit_required');
  return value;
}

// Used by workflow validation AND tested selection logic. No CF credentials.
export function releaseRequest(env) {
  assert.equal(env.GITHUB_REF, `refs/heads/${env.DEFAULT_BRANCH}`, 'publication_default_branch_required');
  assert(['schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME), 'publication_event_invalid');
  const mode = env.GITHUB_EVENT_NAME === 'schedule' ? 'sync_release' : (env.RELEASE_MODE || 'sync_release');
  assert(['sync_release', 'publish_existing'].includes(mode), 'publication_mode_invalid');
  return { mode, ...(mode === 'publish_existing' ? publicationInputs(env) : {}) };
}

export function selectPublicationSource(request, syncResult, syncOutputs) {
  if (request.mode === 'publish_existing') return request;
  assert.equal(syncResult, 'success', 'publication_sync_job_not_successful');
  // Explicit successful sync outputs, NEVER the publishing job's run_attempt.
  return { mode: 'sync_release', ...publicationInputs(syncOutputs) };
}

function oneArtifact(list, name) {
  const matches = list.filter(a => a.name === name);
  assert.equal(matches.length, 1, 'publication_artifact_missing_or_ambiguous');
  assert.equal(matches[0].expired, false, 'publication_artifact_expired');
  return matches[0];
}

export function validatePublicationFiles(files, expected, source) {
  const { pin, plan, snapshot, sync, release, receipt } = files;
  // Keep same-run ingestion guards untouched; authenticate the ORIGINAL run.
  assertReleasePlan(plan, pin, expected.source_run_id);
  assert.equal(plan.hash, expected.expected_plan_hash, 'publication_plan_hash_mismatch');
  assert.equal(plan.commit, expected.expected_upstream_commit, 'publication_commit_mismatch');
  assert.deepEqual(files.completionPin, pin, 'publication_pin_copy_mismatch');
  assertReleasePlan(files.completionPlan, pin, expected.source_run_id);
  assert.equal(files.completionPlan.hash, plan.hash, 'publication_plan_copy_mismatch');
  assert.equal(snapshot.sync_id, expected.expected_sync_id, 'publication_snapshot_sync_mismatch');
  assert.equal(snapshot.commit, plan.commit, 'publication_snapshot_commit_mismatch');
  assert.equal(snapshot.plan_hash, plan.hash, 'publication_snapshot_hash_mismatch');
  assert.deepEqual(snapshot.counts, plan.counts, 'publication_snapshot_counts_mismatch');
  assert.equal(sync.status, 'complete', 'publication_sync_not_complete');
  assert.equal(sync.remaining, 0, 'publication_sync_has_remaining');
  assert.equal(sync.run_id, snapshot.sync_id, 'publication_sync_id_mismatch');
  assert.equal(sync.commit, plan.commit, 'publication_sync_commit_mismatch');
  assert.equal(sync.plan_hash, plan.hash, 'publication_sync_hash_mismatch');
  assert.equal(sync.base_sync_id, pin.base_sync_id, 'publication_sync_base_mismatch');
  assert.equal(sync.artifact_run_id, expected.source_run_id, 'publication_sync_run_mismatch');
  assert.deepEqual(sync.expected_counts, plan.counts, 'publication_sync_counts_mismatch');
  assert.equal(release.result, 'success', 'publication_completion_step_failed');
  assert.equal(release.validation.sync_completion, 'passed', 'publication_completion_not_verified');
  assert.equal(release.sync_status, 'complete', 'publication_completion_not_complete');
  assert.equal(release.sync_id, snapshot.sync_id, 'publication_completion_sync_mismatch');
  assert.equal(release.plan_hash, plan.hash, 'publication_completion_hash_mismatch');
  assert(['saved', 'restored'].includes(receipt.state), 'publication_plan_not_saved');
  assert.equal(receipt.artifact_id, source.artifacts.plan.id, 'publication_saved_artifact_mismatch');
  assert.equal(receipt.run_id, expected.source_run_id, 'publication_receipt_run_mismatch');
  assert.equal(receipt.commit, plan.commit, 'publication_receipt_commit_mismatch');
  assert.equal(receipt.base_sync_id, pin.base_sync_id, 'publication_receipt_base_mismatch');
  assert.equal(receipt.plan_hash, plan.hash, 'publication_receipt_hash_mismatch');
  return { expected, source, pin, plan, snapshot };
}

export async function restorePublication(adapter, expected, context) {
  const { repository, runId, codeSha } = context;
  assert(positive(runId) && sha.test(codeSha ?? ''), 'publication_execution_identity_required');
  const [run, workflow, repo, jobs] = await Promise.all([
    adapter.run(expected.source_attempt), adapter.workflow(), adapter.repository(), adapter.jobs(expected.source_attempt),
  ]);
  assert.equal(repo.full_name, repository, 'publication_repository_mismatch');
  assert.equal(run.repository.full_name, repository, 'publication_source_repository_mismatch');
  assert.equal(run.head_repository.full_name, repository, 'publication_source_fork_rejected');
  assert.equal(run.id, Number(expected.source_run_id), 'publication_source_run_mismatch');
  assert.equal(run.run_attempt, Number(expected.source_attempt), 'publication_source_attempt_mismatch');
  assert.equal(workflow.path, '.github/workflows/sync.yml', 'publication_workflow_path_mismatch');
  assert.equal(run.workflow_id, workflow.id, 'publication_source_workflow_mismatch');
  assert.equal(run.head_branch, repo.default_branch, 'publication_source_branch_mismatch');
  assert(sha.test(run.head_sha), 'publication_source_code_invalid');
  assert(['workflow_dispatch', 'schedule'].includes(run.event), 'publication_source_event_invalid');
  // A foreign source must be terminal. Same-run normal publication follows a
  // successful sync job while the overall run (including this job) is active.
  if (runId !== expected.source_run_id) assert.equal(run.status, 'completed', 'publication_source_still_active');
  const syncSteps = jobs.flatMap(j => j.steps ?? []).filter(s => s.name === 'Production sync and completion verification');
  assert.equal(syncSteps.length, 1, 'publication_source_sync_step_ambiguous');
  assert.equal(syncSteps[0].conclusion, 'success', 'publication_source_sync_step_not_successful');
  const listed = await adapter.list();
  const artifacts = { pin: oneArtifact(listed, 'catalog-snapshot-pin'), plan: oneArtifact(listed, 'catalog-application-plan'),
    completion: oneArtifact(listed, `catalog-release-attempt-${expected.source_attempt}`) };
  const [pin, plan, completion] = await Promise.all(Object.entries(artifacts).map(([kind, a]) => adapter.download(a, kind)));
  // Fail closed if replacement/ambiguity appeared during name-based download.
  const after = await adapter.list();
  for (const a of Object.values(artifacts)) assert.equal(oneArtifact(after, a.name).id, a.id, 'publication_artifact_changed');
  const source = { run_id: expected.source_run_id, attempt: expected.source_attempt, code_sha: run.head_sha,
    conclusion: run.conclusion, publication_run_id: runId, publication_code_sha: codeSha, artifacts };
  return validatePublicationFiles({ pin, plan, ...completion }, expected, source);
}

// This comparison happens only UNDER the release lease. No ingestion writes.
export async function assertPublicationState(db, target, { contents = true } = {}) {
  const sync = await latestSync(db);
  assert.equal(sync?.id, target.expected.expected_sync_id, 'publication_db_sync_changed');
  assert.equal(sync.status, 'complete', 'publication_db_not_complete');
  assert.equal(sync.source_commit, target.expected.expected_upstream_commit, 'publication_db_commit_changed');
  assert.equal(sync.plan_hash, target.expected.expected_plan_hash, 'publication_db_plan_changed');
  assert.equal(sync.base_sync_id, target.plan.base_sync_id, 'publication_db_base_changed');
  assert.equal(JSON.parse(sync.report_json ?? '{}').artifact_run_id, target.expected.source_run_id, 'publication_db_source_run_changed');
  if (contents) verifyPlanState(target.plan, await storedCatalog(db), { complete: true });
  return sync;
}

export function githubPublicationAdapter({ repository, runId, directory, request, download } = {}) {
  assert(/^[\w.-]+\/[\w.-]+$/.test(repository ?? ''), 'publication_repository_invalid');
  assert(positive(runId), 'publication_source_run_invalid');
  const exec = promisify(execFile);
  const json = request ?? (async url => {
    try { return JSON.parse((await exec('gh', ['api', url], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000 })).stdout); }
    catch { throw new Error('publication_github_read_failed'); }
  });
  const base = `repos/${repository}`;
  const list = githubPlanAdapter({ repository, runId, request: async url => Response.json(await json(url)), download: async () => {} }).list;
  return {
    run: attempt => json(`${base}/actions/runs/${runId}/attempts/${attempt}`),
    workflow: () => json(`${base}/actions/workflows/sync.yml`),
    repository: () => json(base), list,
    async jobs(attempt) {
      const all = []; let total;
      for (let page = 1; ; page++) {
        const body = await json(`${base}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`);
        assert(Array.isArray(body.jobs) && Number.isSafeInteger(body.total_count), 'publication_jobs_invalid');
        total ??= body.total_count; assert.equal(body.total_count, total, 'publication_jobs_changed');
        all.push(...body.jobs); assert(all.length <= total, 'publication_jobs_invalid');
        if (all.length === total) return all;
        assert(body.jobs.length > 0, 'publication_jobs_incomplete');
      }
    },
    async download(artifact, kind) {
      if (download) return download(artifact, kind);
      assert(directory, 'publication_restore_directory_required');
      const dest = path.join(directory, kind); await mkdir(dest, { recursive: true });
      try {
        await exec('gh', ['run', 'download', runId, '--repo', repository, '--name', artifact.name, '--dir', dest], { timeout: 180000, maxBuffer: 1024 * 1024 });
        const read = async name => JSON.parse(await readFile(path.join(dest, name), 'utf8'));
        if (kind === 'pin') return read('release-pin.json');
        if (kind === 'plan') return read('release-plan.json');
        return { snapshot: await read('release-snapshot.json'), sync: await read('sync-report.json'), release: await read('release-sync-report.json'),
          receipt: await read('release-plan-artifact.json'), completionPin: await read('release-pin.json'), completionPlan: await read('release-plan.json') };
      } catch { throw new Error('publication_artifact_download_or_parse_failed'); }
    },
  };
}

export async function publicationDirectory() {
  await mkdir('.cache', { recursive: true });
  return mkdtemp('.cache/publication-source-');
}
