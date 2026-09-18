import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { openDatabase } from '../src/database.js';
import { cloudflareRelease } from './lib/cloudflare-release.js';
import { releaseIdentity } from './lib/release-gates.js';

const json=async file=>JSON.parse(await readFile(file,'utf8'));
const config=await json('wrangler.json'),promotion=await json('.cache/transition-promotion.json');
const api=await cloudflareRelease(config),current=await api.current();
assert.equal(current.id,promotion.live_worker.id);
assert.equal(current.tag,await releaseIdentity(config,config.vars.CATALOG_CACHE_EPOCH));
assert.equal(current.bindings.find(b=>b.name==='DB').database_id,config.d1_databases[0].database_id);
const databases=[];
for(const id of [promotion.retained_database,promotion.new_database]) {
  process.env.CLOUDFLARE_D1_DATABASE_ID=id;
  const db=await openDatabase(true);
  try {
    const query=async sql=>(await db.query(sql)).results;
    const locks=await query('SELECT * FROM sync_lock');assert.equal(locks.length,0);
    const migrations=await query('SELECT name FROM d1_migrations ORDER BY name');
    const sync=await query('SELECT id,source_commit,status FROM sync_runs ORDER BY started_at DESC,id DESC LIMIT 1');
    assert.equal(sync[0].status,'complete');
    if(id===promotion.retained_database) {
      assert.equal(migrations.length,6);
      assert.equal(sync[0].id,'3c0124cc-50a8-409f-9b39-219a4979a5c4');
    } else {
      assert.equal(migrations.length,9);
      assert.equal(sync[0].id,'dc3cb03f-3361-4bb4-a5c6-3584260cdb79');
    }
    databases.push({id,migrations,sync,locks});
  } finally {await db.close();}
}
const http=await json('.cache/transition-http-production.json'),gate=await json('.cache/transition-production-gate.json');
assert.equal(http.result,'pass');assert.deepEqual(gate.release_failures,[]);
const response=await fetch('https://pc-parts-catalog.kikuuuty.workers.dev/v1/health');
assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true,database:'available'});
const report={result:'production-ready / frontend-consumable',verified_at:new Date().toISOString(),worker:current,databases,
  http: http.by_intent,release_failures:gate.release_failures,source_integrity:gate.source_integrity,queries:gate.plans.length,
  known_issues:['Default branch publication pending; CI binding mismatch fails closed until then','Cold Detail ~400ms; empty/conflicting upstream identifiers','No safe production inactive fixture; local tests cover it'],
  staging:'Worker deleted; promoted database is production, no isolated staging remains'};
await writeFile('.cache/transition-final.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
