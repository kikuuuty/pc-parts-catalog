// Migration tests exercise the frozen pre-manifest schema using its old ingest
// contract. This adapter is never used by operational code.
import { randomUUID } from 'node:crypto';
import { readState } from '../src/database.js';
import { ingestionStatement } from '../src/sync.js';
export async function historicalSync(db, snapshot) {
  const state = await readState(db), owner = randomUUID();
  const changed = snapshot.records.filter(r => !state.has(r.product.upstream_key) || !state.get(r.product.upstream_key).active || state.get(r.product.upstream_key).content_hash !== r.product.content_hash);
  await db.query('INSERT INTO sync_lock VALUES(1,?,unixepoch()+900)', [owner]);
  try {
    if (changed.length) { const q = ingestionStatement(changed, owner); await db.query(q.sql,q.params); }
    await db.query("INSERT INTO sync_runs(id,source_commit,normalization_version,status,started_at,finished_at) VALUES(?,?,?,'complete',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))", [owner,snapshot.commit, snapshot.records[0]?.product.normalization_version ?? 1]);
  } finally { await db.query('DELETE FROM sync_lock WHERE owner=?', [owner]); }
  return { added: changed.filter(r => !state.has(r.product.upstream_key)).length, updated: changed.filter(r => state.has(r.product.upstream_key)).length, unchanged: snapshot.records.length-changed.length };
}
