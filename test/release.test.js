import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { database } from '../test-support/database.js';
import { normalize } from '../src/normalize.js';
import { syncSnapshot } from '../src/sync.js';
import { catalogState } from '../src/quality/catalog.js';
import { cacheEpoch, productionConfig, withReleaseLease, assertGolden, readiness, migrationGate, FTS_GENERATION } from '../scripts/lib/release-gates.js';
import { assertDeployedVars } from '../scripts/lib/cloudflare-release.js';
import { pacedRequests, categorySmokeSamples } from '../scripts/lib/production-smoke.js';
import { categoryCountBounds, categoryCountDeltaError } from '../scripts/lib/category-count-guard.js';
import { latestSync, storedCatalog, digest } from '../src/application-plan.js';
import { restorePlanArtifact, prepareReleasePlan, confirmPlanArtifact, assertSavedPlan, githubPlanAdapter, loadReleaseSnapshot, PLAN_ARTIFACT } from '../scripts/lib/plan-artifact.js';

const commit = 'a'.repeat(40);
const record = () => normalize('cpu', { opendb_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', metadata: { name: 'AMD Ryzen 7 9800X3D', manufacturer: 'AMD' } }, commit);

test('category count guard allows small-category growth while preserving ratio and decrease bounds', () => {
  for (const [previous, current] of [[1, 7], [1, 11], [10, 20], [100, 150], [4000, 6000], [100, 80]]) {
    assert.equal(categoryCountDeltaError('stand', previous, current), null);
  }
  for (const [previous, current] of [[1, 12], [10, 21], [100, 151], [4000, 6001], [100, 79]]) {
    assert.match(categoryCountDeltaError('example', previous, current), /^Unexpected category count delta: example /);
  }
  assert.deepEqual(categoryCountBounds(1), { min: 0.8, max: 11 });
  assert.deepEqual(categoryCountBounds(10), { min: 8, max: 20 });
  assert.deepEqual(categoryCountBounds(4000), { min: 3200, max: 6000 });
  assert.equal(categoryCountDeltaError('stand', 1, 7), null, 'stand 1 -> 7 is a valid upstream increase');
  assert.equal(categoryCountDeltaError('gpu', 4000, 6001), 'Unexpected category count delta: gpu 4000 -> 6001 (allowed 3200..6000)');
  assert.equal(categoryCountDeltaError('gpu', 100, 79), 'Unexpected category count delta: gpu 100 -> 79 (allowed 80..150)');
});

test('actual CLI retry preserves immutable pin artifact separately from report and never re-resolves upstream', async t => {
  await mkdir('.cache', { recursive: true });
  const directory = path.resolve(await mkdtemp('.cache/release-pin-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, '.cache'));
  const file = path.join(directory, '.cache/release-pin.json');
  const pin = { commit, run_id: '123', base_sync_id: 'previous' };
  await writeFile(file, JSON.stringify(pin));
  const options = { cwd: directory, env: { ...process.env, GITHUB_RUN_ATTEMPT: '2', GITHUB_RUN_ID: '123', GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '' } };
  await promisify(execFile)(process.execPath, [path.resolve('scripts/catalog-release.js'), 'pin'], options);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), pin);
  assert.equal(JSON.parse(await readFile(path.join(directory, '.cache/release-pin-report.json'), 'utf8')).result, 'success');
  options.env.GITHUB_RUN_ID = 'another-run';
  await assert.rejects(promisify(execFile)(process.execPath, [path.resolve('scripts/catalog-release.js'), 'pin'], options));
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), pin);
  // The always() artifact step must also have a report after a failed command.
  assert.equal(JSON.parse(await readFile(path.join(directory, '.cache/release-pin-report.json'), 'utf8')).result, 'failed');
});

test('retry reuses completed sync only after comparing DB hashes; partial and failed writes resume', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  const snapshot = { commit, records: [record()] };
  const first = await syncSnapshot(db, snapshot, { reuseComplete: true });
  const repeat = await syncSnapshot(db, snapshot, { reuseComplete: true });
  assert.equal(repeat.run_id, first.run_id);
  assert.equal(repeat.reused, true);
  assert.equal(repeat.added, 0);
  assert.equal(repeat.updated, 0);
  assert.equal(repeat.unchanged, 1);
  assert.equal((await db.query('SELECT count(*) AS n FROM sync_runs')).results[0].n, 1);
  assert.equal(cacheEpoch(await catalogState(db)), `sync-${first.run_id}-fts${FTS_GENERATION}-cache3`);
  db.sqlite.exec("UPDATE products SET content_hash='interrupted-write'");
  await assert.rejects(syncSnapshot(db, snapshot, { reuseComplete: true }), /fixed baseline/);
  db.sqlite.prepare('UPDATE products SET content_hash=?').run(record().product.content_hash);
  // A failed run with all writes already committed still needs finalization.
  db.sqlite.exec("UPDATE sync_runs SET status='failed'");
  const recovered = await syncSnapshot(db, snapshot, { reuseComplete: true });
  assert.equal(recovered.status, 'complete');
  assert.notEqual(recovered.run_id, first.run_id);
  assert.equal(recovered.updated, 0);
});

test('release lease excludes sync, permits its own measurements, and cleans up on gate failure', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  const snapshot = { commit, records: [record()] };
  await syncSnapshot(db, snapshot);
  await assert.rejects(withReleaseLease(db, async (locked, renew) => {
    assert.equal((await catalogState(locked)).status, 'complete');
    await assert.rejects(catalogState(db), /synchronized/);
    await assert.rejects(syncSnapshot(db, snapshot), /lease/);
    await renew();
    throw new Error('quality stopped');
  }), /quality stopped/);
  assert.equal((await db.query('SELECT count(*) AS n FROM sync_lock')).results[0].n, 0);
  await withReleaseLease(db, async (locked, renew) => {
    db.sqlite.exec('UPDATE sync_lock SET expires_at=0');
    await assert.rejects(renew, /renewal failed/);
    await assert.rejects(renew, /lost/);
  });
});

test('retry of an old workflow cannot overwrite a newer catalog, even after acquiring the lease', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  const snapshot = { commit, records: [record()] };
  const original = await syncSnapshot(db, snapshot);
  db.sqlite.exec("UPDATE sync_runs SET source_commit='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'");
  await assert.rejects(syncSnapshot(db, snapshot, { baseSyncId: 'older-run', reuseComplete: true }), /superseded/);
  assert.equal((await db.query('SELECT count(*) AS n FROM sync_runs')).results[0].n, 1);
  assert.equal((await catalogState(db)).id, original.run_id);
  assert.equal((await db.query('SELECT count(*) AS n FROM sync_lock')).results[0].n, 0);
});

test('epoch tracks snapshot/projection/cache generations, not workflow attempts', () => {
  const sync = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'complete' };
  assert.equal(cacheEpoch(sync), cacheEpoch({ ...sync, attempt: 99 }));
  assert.notEqual(cacheEpoch(sync), cacheEpoch(sync, FTS_GENERATION + 1));
  assert.notEqual(cacheEpoch(sync), cacheEpoch(sync, FTS_GENERATION, 'v4'));
  assert.throws(() => cacheEpoch({ ...sync, status: 'partial' }));
});

test('production config rejects mismatched remote overrides, retains TTL and checks effective deployed vars', async () => {
  const config = JSON.parse(await readFile('wrangler.json', 'utf8'));
  assert.equal(productionConfig(config, {}).vars.SEARCH_CACHE_TTL_SECONDS, '300');
  const retained=structuredClone(config);
  retained.d1_databases[0]={...retained.d1_databases[0],database_name:'pc-parts-catalog',database_id:'180175e0-edc0-49df-a9d7-5958d5982e8f'};
  assert.throws(()=>productionConfig(retained,{CLOUDFLARE_D1_DATABASE_ID:'0d64ee1a-6ead-4bfd-9dfd-91535e5b3030'}),'Old checkout fails closed after binding guard publication');
  assert.throws(() => productionConfig(config, { CLOUDFLARE_D1_DATABASE_ID: config.env.local.d1_databases[0].database_id }));
  assert.throws(() => productionConfig(config, { CLOUDFLARE_ACCOUNT_ID: '0'.repeat(32) }));
  const bindings = Object.entries(config.vars).map(([name, text]) => ({ name, type: 'plain_text', text }));
  assertDeployedVars({ bindings }, config.vars);
  assert.throws(() => assertDeployedVars({ bindings: bindings.slice(1) }, config.vars));
});

test('UX gate rejects machine quality errors, not human review status or browse rank movement', () => {
  const report = { results: ['lookup','identifier','browse','browse_filter','filter_only'].map(intent => ({ id:intent,intent,rank:1,
    review:'reviewed',source_grounded:true,rows_read:100,sql_duration_ms:1,relevant_count:5,relevant_coverage:1,precision:1,filter_correctness:true,
    recall:1,false_positive_count:0,false_negative_count:0,invalid_filter_products:0,
    exact_set_equality:true,pagination_correctness:true,stable_ordering:true })) };
  assertGolden(report);
  report.results[2].rank=999; assertGolden(report);
  for (const [index,change] of [[1,{rank:2}],[2,{precision:.5}],[3,{false_positive_count:1}],[4,{pagination_correctness:false}]]) {
    const bad = structuredClone(report); Object.assign(bad.results[index], change);
    assert.throws(() => assertGolden(bad));
  }
  for(const review of ['pending','needs_changes','unsure',undefined]) {report.results[0].review=review;assertGolden(report);}
  assert.throws(() => assertGolden({results:[]}));
});

test('readiness rejects missing migration, unfinished latest sync and abnormal catalog count', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  db.sqlite.exec('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY,name TEXT)');
  await assert.rejects(migrationGate(db));
  for (const name of (await readdir('migrations')).filter(f => f.endsWith('.sql'))) db.sqlite.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run(name);
  await migrationGate(db);
  await assert.rejects(readiness(db), /Latest sync/);
  await syncSnapshot(db, { commit, records: [record()] });
  await assert.rejects(readiness(db), /Active count/);
  db.sqlite.exec("UPDATE sync_runs SET status='partial'");
  await assert.rejects(readiness(db), /Latest sync/);
});

test('production pacing honors 429 Retry-After and bounds retries without swallowing contract failure', async () => {
  const sleeps = []; let calls = 0;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'X-Request-ID, X-Cache, Retry-After', 'X-Request-ID': 'test' };
  const request = pacedRequests('https://catalog.example', { interval: 0, sleep: async n => sleeps.push(n), fetcher: async () => {
    calls++;
    return calls === 1 ? new Response('', { status: 429, headers: { 'Retry-After': '30' } }) : new Response('{}', { headers });
  } });
  await request('/v1/health');
  assert.equal(calls, 2); assert(sleeps.includes(30000));
  calls = 0;
  const limited = pacedRequests('https://catalog.example', { interval: 0, sleep: async () => {}, fetcher: async () => { calls++; return new Response('', { status: 429 }); } });
  await assert.rejects(limited('/v1/health'));
  assert.equal(calls, 3);
});

test('smoke samples separate general/Detail from identifiers using validated source, never missing DB rows', () => {
  const general = normalize('stand', { opendb_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', metadata: { name: 'Monitor Arm' } }, commit);
  const identified = normalize('stand', { opendb_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', metadata: { name: 'Other Arm', part_numbers: ['ARM-1'] } }, commit);
  assert.deepEqual(categorySmokeSamples({ records: [general] }, 'stand'), { general, identified: null });
  assert.deepEqual(categorySmokeSamples({ records: [general, identified] }, 'stand'), { general, identified });
  assert.throws(() => categorySmokeSamples({ records: [] }, 'stand'), /Missing source API sample/);
});

// Exercise the exact shared operations used by the artifact CLI, plan CLI,
// upload step and sync CLI, in workflow order, with an in-memory artifact API
// and the real local SQLite writer. No GitHub / D1 production access.
async function planRetryFixture(t,{empty=false}={}) {
  const db=database();t.after(()=>db.sqlite.close());
  const baseSnapshot={commit,records:[record()]};
  const base=empty?null:await syncSnapshot(db,baseSnapshot);
  const pin={commit:'b'.repeat(40),run_id:'123',base_sync_id:base?.run_id??null,base_plan_hash:base?.plan_hash??null,base_source_commit:base?commit:null};
  const raw=JSON.parse(record().raw);raw.metadata.name='Updated CPU';
  const snapshot={commit:pin.commit,records:[normalize('cpu',raw,pin.commit),normalize('cpu',{...raw,opendb_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'},pin.commit)]};
  const events=[],refs=[],faults={};let saved,local,receipt,creates=0,uploads=0,writes=0;
  const tracked={...db,async query(sql,params){
    if(faults.planRead && sql.startsWith('SELECT p.id,r.raw_json'))throw Error('planning_failed');
    if(sql.startsWith('INSERT INTO sync_runs'))events.push('record_start');
    if(/^(INSERT INTO ingest|UPDATE products)/.test(sql)){events.push('product_write');writes++;}
    return db.query(sql,params);
  }};
  const adapter={
    async list(){events.push('list');if(faults.list)throw Error(faults.list);return saved?[{name:PLAN_ARTIFACT,id:10,expired:Boolean(faults.expired)}]:[];},
    async download(){events.push('download');if(faults.download)throw Error('download_failed');if(faults.json)return JSON.parse('{broken');return structuredClone(saved);},
  };
  const restore=async()=>{const r=await restorePlanArtifact(adapter,pin,'123');receipt=r.receipt;local=r.plan;return r;};
  const prepare=async()=>{
    const fixed=await loadReleaseSnapshot(pin,'123',{async fetchUpstream(options){refs.push(options.ref);assert.equal(options.ref,pin.commit);},async loadSnapshot(){return snapshot;}});
    const result=await prepareReleasePlan({pin,runId:'123',receipt,load:async()=>{events.push('reuse');return local;},async create(){
      events.push('create');creates++;
      // Like catalog-release plan: the fixed pin is the ONLY upstream input.
      const result=await syncSnapshot(tracked,fixed,{prepareOnly:true,recoveryPin:pin,workflowRunId:'123',baseSyncId:pin.base_sync_id});
      return result.applicationPlan;
    }});local=result.plan;return result;
  };
  const upload=async()=>{events.push('upload');uploads++;assert(!saved,'fixed artifact must not be overwritten');if(faults.upload==='before')throw Error('upload_failed');saved=structuredClone(local);if(faults.upload==='after')throw Error('upload_response_lost');};
  const confirm=async()=>{events.push('confirm');receipt=await confirmPlanArtifact(adapter,pin,'123',local,receipt);};
  const sync=async(options={})=>{events.push('sync_gate');assertSavedPlan(local,pin,'123',receipt);return syncSnapshot(tracked,snapshot,{applicationPlan:local,baseSyncId:pin.base_sync_id,reuseComplete:true,...options});};
  const attempt=async(options)=>{await restore();const decision=await prepare();if(decision.uploadRequired){await upload();await confirm();}return sync(options);};
  return {db,tracked,pin,snapshot,baseSnapshot,events,refs,faults,adapter,restore,prepare,upload,confirm,sync,attempt,
    get creates(){return creates;},get uploads(){return uploads;},get writes(){return writes;},get plan(){return local;},get saved(){return saved;},set saved(value){saved=value;},get receipt(){return receipt;}};
}

test('plan creation failure after saved pin recovers on retry only after verified creation, upload and confirmation',async t=>{
  const f=await planRetryFixture(t);f.faults.planRead=true;
  const before=await storedCatalog(f.db);
  await assert.rejects(f.attempt(),/planning_failed/);assert.equal(f.writes,0);
  assert.deepEqual(await storedCatalog(f.db),before);assert.equal(f.saved,undefined);
  assert.equal((await f.db.query('SELECT count(*) n FROM sync_runs')).results[0].n,1);
  assert.equal((await f.db.query('SELECT count(*) n FROM sync_lock')).results[0].n,0);
  f.faults.planRead=false;f.events.length=0;
  const result=await f.attempt();assert.equal(result.status,'complete');assert.equal(result.commit,f.pin.commit);
  assert.deepEqual(f.events,['list','create','upload','confirm','list','download','sync_gate','record_start','product_write']);
  assert.equal(f.saved.hash,result.plan_hash);assert.equal(f.saved.workflow_run_id,'123');
});

test('failed upload blocks products; absent upload recovers, lost response restores without overwrite',async t=>{
  for(const mode of ['before','after']) {
    const f=await planRetryFixture(t);f.faults.upload=mode;
    await assert.rejects(f.attempt(),/upload_/);assert.equal(f.writes,0);
    assert.equal((await latestSync(f.db)).id,f.pin.base_sync_id);
    const hash=f.saved?.hash;f.faults.upload=null;f.events.length=0;
    assert.equal((await f.attempt()).status,'complete');
    assert.equal(f.creates,mode==='before'?2:1);assert.equal(f.uploads,mode==='before'?2:1);
    if(hash){assert.equal(f.saved.hash,hash);assert.deepEqual(f.events.slice(0,4),['list','download','reuse','sync_gate']);}
  }
});

test('save confirmation failures and an unconfirmed local plan cannot start product writes',async t=>{
  const f=await planRetryFixture(t);await f.restore();await f.prepare();
  await assert.rejects(f.sync(),/save_unconfirmed/);await assert.rejects(f.confirm(),/save_unconfirmed/);
  await f.upload();f.faults.list='timeout';
  await assert.rejects(f.confirm(),/timeout/);await assert.rejects(f.sync(),/save_unconfirmed/);assert.equal(f.writes,0);
  f.faults.list=null;assert.equal((await f.attempt()).status,'complete');assert.equal(f.uploads,1);assert.equal(f.creates,1);
});

test('saved plan retains commit/hash through partial resume and complete reuse without creation or upload',async t=>{
  const f=await planRetryFixture(t);assert.equal((await f.attempt({maxProducts:1})).status,'partial');
  const hash=f.saved.hash;
  assert.equal((await f.attempt()).status,'complete');const writes=f.writes;
  assert((await f.attempt()).reused);assert.equal(f.writes,writes);
  assert.equal(f.saved.hash,hash);assert.equal(f.saved.commit,f.pin.commit);assert.equal(f.creates,1);assert.equal(f.uploads,1);
  assert.deepEqual(f.refs,[f.pin.commit,f.pin.commit,f.pin.commit]);
});

test('lost artifact after any started run (running/partial/failed/complete) cannot be recreated',async t=>{
  for(const status of ['running','partial','failed','complete']){
    const f=await planRetryFixture(t);await f.attempt(status==='complete'?{}:{maxProducts:1});
    await f.db.query('UPDATE sync_runs SET status=?,report_json=NULL WHERE id=?',[status,(await latestSync(f.db)).id]);
    f.db.sqlite.exec("INSERT INTO local_enrichments(product_id,namespace,key,value_json,evidence) VALUES(1,'spec','note','true','checked')");
    const before=await storedCatalog(f.db),writes=f.writes;f.saved=undefined;
    await assert.rejects(f.attempt(),/base_changed|superseded/);assert.equal(f.writes,writes);
    assert.deepEqual(await storedCatalog(f.db),before);
    assert.equal(f.uploads,1); // no replacement upload
  }
});

test('missing plan cannot turn partial/failed/running base into a healthy baseline',async t=>{
  for(const status of ['running','partial','failed']){
    const f=await planRetryFixture(t);
    await f.db.query('UPDATE sync_runs SET status=?',[status]);
    await assert.rejects(f.attempt(),/base_not_complete/);assert.equal(f.writes,0);assert.equal(f.uploads,0);
  }
});

test('same-commit replacement before planning or after upload is superseded under the writer lease',async t=>{
  for(const phase of ['before_plan','after_upload']){
    const f=await planRetryFixture(t);
    if(phase==='after_upload'){await f.restore();await f.prepare();await f.upload();await f.confirm();}
    // A different sync ID/plan replaces the base, despite identical commit.
    await syncSnapshot(f.db,f.baseSnapshot);
    const before=await storedCatalog(f.db);
    await assert.rejects(phase==='before_plan'?f.attempt():f.sync(),/base_changed|superseded/);
    assert.equal(f.writes,0);assert.deepEqual(await storedCatalog(f.db),before);
  }
  const f=await planRetryFixture(t);await f.db.query("UPDATE sync_runs SET plan_hash=?",['f'.repeat(64)]);
  await assert.rejects(f.attempt(),/base_plan_changed/);assert.equal(f.writes,0);
  for(const status of ['partial','complete']){
    const changed=await planRetryFixture(t);await changed.restore();await changed.prepare();await changed.upload();await changed.confirm();
    await changed.db.query('UPDATE sync_runs SET status=?,plan_hash=?',[status,status==='complete'?'f'.repeat(64):changed.pin.base_plan_hash]);
    await assert.rejects(changed.sync(),/no longer complete|generation changed/);assert.equal(changed.writes,0);
  }
});

test('only a valid same-run pin and genuinely empty initial DB permit initial plan creation',async t=>{
  const empty=await planRetryFixture(t,{empty:true});assert.equal((await empty.attempt()).status,'complete');
  const orphan=await planRetryFixture(t);orphan.db.sqlite.exec('DELETE FROM sync_runs');
  Object.assign(orphan.pin,{base_sync_id:null,base_plan_hash:null,base_source_commit:null});
  await assert.rejects(orphan.attempt(),/initial_products_exist/);assert.equal(orphan.writes,0);
  const initial=await planRetryFixture(t,{empty:true});initial.pin.run_id='other';
  await assert.rejects(initial.attempt(),/pin_run_mismatch/);assert.equal(initial.creates,0);
  await assert.rejects(restorePlanArtifact(initial.adapter,null,'123'),/pin_missing/);
  delete initial.pin.base_sync_id;initial.pin.run_id='123';
  await assert.rejects(initial.attempt(),/pin_invalid_base/);assert.equal(initial.writes,0);
});

test('artifact retrieval, expiration and plan integrity errors fail closed without creating a plan',async t=>{
  for(const failure of ['403','429','500','timeout']){
    const f=await planRetryFixture(t);f.faults.list=failure;
    await assert.rejects(f.attempt(),new RegExp(failure));assert.equal(f.creates,0);assert.equal(f.writes,0);
  }
  for(const failure of ['download','json','expired','hash','commit','run','base']){
    const f=await planRetryFixture(t);await f.restore();await f.prepare();await f.upload();
    if(['download','json','expired'].includes(failure))f.faults[failure]=true;
    else if(failure==='hash')f.saved.rows[0].active=0;
    else {
      const {hash,...body}=f.saved;
      body[failure==='commit'?'commit':failure==='run'?'workflow_run_id':'base_sync_id']='wrong';
      f.saved={...body,hash:digest(body)};
    }
    await assert.rejects(f.attempt());assert.equal(f.creates,1);assert.equal(f.writes,0);assert.equal(f.uploads,1);
  }
});

test('matching baseline ID does not excuse corruption or foreign lease during missing-artifact recovery',async t=>{
  const f=await planRetryFixture(t);f.db.sqlite.exec("UPDATE cpu SET socket='corrupt' WHERE product_id=1");
  await assert.rejects(f.attempt(),/fixed baseline|Baseline source integrity/);assert.equal(f.writes,0);assert.equal(f.uploads,0);
  const leased=await planRetryFixture(t);await leased.db.query("INSERT INTO sync_lock VALUES(1,'foreign',unixepoch()+900)");
  await assert.rejects(leased.attempt(),/lease/);assert.equal(leased.writes,0);
});

test('real GitHub adapter never treats HTTP/transport/JSON/download failures as an empty artifact list',async()=>{
  const options={repository:'kikuuuty/pc-parts-catalog',runId:'123',download:async()=>{throw Error('private download detail');}};
  for(const status of [401,403,429,500,503]){
    const adapter=githubPlanAdapter({...options,request:async()=>new Response('{}',{status})});
    await assert.rejects(adapter.list(),/^Error: plan_artifact_listing_failed$/);
  }
  for(const request of [async()=>{throw Error('timeout with secret');},async()=>new Response('{broken'),async()=>new Response('{}')]){
    await assert.rejects(githubPlanAdapter({...options,request}).list(),/plan_artifact_listing_failed/);
  }
  let pages=0;
  const adapter=githubPlanAdapter({...options,request:async()=>{pages++;return Response.json({total_count:101,artifacts:Array.from({length:pages===1?100:1},(_,i)=>({id:(pages-1)*100+i,name:'other',expired:false}))});}});
  assert.equal((await adapter.list()).length,101);assert.equal(pages,2);
  await assert.rejects(adapter.download({id:1}),/^Error: plan_artifact_download_or_validation_failed$/);
  const malformed=githubPlanAdapter({...options,request:async()=>Response.json({total_count:1,artifacts:[]})});
  await assert.rejects(malformed.list(),/listing_inconsistent/);
  for(const fault of ['changed_total','repeated_id']){
    let page=0;
    const uncertain=githubPlanAdapter({...options,request:async()=>{page++;return Response.json({total_count:page===2&&fault==='changed_total'?100:101,artifacts:page===1?Array.from({length:100},(_,id)=>({id,name:'other',expired:false})):[{id:0,name:'other',expired:false}]});}});
    await assert.rejects(uncertain.list(),/listing_inconsistent/);
  }
});

test('workflow and CLI connect discovery, conditional upload on every attempt, confirmation and guarded sync',async()=>{
  const workflow=await readFile('.github/workflows/sync.yml','utf8'),cli=await readFile('scripts/catalog-release.js','utf8');
  assert(workflow.includes('node scripts/catalog-plan-artifact.js restore'));
  assert(workflow.includes("if: steps.plan.outputs.upload_required == 'true'"));
  assert(workflow.includes('overwrite: false'));assert(!workflow.includes('continue-on-error'));
  assert(cli.includes('prepareReleasePlan('));assert(cli.includes('assertSavedPlan('));
  assert(!cli.includes('if (!prepareOnly || Number(process.env.GITHUB_RUN_ATTEMPT'));
  // Behavioral coverage of these same shared operations is above, not just
  // string matching the YAML. The workflow remains the upload step owner.
});
