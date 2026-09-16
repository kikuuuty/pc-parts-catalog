// Complete-refresh cost on an isolated local verification clone only.
import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getPlatformProxy } from 'wrangler';
import { loadSnapshot } from '../src/upstream.js';
import { syncSnapshot } from '../src/sync.js';
import { captureProjection,compareProjection } from './lib/fts-verification.js';
import { ftsIntegrity } from './lib/fts-integrity.js';
const {directory}=JSON.parse(await readFile('.cache/category-release-latest.json','utf8'));
const root=path.resolve(directory);assert(root.startsWith(path.resolve('.cache')+path.sep));
const manifest=JSON.parse(await readFile(path.join(root,'manifest.json'),'utf8'));
assert.equal(manifest.engine,'local D1/workerd (not remote D1)');
const config=JSON.parse(await readFile(manifest.configPath,'utf8'));assert(config.d1_databases.every(d=>d.remote===false));
const snapshot=await loadSnapshot();assert.equal(snapshot.commit,manifest.snapshot);
const proxy=await getPlatformProxy({configPath:manifest.configPath,persist:{path:path.join(root,'state/v3')}});
let sqlMs=0,read=0,written=0;
const db={async query(sql,params=[]){const r=await proxy.env.DB.prepare(sql).bind(...params).all();sqlMs+=r.meta.duration;read+=r.meta.rows_read;written+=r.meta.rows_written;return r;}};
try{
  // Also exercises normal hash-resume after a terminated local measurement.
  const recovery=await syncSnapshot(db,snapshot,{reuseComplete:true});
  await writeFile(path.join(root,'sync-recovery.json'),JSON.stringify(recovery,null,2));
  const before=await captureProjection(db);
  await db.query("UPDATE products SET content_hash='local-refresh-measurement'");
  sqlMs=read=written=0;const start=performance.now();
  const refresh=await syncSnapshot(db,snapshot);
  const measurement={elapsed_ms:performance.now()-start,sql_duration_ms:sqlMs,all_rows_read:read,all_rows_written:written};
  const after=await captureProjection(db),difference=compareProjection(before,after),integrity=await ftsIntegrity(db);
  assert.equal(refresh.updated,snapshot.records.length);assert.equal(difference.fts_difference_count,0);
  assert.deepEqual(difference.data_changed_tables.filter(t=>!['products','sync_runs'].includes(t)),[]);assert(integrity.pass);
  const report={...refresh,...measurement,integrity,source_tables_preserved:true,projection_preserved:true};
  await writeFile(path.join(root,'sync-refresh.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{await proxy.dispose();}
