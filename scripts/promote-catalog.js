import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openDatabase } from '../src/database.js';
import { cloudflareRelease } from './lib/cloudflare-release.js';
import { productionConfig, safeDatabase, withReleaseLease, releaseIdentity } from './lib/release-gates.js';
import { qualityFailures } from '../src/quality/ux.js';

const exec=promisify(execFile),oldId='180175e0-edc0-49df-a9d7-5958d5982e8f',newId='0d64ee1a-6ead-4bfd-9dfd-91535e5b3030';
const config=productionConfig(JSON.parse(await readFile('wrangler.json','utf8')));
assert.equal(config.d1_databases[0].database_id,newId);
const before=JSON.parse(await readFile('.cache/transition-before.json','utf8'));
const budgets=JSON.parse(await readFile('docs/production-performance-budgets.json','utf8'));
for(const file of ['.cache/transition-ux-remote-1.json','.cache/transition-ux-remote-2.json','.cache/transition-ux-representative.json']) {
  const report=JSON.parse(await readFile(file,'utf8'));
  assert.deepEqual(qualityFailures(report,{budgets}),[]);
  assert.equal(report.catalog.last_sync.source_commit,'eec0df175504ebd15f0f3e3a8249a18a22f00940');
  if(file.endsWith('remote-2.json')) assert(report.source_integrity.pass);
}
assert.equal(JSON.parse(await readFile('.cache/transition-http-staging.json','utf8')).result,'pass');
const integrity=JSON.parse(await readFile('.cache/transition-integrity.json','utf8'));
assert(integrity.fts.pass);assert.equal(integrity.stable_ids,29599);
assert.equal(config.vars.CATALOG_CACHE_EPOCH,integrity.cache_epoch);
const api=await cloudflareRelease(config);
assert.equal((await api.current()).id,before.worker.id,'Production version drift');
const gh=async args=>(await exec('gh',args,{timeout:60000,encoding:'utf8'})).stdout;
const runs=JSON.parse(await gh(['run','list','--repo','kikuuuty/pc-parts-catalog','--workflow','sync.yml','--limit','20','--json','databaseId,status']));
assert(runs.every(r=>r.status==='completed'),'Active release workflow');
const priorOverride=process.env.CLOUDFLARE_D1_DATABASE_ID;
process.env.CLOUDFLARE_D1_DATABASE_ID=oldId;
const old=safeDatabase(await openDatabase(true));
if(priorOverride===undefined)delete process.env.CLOUDFLARE_D1_DATABASE_ID;else process.env.CLOUDFLARE_D1_DATABASE_ID=priorOverride;
const report={result:'preflight',previous_worker:before.worker,retained_database:oldId,new_database:newId,release_identity:await releaseIdentity(config,integrity.cache_epoch)};
try {
  const rows=async sql=>(await old.query(sql)).results;
  assert.deepEqual(await rows('SELECT * FROM local_identifiers'),before.local_identifiers);
  assert.deepEqual(await rows('SELECT * FROM local_enrichments'),before.local_enrichments);
  assert.deepEqual(await rows('SELECT * FROM d1_migrations ORDER BY name'),before.migrations);
  assert.deepEqual(await rows('SELECT * FROM sync_runs ORDER BY started_at'),before.sync_runs);
  const products=[];
  for(let id=0;;){const page=(await old.query('SELECT * FROM products WHERE id>? ORDER BY id LIMIT 1000',[id])).results;if(!page.length)break;products.push(...page);id=page.at(-1).id;}
  assert.deepEqual(products,before.products,'Production data drift');
  // From this point onward writes are only exclusion leases, a fail-closed CI
  // binding guard, and the already validated Worker/binding publication.
  await withReleaseLease(old,async(locked,renew)=>{
    assert.deepEqual(await rows('SELECT * FROM sync_runs ORDER BY started_at'),before.sync_runs);
    assert.equal((await api.current()).id,before.worker.id);
    await gh(['variable','set','CLOUDFLARE_D1_DATABASE_ID','--repo','kikuuuty/pc-parts-catalog','--body',newId]);
    report.ci_binding_guard=newId;report.result='publication started';
    await writeFile('.cache/transition-promotion.json',JSON.stringify(report,null,2)+'\n');
    await renew();
    const child=await exec(process.execPath,['scripts/catalog-release.js','deploy','--representative'],{timeout:1800000,maxBuffer:8*1024*1024,encoding:'utf8',env:{...process.env,CLOUDFLARE_D1_DATABASE_ID:newId}});
    console.log(child.stdout);
    report.live_worker=await api.current();
    assert.equal(report.live_worker.bindings.find(b=>b.name==='DB').id??report.live_worker.bindings.find(b=>b.name==='DB').database_id,newId);
    report.result='pass';
  });
} catch(error) {
  report.result='stopped';
  report.live_worker=await api.current().catch(()=>null);
  // Child output may contain provider errors; inspect the structured release
  // report rather than propagating an exec error with environment/command data.
  report.reason=error.code==='ERR_ASSERTION'?error.message.split('\n')[0]:'Publication stopped; inspect release-deploy-report.json and live binding';
  process.exitCode=1;
} finally {
  await old.close();await writeFile('.cache/transition-promotion.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}
