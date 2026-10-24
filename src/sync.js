import { randomUUID } from 'node:crypto';
import { NORMALIZER_VERSION } from './model.js';
import { readState } from './database.js';
import { makeApplicationPlan, savePlan, planForSync, latestSync, storedCatalog, assertPlan, assertPlanBase, verifyPlanState, snapshotDigest, assertUnstartedBase } from './application-plan.js';
import { DEFAULT_MAX_DELETE_FRACTION } from './quality/ingestion.js';
import { ftsIntegrity } from '../scripts/lib/fts-integrity.js';

export function planSync(snapshot, state) {
  const records = snapshot.applicationPlan ? snapshot.applicationPlan.rows.filter(r => r.mode === 'accepted').map(r => r.record) : snapshot.records;
  const present = new Set(snapshot.presence?.map(r => r.upstream_key) ?? snapshot.records.map(r => r.product.upstream_key));
  const changed = records.filter(r => {
    const old = state.get(r.product.upstream_key);
    return !old || !old.active || old.content_hash !== r.product.content_hash;
  });
  const allowed = snapshot.applicationPlan && new Set(snapshot.applicationPlan.deletions);
  const deleted = [...state.values()].filter(r => r.active && (allowed ? allowed.has(r.upstream_key) : !snapshot.heldCategories?.[r.category] && !present.has(r.upstream_key)));
  return { changed, deleted, unchanged: records.length - changed.length };
}

export function ingestionStatement(records, owner) {
  // Lease check and all products in this chunk share the statement's transaction.
  return {
    sql: `INSERT INTO ingest(payload) SELECT value FROM json_each(?) WHERE EXISTS (SELECT 1 FROM sync_lock WHERE id=1 AND owner=? AND expires_at>unixepoch())`,
    params: [JSON.stringify(records), owner],
  };
}

export async function syncSnapshot(db, snapshot, { maxProducts = Infinity, writeBudget = Infinity, dryRun = false, maxDeleteFraction = DEFAULT_MAX_DELETE_FRACTION, reuseComplete = false, baseSyncId, applicationPlan, prepareOnly = false, planFile, baselineSource, recoveryPin, workflowRunId } = {}) {
  const owner = randomUUID();
  let acquired = false;
  let started = false;
  const report = { commit: snapshot.commit, run_id: owner, status: 'running', added: 0, updated: 0, reactivated: 0, deleted: 0, unchanged: 0, remaining: 0, rows_written: 0, rows_read: 0 };
  const count = result => {
    report.rows_written += result.meta?.rows_written ?? 0;
    report.rows_read += result.meta?.rows_read ?? 0;
    return result;
  };
  const heartbeat = async () => {
    const result = count(await db.query('UPDATE sync_lock SET expires_at=unixepoch()+900 WHERE id=1 AND owner=? AND expires_at>unixepoch() RETURNING owner', [owner]));
    if (result.results.length !== 1) throw new Error('Sync lease lost');
  };
  try {
    if (!dryRun) {
      const lock = count(await db.query('INSERT INTO sync_lock(id,owner,expires_at) VALUES(1,?,unixepoch()+900) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE sync_lock.expires_at<=unixepoch() RETURNING owner', [owner]));
      if (lock.results[0]?.owner !== owner) throw new Error('Another sync holds the database lease');
      acquired = true;
    }
    const locked = { ...db, releaseOwner: owner, query: async (sql, params) => count(await db.query(sql, params)) };
    const latest = await latestSync(locked);
    if (recoveryPin) {
      if (!prepareOnly || dryRun || applicationPlan) throw new Error('plan_recovery_invalid_mode');
      await assertUnstartedBase(locked, latest, recoveryPin);
    }
    if (baseSyncId !== undefined && (latest?.id ?? null) !== baseSyncId && !(applicationPlan && latest?.plan_hash === applicationPlan.hash)) throw new Error('Pinned sync superseded by a different application plan');
    let manifest = applicationPlan;
    if (!manifest && !recoveryPin && latest?.plan_hash && (latest.status !== 'complete' || reuseComplete && latest.source_commit === snapshot.commit)) {
      const saved = await planForSync(latest, planFile);
      if (latest.status !== 'complete' || saved.input_hash === snapshotDigest(snapshot)) manifest = saved;
    }
    const actual = await storedCatalog(locked);
    if (manifest) {
      assertPlan(manifest); assertPlanBase(manifest, latest);
      if (manifest.input_hash !== snapshotDigest(snapshot)) throw new Error('Snapshot differs from fixed application plan');
      verifyPlanState(manifest, actual, { baselineOnly: latest?.plan_hash !== manifest.hash });
    } else {
      const baselinePlan = latest?.plan_hash ? await planForSync(latest) : null;
      manifest = makeApplicationPlan(snapshot, actual, latest, { maxDeleteFraction, baselineSource, baselinePlan, workflowRunId });
    }
    if (!dryRun) {
      await savePlan(manifest);
      if (planFile) await savePlan(manifest, planFile);
      await heartbeat();
    }
    report.plan_hash = manifest.hash; report.base_sync_id = manifest.base_sync_id;
    report.artifact_run_id = process.env.GITHUB_RUN_ID ?? null;
    report.quality = manifest.quality;
    report.quarantined = manifest.quarantined.length; report.retained = manifest.retained.length;
    report.expected_counts = manifest.counts;
    if (prepareOnly) return { ...report, status: 'prepared', applicationPlan: manifest };
    const state = await readState(locked);
    const plan = planSync({ ...snapshot, applicationPlan: manifest }, state);
    report.unchanged = plan.unchanged;
    report.planned_changes = plan.changed.length;
    report.planned_deletions = plan.deleted.length;
    // Deletion guards were fixed against the normal baseline before any writes.
    if (dryRun) return { ...report, status: 'dry-run' };
    // Workflow retries reuse the completed snapshot identity, under the writer
    // lease and after comparing actual product hashes (including lost writes).
    if (reuseComplete && !plan.changed.length && !plan.deleted.length) {
      if (latest?.status === 'complete' && latest.plan_hash === manifest.hash) {
        verifyPlanState(manifest, actual, { complete: true });
        if (!(await ftsIntegrity(locked)).pass) throw new Error('FTS integrity failed');
        return { ...report, run_id: latest.id, status: 'complete', reused: true };
      }
    }
    count(await db.query("UPDATE sync_runs SET status='failed',finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),error='Previous process ended without finalizing; exclusive lease has been recovered' WHERE status='running'"));
    // Millisecond ties must not let random UUID ordering select an older failed
    // run. Allocate a strictly increasing start under the exclusive DB lease.
    count(await db.query("INSERT INTO sync_runs(id,source_commit,normalization_version,status,started_at,plan_hash,base_sync_id) VALUES(?,?,?,'running',max(strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ',coalesce(?,'1970-01-01'),'+0.001 seconds')),?,?)", [owner, snapshot.commit, NORMALIZER_VERSION, latest?.started_at ?? null, manifest.hash, manifest.base_sync_id]));
    started = true;
    let processed = 0;
    // Conservative next-chunk allowance; actual D1 rows_written (including indexes/FTS) controls the budget.
    let perProductEstimate = 500;
    const canWrite = () => processed < maxProducts && report.rows_written + perProductEstimate + 100 < writeBudget;
    for (let offset = 0; offset < plan.changed.length && canWrite();) {
      await heartbeat();
      const budgetCount = Number.isFinite(writeBudget) ? Math.max(1, Math.floor((writeBudget - report.rows_written - 100) / perProductEstimate)) : 25;
      let size = Math.min(25, maxProducts - processed, budgetCount, plan.changed.length - offset);
      let chunk = plan.changed.slice(offset, offset + size);
      // D1's 2MB bound-value ceiling applies to our JSON batch parameter too.
      while (Buffer.byteLength(JSON.stringify(chunk)) > 1_800_000 && size > 1) chunk = plan.changed.slice(offset, offset + --size);
      const statement = ingestionStatement(chunk, owner);
      const result = count(await db.query(statement.sql, statement.params));
      // If lease expires between heartbeat and INSERT it applies zero rows, never silently count success.
      if (!result.meta?.changes) throw new Error('Ingest applied no rows (lease expired)');
      perProductEstimate = Math.max(perProductEstimate, Math.ceil((result.meta.rows_written ?? 0) / size * 1.5));
      for (const r of chunk) {
        const old = state.get(r.product.upstream_key);
        if (!old) report.added++;
        else if (!old.active) report.reactivated++;
        else report.updated++;
      }
      offset += size;
      processed += size;
      if (processed % 500 === 0) console.log(`Applied ${processed}/${plan.changed.length} changed products; rows_written=${report.rows_written}`);
    }
    const changesDone = processed === plan.changed.length;
    // Only a validated, fully applied snapshot can cause upstream removals.
    if (changesDone) {
      for (const row of plan.deleted) {
        if (!canWrite()) break;
        await heartbeat();
        const result = count(await db.query("UPDATE products SET active=0,source_commit=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND source='buildcores' AND EXISTS(SELECT 1 FROM sync_lock WHERE id=1 AND owner=? AND expires_at>unixepoch())", [snapshot.commit, row.id, owner]));
        if (!result.meta?.changes) throw new Error('Deletion applied no rows (lease expired)');
        report.deleted++;
        processed++;
      }
    }
    report.remaining = plan.changed.length - report.added - report.updated - report.reactivated + plan.deleted.length - report.deleted;
    report.status = report.remaining ? 'partial' : 'complete';
    if (report.status === 'complete') {
      await heartbeat();
      verifyPlanState(manifest, await storedCatalog(locked), { complete: true });
      if (!(await ftsIntegrity(locked)).pass) throw new Error('FTS integrity failed');
      await heartbeat();
    }
    // Targeted statistics maintenance only after changes; query plans are checked against D1 itself.
    if (report.status === 'complete' && processed > 0) count(await db.query('PRAGMA optimize'));
    const finalized = await db.query("UPDATE sync_runs SET status=?,finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),report_json=? WHERE id=? AND EXISTS(SELECT 1 FROM sync_lock WHERE id=1 AND owner=? AND expires_at>unixepoch())", [report.status, JSON.stringify(report), owner, owner]);
    if (!finalized.meta?.changes) throw new Error('Sync lease lost before finalization');
    return report;
  } catch (error) {
    report.status = 'failed';
    if (started) {
      try { await db.query("UPDATE sync_runs SET status='failed',finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),error=?,report_json=? WHERE id=?", ['Sync interrupted; inspect safe phase diagnostics', JSON.stringify(report), owner]); } catch { /* Original error is authoritative (e.g. exhausted daily quota). */ }
    }
    error.syncReport = report;
    throw error;
  } finally {
    if (acquired) {
      try { await db.query('DELETE FROM sync_lock WHERE id=1 AND owner=?', [owner]); } catch { /* Lease expires after 15 minutes if the service is unavailable. */ }
    }
  }
}
