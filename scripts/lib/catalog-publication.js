import assert from 'node:assert/strict';
import { writeFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { readiness, searchGate, withReleaseLease, releaseIdentity, productionConfig } from './release-gates.js';
import { cloudflareRelease, assertDeployedVars, wrangler } from './cloudflare-release.js';
import { verifyProduction } from './production-smoke.js';
import { planForSync, publishedSnapshot } from '../../src/application-plan.js';
import { assertPublicationState } from './publication-source.js';

// Publication can only read catalog data. The ONLY permitted writes are the
// existing release lease protocol, including normal recovery of an expired lease.
export function publicationDatabase(db, report) {
  report.d1 = { queries: 0, rows_read: 0, rows_written: 0, missing_cost_metadata: 0,
    scope: 'All SQL in this publication process, including target checks, gates, direct HTTP comparisons and lease lifecycle; excludes Worker-side HTTP SQL and other traffic' };
  return { ...db, async query(sql, params = []) {
    const clean = sql.trim().replace(/;$/, '').replace(/'(?:''|[^'])*'/g, "''");
    const read = /^(SELECT|WITH|EXPLAIN)\b/i.test(clean) && !/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|ATTACH|DETACH|VACUUM|REINDEX|ANALYZE)\b|\bREPLACE\s+INTO\b/i.test(clean);
    const pragma = /^PRAGMA (table_info\([^;]+\)|foreign_key_check|quick_check)$/i.test(clean);
    const lease = /^(INSERT INTO sync_lock\(|UPDATE sync_lock SET |DELETE FROM sync_lock WHERE )/i.test(clean);
    assert(!clean.includes(';') && (read || pragma || lease), 'Publication SQL write prohibited (except lease)');
    const result = await db.query(sql, params);
    report.d1.queries++;
    if (!Number.isFinite(result.meta?.rows_read) || !Number.isFinite(result.meta?.rows_written)) report.d1.missing_cost_metadata++;
    report.d1.rows_read += result.meta?.rows_read ?? 0;
    report.d1.rows_written += result.meta?.rows_written ?? 0;
    return result;
  } };
}

export function assertWorkerBindings(current, config, previous) {
  const binding = current.bindings.filter(b => b.name === 'DB' && b.type === 'd1');
  assert.equal(binding.length, 1, 'Worker DB binding missing/ambiguous');
  const database = config.d1_databases.find(b => b.binding === 'DB').database_id;
  assert.equal(binding[0].id ?? binding[0].database_id, database, 'Worker DB binding differs');
  if (binding[0].database_id) assert.equal(binding[0].database_id, database, 'Worker DB binding differs');
  for (const expected of config.ratelimits ?? []) {
    const actual = current.bindings.find(b => b.name === expected.name && b.type === 'ratelimit');
    assert(actual, 'Worker rate limit binding missing');
    assert.equal(actual.namespace_id, expected.namespace_id, 'Worker rate limit namespace differs');
    assert.deepEqual(actual.simple, expected.simple, 'Worker rate limit differs');
  }
  if (previous) for (const secret of previous.bindings.filter(b => b.type === 'secret_text')) {
    assert(current.bindings.some(b => b.type === 'secret_text' && b.name === secret.name), 'Worker secret binding lost');
  }
}

// Shared by ordinary publication and publish_existing. Test adapters replace
// external gates/management/HTTP, not this ordering or the lease/state checks.
export async function publishCatalog({ db, config, target, report, timing, deploy = true, local = false, representative = false, stage = () => {}, adapters = {} }) {
  assert(!target || !representative, 'Pinned publication requires full gates');
  if (!local) productionConfig(config);
  const io = { readiness, searchGate, withReleaseLease, cloudflareRelease, wrangler, verifyProduction, releaseIdentity, ...adapters };
  const step = (name, fn) => timing.run(name, async () => { stage(name); return fn(); });
  const operation = async (locked, renew = async () => {}) => {
    let api, before;
    if (!local) {
      api = await io.cloudflareRelease(config);
      before = await step('worker_binding_preflight', async () => {
        const current = await api.current(); assertWorkerBindings(current, config); return current;
      });
    }
    if (target) await step('fixed_plan_db_state', () => assertPublicationState(locked, target));
    const expected = target?.snapshot;
    const ready = await step('readiness', () => io.readiness(locked, { commit: expected?.commit, expectedCounts: expected?.counts }));
    if (expected) assert.equal(ready.sync.id, expected.sync_id, 'Completed sync changed before release');
    const snapshot = publishedSnapshot(target?.plan ?? await planForSync(ready.sync));
    if (expected) assert.equal(snapshot.applicationPlan.hash, expected.plan_hash, 'Release plan changed');
    Object.assign(report, { sync_id: ready.sync.id, snapshot_commit: ready.sync.source_commit, plan_hash: snapshot.applicationPlan.hash,
      active: ready.active, completed_at: ready.sync.finished_at, cache_epoch: ready.cache_epoch, fts_integrity: ready.fts.pass });
    const checks = await step('release_gates', () => io.searchGate(locked, { snapshot, representative, onPhase(name, state) {
      report.validation[name] = state; timing.mark(name, state);
      // Flush partial phase diagnostics before waiting on long remote reads.
      void timing.persist().catch(() => {});
      if (state === 'running') stage(name);
      if (name === 'search_quality' && ['passed', 'failed'].includes(state)) report.golden = state;
    } }));
    Object.assign(report, { ...checks, validation: { ...report.validation, ...checks.validation } });
    await renew();
    const confirm = await step('pre_deploy_state', async () => {
      if (target) await assertPublicationState(locked, target, { contents: false });
      return io.readiness(locked, { commit: ready.sync.source_commit, expectedCounts: ready.counts });
    });
    assert.equal(confirm.sync.id, ready.sync.id);
    if (local) { report.deploy = 'not run (local read-only verification)'; return; }
    const vars = { ...config.vars, CATALOG_CACHE_EPOCH: ready.cache_epoch };
    const generated = { ...config, vars }; delete generated.env;
    const file = `.catalog-release-${randomUUID()}.json`;
    await writeFile(file, JSON.stringify(generated, null, 2));
    try {
      await step('compile_deploy_configuration', () => io.wrangler(['deploy', '--config', file, '--env', '', '--dry-run']));
      if (!deploy) { report.deploy = 'dry-run passed'; return; }
      const tag = await io.releaseIdentity(config, ready.cache_epoch);
      // Re-read immediately before deployment; never rely on the old preflight.
      const current = await api.current(); assertWorkerBindings(current, config);
      assert.equal(current.id, before.id, 'Worker changed during release gates');
      report.previous_worker_version = current.id;
      report.release_tag = tag;
      assert(current.bindings.filter(b => ['plain_text', 'json'].includes(b.type)).every(b => Object.hasOwn(vars, b.name)), 'Undeclared production vars; reconcile configuration');
      await renew();
      await step('worker_deploy', async () => {
        if (current.tag === tag) {
          assertDeployedVars(current, vars); report.deploy = 'already deployed'; report.worker_version = current.id;
        } else {
          report.deploy = 'submitted (outcome may be unknown on transport failure)';
          const text = await io.wrangler(['deploy', '--config', file, '--env', '', '--tag', tag, '--message', 'Verified catalog snapshot release']);
          const version = text.match(/Current Version ID:\s*([a-f0-9-]{36})/i)?.[1];
          const after = await api.current();
          assert.equal(after.tag, tag, 'Active release tag differs');
          if (version) assert.equal(after.id, version, 'Concurrent Worker deployment');
          assertDeployedVars(after, vars); assertWorkerBindings(after, config, current);
          report.worker_version = after.id; report.deploy = 'success';
        }
      });
      report.post_deploy = 'running'; report.verification = {};
      await step('production_http', () => io.verifyProduction(locked, 'https://pc-parts-catalog.kikuuuty.workers.dev', { snapshot, golden: !representative, report: report.verification }));
      if (representative) report.release_validation = await step('representative_verification', () => io.searchGate(locked, { representative: true, output: '.cache/transition-production-gate.json' }));
      await renew();
      await step('post_deploy_state', async () => {
        if (target) await assertPublicationState(locked, target, { contents: false });
        const after = await api.current();
        assert.equal(after.id, report.worker_version, 'Worker changed during verification');
        assert.equal(after.tag, tag, 'Worker tag changed during verification');
        assertDeployedVars(after, vars); assertWorkerBindings(after, config, current);
        report.secret_names = after.bindings.filter(b => b.type === 'secret_text').map(b => b.name);
        report.db_binding = after.bindings.find(b => b.name === 'DB');
      });
      report.post_deploy = 'pass';
    } finally { await unlink(file); }
  };
  try {
    if (deploy) return await io.withReleaseLease(publicationDatabase(db, report), operation);
    return await operation(db);
  } catch (error) {
    report.result = 'failed';
    if (report.post_deploy === 'running') report.post_deploy = 'failed';
    throw error;
  }
}
