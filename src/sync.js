import { randomUUID } from 'node:crypto';
import { NORMALIZER_VERSION } from './model.js';
import { readState } from './database.js';

export function planSync(snapshot, state) {
  const present = new Set(snapshot.records.map(r => r.product.upstream_key));
  const changed = snapshot.records.filter(r => {
    const old = state.get(r.product.upstream_key);
    return !old || !old.active || old.content_hash !== r.product.content_hash;
  });
  const deleted = [...state.values()].filter(r => r.active && !present.has(r.upstream_key));
  return { changed, deleted, unchanged: snapshot.records.length - changed.length };
}

export function ingestionStatement(records, owner) {
  // Lease check and all products in this chunk share the statement's transaction.
  return {
    sql: `INSERT INTO ingest(payload) SELECT value FROM json_each(?) WHERE EXISTS (SELECT 1 FROM sync_lock WHERE id=1 AND owner=? AND expires_at>unixepoch())`,
    params: [JSON.stringify(records), owner],
  };
}

export async function syncSnapshot(db, snapshot, { maxProducts = Infinity, writeBudget = Infinity, dryRun = false, maxDeleteFraction = 0.2, reuseComplete = false, baseSyncId } = {}) {
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
      if (baseSyncId !== undefined) {
        const latest = (await db.query('SELECT id,source_commit FROM sync_runs ORDER BY started_at DESC,id DESC LIMIT 1')).results[0];
        if ((latest?.id ?? null) !== baseSyncId && latest?.source_commit !== snapshot.commit) throw new Error('Pinned sync superseded by a different catalog snapshot');
      }
      count(await db.query("UPDATE sync_runs SET status='failed',finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),error='Previous process ended without finalizing; exclusive lease has been recovered' WHERE status='running'"));
    }
    const state = await readState({ query: async (sql, params) => count(await db.query(sql, params)) });
    const plan = planSync(snapshot, state);
    report.unchanged = plan.unchanged;
    report.planned_changes = plan.changed.length;
    report.planned_deletions = plan.deleted.length;
    // Guard per category as well as globally: a removed subtree must not look like ordinary deletion.
    for (const category of new Set([...state.values()].map(r => r.category))) {
      const active = [...state.values()].filter(r => r.active && r.category === category).length;
      const removed = plan.deleted.filter(r => r.category === category).length;
      if (active && removed / active > maxDeleteFraction) throw new Error(`Deletion fraction for ${category}: ${removed}/${active} exceeds ${maxDeleteFraction}`);
    }
    if (dryRun) return { ...report, status: 'dry-run' };
    // Workflow retries reuse the completed snapshot identity, under the writer
    // lease and after comparing actual product hashes (including lost writes).
    if (reuseComplete && !plan.changed.length && !plan.deleted.length) {
      const latest = (await db.query('SELECT id,source_commit,normalization_version,status FROM sync_runs ORDER BY started_at DESC,id DESC LIMIT 1')).results[0];
      if (latest?.status === 'complete' && latest.source_commit === snapshot.commit && latest.normalization_version === NORMALIZER_VERSION) {
        return { ...report, run_id: latest.id, status: 'complete', reused: true };
      }
    }
    count(await db.query("INSERT INTO sync_runs(id,source_commit,normalization_version,status,started_at) VALUES(?,?,?,'running',strftime('%Y-%m-%dT%H:%M:%fZ','now'))", [owner, snapshot.commit, NORMALIZER_VERSION]));
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
    // Targeted statistics maintenance only after changes; query plans are checked against D1 itself.
    if (report.status === 'complete' && processed > 0) count(await db.query('PRAGMA optimize'));
    await db.query("UPDATE sync_runs SET status=?,finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),report_json=? WHERE id=?", [report.status, JSON.stringify(report), owner]);
    return report;
  } catch (error) {
    if (started) {
      report.status = 'failed';
      try { await db.query("UPDATE sync_runs SET status='failed',finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),error=?,report_json=? WHERE id=?", [error.message, JSON.stringify(report), owner]); } catch { /* Original error is authoritative (e.g. exhausted daily quota). */ }
    }
    throw error;
  } finally {
    if (acquired) {
      try { await db.query('DELETE FROM sync_lock WHERE id=1 AND owner=?', [owner]); } catch { /* Lease expires after 15 minutes if the service is unavailable. */ }
    }
  }
}
