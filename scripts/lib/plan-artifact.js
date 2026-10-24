import assert from 'node:assert/strict';
import { assertPlan } from '../../src/application-plan.js';

export const PLAN_ARTIFACT = 'catalog-application-plan';
export function assertReleasePin(pin, runId) {
  assert(pin && typeof pin === 'object', 'plan_pin_missing');
  assert(typeof runId === 'string' && runId.length > 0, 'plan_pin_run_missing');
  assert.match(pin.commit, /^[a-f0-9]{40}$/, 'plan_pin_invalid_commit');
  assert.equal(pin.run_id, runId, 'plan_pin_run_mismatch');
  assert(pin.base_sync_id === null || typeof pin.base_sync_id === 'string' && pin.base_sync_id.length > 0, 'plan_pin_invalid_base');
  return pin;
}
export function assertReleasePlan(plan, pin, runId) {
  assertReleasePin(pin, runId); assertPlan(plan);
  assert.equal(plan.commit, pin.commit, 'plan_commit_mismatch');
  assert.equal(plan.base_sync_id, pin.base_sync_id, 'plan_base_mismatch');
  if (Object.hasOwn(pin, 'base_plan_hash')) assert.equal(plan.base_plan_hash, pin.base_plan_hash, 'plan_base_hash_mismatch');
  // Old version-1 plans have no run field. Their run-scoped artifact is the
  // independent binding; never rewrite them or change their hash on restore.
  if (plan.workflow_run_id !== undefined) assert.equal(plan.workflow_run_id, runId, 'plan_run_mismatch');
  return plan;
}
export async function loadReleaseSnapshot(pin, runId, { fetchUpstream, loadSnapshot }) {
  assertReleasePin(pin, runId);
  await fetchUpstream({ ref: pin.commit });
  const snapshot = await loadSnapshot();
  assert.equal(snapshot.commit, pin.commit, 'plan_snapshot_commit_mismatch');
  return snapshot;
}
function assertReceipt(receipt, pin, runId) {
  assertReleasePin(pin, runId);
  assert.equal(receipt?.run_id, runId, 'plan_artifact_run_mismatch');
  assert.equal(receipt.commit, pin.commit, 'plan_artifact_commit_mismatch');
  assert.equal(receipt.base_sync_id, pin.base_sync_id, 'plan_artifact_base_mismatch');
}
async function find(adapter) {
  // list MUST finish successfully (including every page). No catch-to-empty.
  const matches = (await adapter.list()).filter(a => a.name === PLAN_ARTIFACT);
  assert(matches.length <= 1, 'plan_artifact_ambiguous');
  assert(!matches[0]?.expired, 'plan_artifact_expired');
  return matches[0];
}
export async function restorePlanArtifact(adapter, pin, runId) {
  assertReleasePin(pin, runId);
  const artifact = await find(adapter);
  const receipt = { run_id: runId, commit: pin.commit, base_sync_id: pin.base_sync_id };
  if (!artifact) return { receipt: { ...receipt, state: 'absent', reason: 'plan_artifact_confirmed_absent' } };
  const plan = assertReleasePlan(await adapter.download(artifact), pin, runId);
  return { plan, receipt: { ...receipt, state: 'restored', reason: 'plan_artifact_restored', artifact_id: artifact.id, plan_hash: plan.hash } };
}
export async function prepareReleasePlan({ pin, runId, receipt, load, create }) {
  assertReceipt(receipt, pin, runId);
  assert(['restored', 'absent'].includes(receipt.state), 'plan_artifact_state_unknown');
  const created = receipt.state === 'absent';
  const plan = assertReleasePlan(await (created ? create() : load()), pin, runId);
  if (!created) assert.equal(plan.hash, receipt.plan_hash, 'plan_artifact_hash_mismatch');
  return { plan, uploadRequired: created, reason: created ? 'plan_created_verified_unstarted_base' : 'plan_reused_immutable' };
}
export async function confirmPlanArtifact(adapter, pin, runId, plan, receipt) {
  assertReceipt(receipt, pin, runId); assertReleasePlan(plan, pin, runId);
  const restored = await restorePlanArtifact(adapter, pin, runId);
  assert(restored.plan, 'plan_artifact_save_unconfirmed');
  assert.equal(restored.plan.hash, plan.hash, 'plan_artifact_saved_hash_mismatch');
  return { ...restored.receipt, state: 'saved', reason: 'plan_artifact_save_confirmed' };
}
export function assertSavedPlan(plan, pin, runId, receipt) {
  assertReceipt(receipt, pin, runId); assertReleasePlan(plan, pin, runId);
  assert(['restored', 'saved'].includes(receipt.state) && receipt.artifact_id, 'plan_artifact_save_unconfirmed');
  assert.equal(receipt.plan_hash, plan.hash, 'plan_artifact_hash_mismatch');
}

// Adapter failures expose phase/reason only, never tokens, URLs or API bodies.
export function githubPlanAdapter({ request, download, repository, runId }) {
  assert(/^[\w.-]+\/[\w.-]+$/.test(repository), 'plan_artifact_invalid_repository');
  assert(/^\d+$/.test(runId), 'plan_artifact_invalid_run');
  return {
    async list() {
      const artifacts = [], seen = new Set();
      let total;
      for (let page = 1; ; page++) {
        let response, body;
        try {
          response = await request(`https://api.github.com/repos/${repository}/actions/runs/${runId}/artifacts?per_page=100&page=${page}`);
          assert(response.ok);
          body = await response.json();
          assert(Number.isSafeInteger(body.total_count) && body.total_count >= 0 && Array.isArray(body.artifacts));
          assert(body.artifacts.length <= 100);
          for (const a of body.artifacts) assert(Number.isSafeInteger(a.id) && typeof a.name === 'string' && typeof a.expired === 'boolean');
        } catch { throw new Error('plan_artifact_listing_failed'); }
        total ??= body.total_count;
        if (total !== body.total_count) throw new Error('plan_artifact_listing_inconsistent');
        for (const a of body.artifacts) {
          if (seen.has(a.id)) throw new Error('plan_artifact_listing_inconsistent');
          seen.add(a.id);
        }
        artifacts.push(...body.artifacts);
        if (artifacts.length === body.total_count) return artifacts;
        if (!body.artifacts.length || artifacts.length > body.total_count) throw new Error('plan_artifact_listing_inconsistent');
      }
    },
    async download(artifact) {
      try { return await download(artifact); }
      catch { throw new Error('plan_artifact_download_or_validation_failed'); }
    },
  };
}
