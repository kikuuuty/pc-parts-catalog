import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm, unlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { database } from '../test-support/database.js';
import { normalize, normalizeV1 } from '../src/normalize.js';
import { models } from '../src/model.js';
import { InputIssue } from '../src/input-contract.js';
import { diagnostics } from '../src/diagnostics.js';
import { loadSnapshot, UPSTREAM_URL } from '../src/upstream.js';
import { syncSnapshot, ingestionStatement } from '../src/sync.js';
import { planForSync, latestSync, publishedSnapshot, readPlan, PLAN_DIRECTORY, recordDigest, storedCatalog, digest, savePlan } from '../src/application-plan.js';
import { loadQualityCatalog } from '../src/quality/catalog.js';
import { verifySourceCatalog } from '../src/quality/integrity.js';
import { ingestionQuality } from '../src/quality/ingestion.js';
import { ftsIntegrity } from '../scripts/lib/fts-integrity.js';
import { verifyFilterMetadata } from '../scripts/lib/filter-verification.js';
import { sourceCatalog, evaluateUX } from '../src/quality/ux.js';
import { publicationCases, assertPublicationCoverage } from '../src/quality/publication-cases.js';
import { verifyProduction } from '../scripts/lib/production-smoke.js';
import { createWorker } from '../src/worker.js';
import { fakeLimiters } from '../test-support/rate-limiter.js';

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const uuid = n => `aaaaaaaa-aaaa-4aaa-8aaa-${n.toString(16).padStart(12,'0')}`;
const raw = (n, extra = {}) => ({ opendb_id: uuid(n), metadata: { name: `Panel ${n}`, part_numbers: [`PANEL-${n}`] },
  screen_size: 27, resolution: { horizontalRes: 2560, verticalRes: 1440 }, refresh_rate: 165, ...extra });
const entries = (n = 12, category = 'monitor', offset = 0) => Array.from({ length:n },(_,i) => ({ category, data: raw(i+1+offset) }));
function observed(commit, inputs, heldCategories = {}) {
  const records = [], presence = [], quarantined = [], diag = diagnostics();
  for (const { category, data } of inputs) {
    const upstream_key = `${models[category].upstream}/${data.opendb_id}`;
    presence.push({ category, upstream_key, file: `open-db/${upstream_key}.json`, evidence: 'complete_git_tree_uuid_filename' });
    try { records.push(normalize(category, data, commit, i => diag.add({ ...i, category, upstream_key }))); }
    catch (e) { if (!(e instanceof InputIssue)) throw e; quarantined.push({ category, upstream_key, code:e.code, field:e.field }); }
  }
  return { commit, records, presence, quarantined, complete: true, heldCategories, report: { diagnostics: diag.report } };
}
const currentPublication = async db => publishedSnapshot(await planForSync(await latestSync(db)));

test('Catalog contract handles optional unknowns, types, explicit formats and independent raw', () => {
  const issues = [], missing = raw(1); delete missing.screen_size;
  const r = normalize('monitor', missing, A, issue => issues.push(issue));
  assert.equal(r.spec.screen_size_inches, null); assert(issues.some(i => i.field === 'screen_size'));
  for (const value of [undefined,null,'',0,false,'27','27 inches',[],{}]) {
    assert.equal(normalize('monitor',raw(1,{screen_size:value}),A).spec.screen_size_inches,null);
  }
  const unknown = normalize('mouse', raw(1,{shape:'Asymmetric ergonomic',connectivity:['Future radio',{},7]}),A);
  assert.equal(unknown.spec.shape,'Asymmetric ergonomic'); assert.deepEqual(unknown.facets,[{attribute:'connectivity',value:'Future radio'}]);
  const phones = normalize('headphones',raw(1,{connection_types:['USB futuristic',null],battery_life:0,has_microphone:false}),A);
  assert.equal(phones.spec.battery_life_hours,0); assert.equal(phones.spec.has_microphone,0);
  assert.deepEqual(phones.facets,[{attribute:'connection_types',value:'USB futuristic'}]);
  for (const value of [null,4,'USB',{},false]) assert.doesNotThrow(() => normalize('headphones',raw(1,{connection_types:value}),A));
  assert.equal(normalize('monitor',raw(1,{resolution:'4K',video_outputs:[]}),A).spec.resolution_width,null);
  assert.equal(normalize('webcam',raw(1,{frame_rate:'60fps'}),A).spec.frame_rate_fps,60);
  for (const value of ['60 FPS',60,'60']) assert.equal(normalize('webcam',raw(1,{frame_rate:value}),A).spec.frame_rate_fps,null);
  for (const value of ['constructor','__proto__','toString']) {
    assert.equal(normalize('webcam',raw(1,{frame_rate:value}),A).spec.frame_rate_fps,null);
    assert.equal(normalize('monitor',raw(1,{metadata:{name:'Test',manufacturer:value}}),A).product.manufacturer,value);
  }
  assert.equal(normalize('memory',raw(1,{modules:{capacity_gb:'16',quantity:2}}),A).spec.capacity_gb,null);
  assert.equal(normalize('memory',raw(1,{modules:{capacity_gb:1e9,quantity:1e9}}),A).spec.capacity_gb,null);
  assert.equal(normalize('gpu',raw(1,{interface:`PCIe ${'9'.repeat(80)} x${'9'.repeat(80)}`}),A).spec.pcie_lanes,null);
  assert.equal(normalize('cpu',raw(1,{socket:`LGA${'1'.repeat(197)}`}),A).spec.socket,null);
  assert.deepEqual(normalize('cpu_cooler',raw(1,{cpu_sockets:[`LGA${'1'.repeat(197)}`]}),A).facets,[]);
  assert.equal(normalize('memory',raw(1,{profile_support:['FutureProfile']}),A).spec.xmp,null);
  for (const value of [0,-1,10000,2020.5,'2020']) assert.equal(normalize('monitor',raw(1,{metadata:{name:'Year test',releaseYear:value}}),A).product.release_year,null);
  assert.equal(normalize('monitor',raw(1,{metadata:{name:'Year test',releaseYear:9999}}),A).product.release_year,9999);
  const extra = raw(1,{unreleased:{value:['new']}}), transformed = normalize('monitor',extra,A);
  assert.deepEqual(JSON.parse(transformed.raw),extra); assert(!('unreleased' in transformed.spec));
  for (const value of [null,[],3,'product']) assert.throws(() => normalize('monitor',value,A), InputIssue);
  for (const value of [null,[],{},0,false,'','  ']) assert.throws(() => normalize('monitor',raw(1,{metadata:{name:value}}),A), InputIssue);
});

test('identifier elements are isolated without numeric coercion; version is a snapshot counter', () => {
  const d = raw(1,{identifiers:{version:27,identifiers:[
    {type:'ean',value:'0012345678901',region:'all'}, {type:'upc',value:123456789012,region:'all'},
    {type:'mpn',value:'  Ab-001  ',region:'jp'}, null, {type:'unknown',value:'1234',region:'all'},
  ]}});
  const issues = [], r = normalize('monitor',d,A,i=>issues.push(i));
  assert.equal(r.product.identity_version,27);
  assert(r.identifiers.some(i=>i.value==='0012345678901'));
  assert(r.identifiers.some(i=>i.value==='  Ab-001  ' && i.value_key==='AB-001'));
  assert.equal(issues.filter(i=>i.code==='invalid_identifier').length,3);
  const expanding=raw(1,{metadata:{name:'Expansion',part_numbers:['\ufdfa'.repeat(100),'GOOD']},identifiers:{version:1,identifiers:[{type:'mpn',value:'\ufdfa'.repeat(100),region:'all'}]}});
  assert.deepEqual(normalize('monitor',expanding,A).identifiers.map(i=>i.value),['GOOD']);
  assert.deepEqual(JSON.parse(r.raw),d);
  const unicode=normalize('monitor',raw(1,{metadata:{name:'Memory',part_numbers:['AB\u200b12','AB12']}}),A);
  assert.equal(recordDigest(unicode),recordDigest({...unicode,identifiers:[...unicode.identifiers].reverse()}));
  for (const identifiers of [[{type:'mpn',value:'bad'}], {version:1,identifiers:{mpn:'bad'}}, {version:1,format_version:7,identifiers:[{type:'mpn',value:'bad',region:'all'}]}]) {
    const next=normalize('monitor',raw(1,{identifiers}),A);
    assert.equal(next.product.identity_version,null); assert.deepEqual(next.identifiers.map(i=>i.origin_field),['metadata.part_numbers']);
  }
});

async function gitFixture(t) {
  await mkdir('.cache',{recursive:true}); const repo = path.resolve(await mkdtemp('.cache/resilient-git-'));
  t.after(()=>rm(repo,{recursive:true,force:true}));
  const git = args => execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git(['init']); git(['config','user.name','Fixture']); git(['config','user.email','fixture@example.invalid']); git(['remote','add','origin',UPSTREAM_URL]);
  const put = async (file,value) => { await mkdir(path.dirname(path.join(repo,file)),{recursive:true}); await writeFile(path.join(repo,file),typeof value==='string'?value:JSON.stringify(value)); };
  for (const file of ['README.md','LICENSE.txt','docs/DATA_MODEL.md']) await put(file,'fixture');
  await put(`open-db/Monitor/${uuid(1)}.json`,raw(1));
  await put('schemas/Monitor.schema.json',{type:'object',required:['metadata','screen_size'],properties:{screen_size:{type:'number'}}});
  const commit = () => { git(['add','.']); git(['commit','-m','fixture']); return git(['rev-parse','HEAD']); };
  return { repo, put, commit, load: () => loadSnapshot(repo,{reportDirectory:path.join(repo,'../',`${path.basename(repo)}-report`)}) };
}
test('complete Git inventory isolates schema drift, added categories, invalid JSON and missing directories', async t => {
  const fixture = await gitFixture(t); const d=raw(1); delete d.screen_size;
  await fixture.put(`open-db/Monitor/${uuid(1)}.json`,d);
  await fixture.put(`open-db/Monitor/${uuid(2)}.json`,'{ broken JSON');
  await fixture.put(`open-db/FuturePart/${uuid(3)}.json`,{new_format:true}); fixture.commit();
  const snapshot=await fixture.load();
  assert.equal(snapshot.records.length,1); assert.equal(snapshot.records[0].spec.screen_size_inches,null);
  assert.equal(snapshot.presence.length,2); assert.equal(snapshot.quarantined[0].code,'invalid_json');
  assert(snapshot.report.coverage.unsupported.includes('FuturePart'));
  assert(!snapshot.heldCategories.monitor); assert(snapshot.heldCategories.cpu);
  await fixture.put('schemas/Monitor.schema.json',{$ref:'#/$defs/monitor',$defs:{monitor:{type:'object'}}}); fixture.commit();
  assert.equal((await fixture.load()).records.length,1);
  await fixture.put('schemas/Monitor.schema.json',{$ref:'https://not-fetched.invalid/new'}); fixture.commit();
  assert.equal((await fixture.load()).report.diagnostics.by_code.schema_unavailable,1);
  await unlink(path.join(fixture.repo,`open-db/Monitor/${uuid(1)}.json`));
  await assert.rejects(fixture.load(), /not clean|ENOENT/);
});
test('identity ambiguity holds its category; implementation errors are not quarantined', async t => {
  const f=await gitFixture(t);
  await f.put(`open-db/Monitor/${uuid(2)}.json`,raw(1)); f.commit();
  const snapshot=await f.load(); assert.deepEqual(snapshot.heldCategories.monitor,['ambiguous_identity']);
  assert(snapshot.quarantined.some(r=>r.code==='identity_path_mismatch'));
  const original=models.monitor.normalizer;
  models.monitor.normalizer=()=>{throw new TypeError('implementation failure');};
  try { await assert.rejects(f.load(),error=>error instanceof TypeError); }
  finally { models.monitor.normalizer=original; }
});

test('mixed sync freezes normal update, quarantine retention, new quarantine and real deletion before writes', async t => {
  const db=database(); t.after(()=>db.sqlite.close());
  const before=entries(); await syncSnapshot(db,observed(A,before));
  db.sqlite.exec("INSERT INTO local_identifiers(product_id,type,value,value_key,evidence) VALUES(2,'jan','0491234567890','0491234567890','package'); INSERT INTO local_enrichments(product_id,namespace,key,value_json,evidence) VALUES(2,'spec','note','true','checked')");
  const old=db.sqlite.prepare('SELECT * FROM products WHERE id=2').get();
  const oldRaw=db.sqlite.prepare('SELECT raw_json FROM upstream_raw WHERE product_id=2').get().raw_json;
  const inputs=structuredClone(before).filter(e=>e.data.opendb_id!==uuid(12));
  inputs[0].data.refresh_rate=240; inputs[1].data.metadata.name=[];
  inputs.push({category:'monitor',data:raw(100)},{category:'monitor',data:raw(101,{metadata:{name:''}})});
  const snapshot=observed(B,inputs);
  const prepared=await syncSnapshot(db,snapshot,{prepareOnly:true});
  const plan=prepared.applicationPlan;
  assert.equal(plan.quarantined.length,2); assert.equal(plan.retained.length,1); assert.equal(plan.deletions.length,1);
  assert.equal(plan.rows.find(r=>r.key===`Monitor/${uuid(2)}`).record.product.source_commit,A);
  const first=await syncSnapshot(db,snapshot,{applicationPlan:plan,maxProducts:1});
  assert.equal(first.status,'partial'); assert.equal(first.deleted,0);
  const resumed=await syncSnapshot(db,snapshot,{applicationPlan:plan});
  assert.equal(resumed.status,'complete'); assert.equal(resumed.deleted,1); assert.equal(resumed.added,1);
  assert.deepEqual(db.sqlite.prepare('SELECT * FROM products WHERE id=2').get(),old);
  assert.equal(db.sqlite.prepare('SELECT raw_json FROM upstream_raw WHERE product_id=2').get().raw_json,oldRaw);
  assert.equal(db.sqlite.prepare('SELECT count(*) n FROM local_identifiers').get().n,1);
  assert.equal(db.sqlite.prepare('SELECT count(*) n FROM local_enrichments').get().n,1);
  assert.equal(db.sqlite.prepare('SELECT count(*) n FROM products WHERE upstream_id=?').get(uuid(101)).n,0);
  const published=await currentPublication(db), catalog=await loadQualityCatalog(db);
  assert((await verifySourceCatalog(db,catalog,published)).pass); assert((await ftsIntegrity(db)).pass);
  assert((await verifyFilterMetadata(db,{snapshot:published})).pass);
  const evaluation=await evaluateUX(db,catalog,[{id:'all',category:'monitor',intent:'filter_only',search:{ranges:{screen_size_inches:{min:20}}}}],{source:sourceCatalog(published,catalog),operations:false});
  assert(evaluation.results[0].exact_set_equality); assert.equal(evaluation.results[0].relevant_count,12);
  const repeat=await syncSnapshot(db,snapshot,{applicationPlan:plan,reuseComplete:true}); assert(repeat.reused); assert.equal(repeat.updated,0);
  db.sqlite.exec('UPDATE monitor SET refresh_rate_hz=1 WHERE product_id=2');
  assert(!(await verifySourceCatalog(db,await loadQualityCatalog(db),published)).pass);
  await assert.rejects(syncSnapshot(db,snapshot,{applicationPlan:plan}),/fixed baseline/);
  db.sqlite.exec('UPDATE monitor SET refresh_rate_hz=165 WHERE product_id=2');
  inputs[1].data.metadata.name='Recovered Panel';
  const fixed=await syncSnapshot(db,observed(C,inputs)); assert.equal(fixed.updated,1);
  assert.equal(db.sqlite.prepare('SELECT id FROM products WHERE upstream_id=?').get(uuid(2)).id,2);
});

test('inactive quarantined reappearance remains inactive and category holds retain the entire category', async t => {
  const db=database();t.after(()=>db.sqlite.close()); const before=entries();
  await syncSnapshot(db,observed(A,before));
  await syncSnapshot(db,observed(B,before.slice(1)));
  const broken=structuredClone(before);broken[0].data.metadata.name=null;
  let result=await syncSnapshot(db,observed(C,broken)); assert.equal(result.reactivated,0);
  assert.equal(db.sqlite.prepare('SELECT active FROM products WHERE id=1').get().active,0);
  const disappearing=observed(A,[{category:'mouse',data:raw(90,{shape:'new'})}],{monitor:['category_missing_or_empty']});
  result=await syncSnapshot(db,disappearing); assert.equal(result.deleted,0); assert.equal(result.added,1);
  assert.equal(result.quality.categories.monitor.published,11);
  assert(result.quality.categories.monitor.held_since);
});

test('mass spec loss holds a category while a separate category adds and updates', async t => {
  const db=database();t.after(()=>db.sqlite.close());
  const before=[...entries(40), ...entries(2,'mouse',100).map(e=>({...e,data:{...e.data,shape:'Ergonomic'}}))];
  await syncSnapshot(db,observed(A,before));
  const inputs=structuredClone(before);
  for(const e of inputs.filter(e=>e.category==='monitor')){delete e.data.screen_size;e.data.metadata.name='Changed but held';}
  inputs[40].data.metadata.name='Changed mouse';inputs.push({category:'mouse',data:raw(200,{shape:'Future shape'})});
  const result=await syncSnapshot(db,observed(B,inputs));
  assert.equal(result.added,1);assert.equal(result.updated,1);assert.equal(result.retained,40);assert.equal(result.deleted,0);
  assert(result.quality.held.monitor.includes('coverage_loss:screen_size_inches'));
  assert.equal(db.sqlite.prepare("SELECT count(*) n FROM products WHERE category='monitor' AND source_commit=?").get(A).n,40);
  assert((await verifySourceCatalog(db,await loadQualityCatalog(db),await currentPublication(db))).pass);
});

test('constant-count 30% replacement holds only its category across partial/resume, then recovers in a new plan', async t => {
  const db=database();t.after(()=>db.sqlite.close());
  const mice=entries(2,'mouse',500).map(e=>({...e,data:{...e.data,shape:'Ergonomic'}}));
  await syncSnapshot(db,observed('d'.repeat(40),[...entries(101),...mice]));
  await syncSnapshot(db,observed(A,[...entries(100),...mice])); // one inactive row
  db.sqlite.exec("INSERT INTO local_identifiers(product_id,type,value,value_key,evidence) VALUES(1,'jan','0491234567890','0491234567890','package'); INSERT INTO local_enrichments(product_id,namespace,key,value_json,evidence) VALUES(1,'spec','note','true','checked')");
  const old=(await storedCatalog(db)).filter(r=>r.record.product.category==='monitor');
  const products=db.sqlite.prepare("SELECT * FROM products WHERE category='monitor' ORDER BY id").all();
  const local=db.sqlite.prepare('SELECT * FROM local_identifiers').all(), enrich=db.sqlite.prepare('SELECT * FROM local_enrichments').all();
  const inputs=[...entries(70,'monitor',30),...entries(30,'monitor',1000),...structuredClone(mice)];
  inputs.at(-1).data.metadata.name='Updated mouse';inputs.push({category:'mouse',data:raw(600,{shape:'Ergonomic'})});
  // Even a valid incoming inactive row must not be reactivated in a held category.
  const snapshot=observed(B,inputs);
  const {applicationPlan:plan}=await syncSnapshot(db,snapshot,{prepareOnly:true});
  const stats=plan.quality.categories.monitor;
  assert.deepEqual(stats.reasons,['category_delete_fraction']);
  assert.deepEqual(stats.deletion,{baseline_active:100,candidates:30,fraction:.3,max_delete_fraction:.2});
  assert.equal(stats.presence,100);assert.equal(stats.published,100);assert.equal(plan.deletions.length,0);
  assert.equal(plan.rows.filter(r=>r.mode==='retained').length,101);
  const first=await syncSnapshot(db,snapshot,{applicationPlan:plan,maxProducts:1});
  assert.equal(first.status,'partial');assert.equal(first.updated,1);assert.equal(first.deleted,0);
  const budget=await syncSnapshot(db,snapshot,{applicationPlan:plan,writeBudget:1});assert.equal(budget.status,'partial');
  const resumed=await syncSnapshot(db,snapshot,{applicationPlan:plan});
  assert.equal(resumed.status,'complete');assert.equal(resumed.added,1);assert.equal(resumed.quality.status,'held');
  assert.deepEqual(resumed.quality,plan.quality);
  assert.deepEqual((await storedCatalog(db)).filter(r=>r.record.product.category==='monitor'),old);
  assert.deepEqual(db.sqlite.prepare("SELECT * FROM products WHERE category='monitor' ORDER BY id").all(),products);
  assert.deepEqual(db.sqlite.prepare('SELECT * FROM local_identifiers').all(),local);
  assert.deepEqual(db.sqlite.prepare('SELECT * FROM local_enrichments').all(),enrich);
  assert.equal(db.sqlite.prepare("SELECT count(*) n FROM products WHERE upstream_id>=? AND category='monitor'").get(uuid(1001)).n,0);
  const publication=await currentPublication(db),catalog=await loadQualityCatalog(db);
  assert.equal(catalog.metadata.active_product_count,Object.values(plan.counts).reduce((a,b)=>a+b,0));
  assert((await verifySourceCatalog(db,catalog,publication)).pass);assert((await ftsIntegrity(db)).pass);
  assert((await verifyFilterMetadata(db,{snapshot:publication})).pass);
  const ux=await evaluateUX(db,catalog,[{id:'held',category:'monitor',intent:'filter_only',search:{ranges:{screen_size_inches:{min:20}}}}],{source:sourceCatalog(publication,catalog),operations:false});
  assert(ux.results[0].exact_set_equality);assert.equal(ux.results[0].relevant_count,100);
  let productWrites=0;
  const tracked={...db,async query(sql,params){if (/^(INSERT INTO ingest|UPDATE products)/.test(sql))productWrites++;return db.query(sql,params);}};
  assert((await syncSnapshot(tracked,snapshot,{applicationPlan:plan,reuseComplete:true})).reused);assert.equal(productWrites,0);
  const recoveredInputs=[...entries(100),...inputs.filter(e=>e.category==='mouse')];recoveredInputs[0].data.refresh_rate=240;
  const recovered=await syncSnapshot(db,observed(C,recoveredInputs));
  assert(!recovered.quality.held.monitor);assert.equal(recovered.updated,1);
  assert.equal(db.sqlite.prepare('SELECT id FROM products WHERE upstream_id=?').get(uuid(1)).id,1);
  assert.equal(db.sqlite.prepare('SELECT active FROM products WHERE upstream_id=?').get(uuid(101)).active,0);
});

test('deletion holds use the configured strict boundary, unique inventory, and a zero-active baseline', async t => {
  for (const [removed,threshold,held] of [[20,.2,false],[21,.2,true],[30,.3,false],[31,.3,true]]) {
    const db=database();t.after(()=>db.sqlite.close());await syncSnapshot(db,observed(A,entries(100)));
    const snapshot=observed(B,[...entries(100-removed,'monitor',removed),...entries(removed,'monitor',1000)]);
    snapshot.presence.push(...snapshot.presence); // duplicate evidence is a set
    const {applicationPlan:plan}=await syncSnapshot(db,snapshot,{prepareOnly:true,maxDeleteFraction:threshold});
    assert.equal(Boolean(plan.quality.held.monitor?.includes('category_delete_fraction')),held);
    assert.equal(plan.quality.categories.monitor.presence,100);
    assert.deepEqual(plan.quality.categories.monitor.deletion,{baseline_active:100,candidates:removed,fraction:removed/100,max_delete_fraction:threshold});
    const result=await syncSnapshot(db,snapshot,{applicationPlan:plan});
    assert.equal(result.deleted,held?0:removed);assert.equal(result.status,'complete');
  }
  const db=database();t.after(()=>db.sqlite.close());
  const result=await syncSnapshot(db,observed(A,entries(2)),{maxDeleteFraction:0});
  assert.equal(result.added,2);assert.deepEqual(result.quality.categories.monitor.deletion,{baseline_active:0,candidates:0,fraction:0,max_delete_fraction:0});
});

test('quarantined presence is not a deletion candidate, but genuine absence is', async t => {
  const db=database();t.after(()=>db.sqlite.close());await syncSnapshot(db,observed(A,entries(100)));
  const inputs=entries(99);for(const e of inputs.slice(0,30))e.data.metadata.name=[];
  const snapshot=observed(B,inputs),{applicationPlan:plan}=await syncSnapshot(db,snapshot,{prepareOnly:true});
  assert.equal(snapshot.records.length,69);assert.equal(plan.quality.categories.monitor.deletion.candidates,1);
  assert(!plan.quality.categories.monitor.reasons.includes('category_delete_fraction'));
  assert(plan.quality.held.monitor.includes('quarantine_rate')); // independent rule remains
  const small=entries(99);small[0].data.metadata.name=[];
  const next=observed(B,small),{applicationPlan:normal}=await syncSnapshot(db,next,{prepareOnly:true});
  assert(!normal.quality.held.monitor);assert.equal(normal.deletions.length,1);assert.equal(normal.retained.length,1);
  await syncSnapshot(db,next,{applicationPlan:normal});
  assert.equal(db.sqlite.prepare('SELECT active FROM products WHERE id=1').get().active,1);
  assert.equal(db.sqlite.prepare('SELECT active FROM products WHERE id=100').get().active,0);
});

test('held deletion category does not reactivate an inactive row even with valid incoming data', async t => {
  const db=database();t.after(()=>db.sqlite.close());await syncSnapshot(db,observed(A,entries(101)));
  await syncSnapshot(db,observed(B,entries(100)));
  const before=(await storedCatalog(db)).find(r=>r.id===101);assert.equal(before.active,0);
  const inputs=[...entries(70,'monitor',30),...entries(29,'monitor',1000),...entries(1,'monitor',100)];
  const result=await syncSnapshot(db,observed(C,inputs));
  assert(result.quality.held.monitor.includes('category_delete_fraction'));assert.equal(result.reactivated,0);
  assert.deepEqual((await storedCatalog(db)).find(r=>r.id===101),before);
});

test('saved policy-v1 partial plans resume without new policy evaluation or hash changes', async t => {
  const db=database();t.after(()=>db.sqlite.close());const snapshot=observed(A,entries());
  const prepared=await syncSnapshot(db,snapshot,{prepareOnly:true});
  const {hash,...body}=structuredClone(prepared.applicationPlan);body.quality.policy.version=1;
  for(const stats of Object.values(body.quality.categories))delete stats.deletion;
  const old={...body,hash:digest(body)},original=JSON.stringify(old);
  assert.equal((await syncSnapshot(db,snapshot,{applicationPlan:old,maxProducts:1})).status,'partial');
  const result=await syncSnapshot(db,snapshot,{applicationPlan:old,maxDeleteFraction:0});
  assert.equal(result.status,'complete');assert.equal(result.plan_hash,old.hash);assert.equal(result.quality.policy.version,1);
  assert.equal(JSON.stringify(await planForSync(await latestSync(db))),original);
});

test('unknown inventory holds safely and policy-v1 plans remain immutable baselines for new policy', async t => {
  const db=database();t.after(()=>db.sqlite.close());const snapshot=observed(A,entries());
  await syncSnapshot(db,snapshot);const current=await planForSync(await latestSync(db));
  const {hash:unused,...body}=structuredClone(current);body.quality.policy.version=1;
  for(const stats of Object.values(body.quality.categories))delete stats.deletion;
  const old={...body,hash:digest(body)};await savePlan(old);
  await db.query('UPDATE sync_runs SET plan_hash=?',[old.hash]);
  assert.deepEqual(await readPlan(path.join(PLAN_DIRECTORY,`${old.hash}.json`)),old);
  const next=observed(B,entries());next.presence[0].upstream_key=null;
  // Missing accepted identity is a hard failure, not permission to delete.
  await assert.rejects(syncSnapshot(db,next,{prepareOnly:true}),/missing from inventory/);
  next.presence[0]=snapshot.presence[0];next.presence[0]={...next.presence[0],evidence:'unknown'};
  const result=await syncSnapshot(db,next);assert(result.quality.held.monitor.includes('ambiguous_inventory'));
  assert.equal(result.quality.categories.monitor.deletion.candidates,null);
  assert.equal(result.quality.policy.version,2);assert.equal(result.updated,0);
  assert.deepEqual(await readPlan(path.join(PLAN_DIRECTORY,`${old.hash}.json`)),old);
});

test('quality policy catches per-category/identifier loss, accepts 96/3873 optional losses, defines bootstrap holds', () => {
  const before=entries(3873), old=observed(A,before).records.map(record=>({record,active:1}));
  const inputs=structuredClone(before);for(const e of inputs.slice(0,96))delete e.data.screen_size;
  let q=ingestionQuality(observed(B,inputs),old);
  assert(!q.held.monitor);assert.equal(q.categories.monitor.fields.screen_size_inches.lost,96);
  for(const e of inputs.slice(0,1000))delete e.data.screen_size;
  q=ingestionQuality(observed(B,inputs),old);assert(q.held.monitor.includes('coverage_loss:screen_size_inches'));
  const small=entries(5), oldSmall=observed(A,small).records.map(record=>({record,active:1}));
  for(const e of small.slice(0,2))delete e.data.screen_size;
  assert(ingestionQuality(observed(B,small),oldSmall).held.monitor);
  const sparse=entries(2); for(const e of sparse)delete e.data.screen_size;
  assert(ingestionQuality(observed(A,sparse),[]).held.monitor.includes('initial_coverage:screen_size_inches'));
  const identifiers=entries(5); for(const e of identifiers)e.data.metadata.part_numbers=[];
  assert(ingestionQuality(observed(B,identifiers),oldSmall).held.monitor.includes('coverage_loss:identifiers'));
});

test('unusable bootstrap category stays unpublished while another category is imported', async t => {
  const db=database();t.after(()=>db.sqlite.close());
  const inputs=entries(2); for(const e of inputs)delete e.data.screen_size;
  inputs.push({category:'mouse',data:raw(99,{shape:'Unknown-safe'})});
  const result=await syncSnapshot(db,observed(A,inputs));assert.equal(result.status,'complete'); assert.equal(result.added,1);
  assert.equal(result.expected_counts.monitor,0);assert.equal(result.quality.status,'held');
});

test('HTTP contracts use the fixed publication when bootstrap CPU and memory are held', async t => {
  const db=database();t.after(()=>db.sqlite.close());
  const held=Object.fromEntries(Object.keys(models).filter(c=>c!=='mouse').map(c=>[c,['category_missing_or_empty']]));
  await syncSnapshot(db,observed(A,entries(12,'mouse'),held));
  const snapshot=await currentPublication(db),cache=new Map();
  const worker=createWorker({log:()=>{},cache:{async match(key){return cache.get(key.url)?.clone();},async put(key,response){cache.set(key.url,response.clone());}}});
  const env={DB:{prepare:sql=>({bind:(...params)=>({async all(){const r=await db.query(sql,params);r.meta.duration=1;return r;}})})},...fakeLimiters({unlimited:true}),CATALOG_CACHE_EPOCH:'held-smoke'};
  const report=await verifyProduction(db,'http://127.0.0.1',{golden:false,snapshot,async request(route,init,expected=200){
    const response=await worker.fetch(new Request(`http://127.0.0.1${route}`,init),env);
    assert.equal(response.status,expected);
    return {response,body:expected===204?null:await response.json()};
  }});
  assert.equal(report.contract,'pass');assert.equal(report.filters.status,'passed');
  assert.equal(report.extended_categories.filter(c=>c.reason==='held_without_baseline').length,29);
  assert.deepEqual(report.representative_samples.map(s=>s.category),['mouse']);
});

test('missing/tampered plan, newer sync and replaced baseline cannot be rebuilt from partial DB', async t => {
  const db=database();t.after(()=>db.sqlite.close());const snapshot=observed(A,entries());
  const result=await syncSnapshot(db,snapshot,{maxProducts:1}); assert.equal(result.status,'partial');
  const file=path.join(PLAN_DIRECTORY,`${result.plan_hash}.json`), saved=await readFile(file,'utf8');
  await unlink(file);await assert.rejects(syncSnapshot(db,snapshot),/ENOENT/);
  await writeFile(file,saved); const plan=await readPlan(file);
  const tampered=structuredClone(plan);tampered.rows[0].record.spec.screen_size_inches=1;
  await assert.rejects(syncSnapshot(db,snapshot,{applicationPlan:tampered}),/hash mismatch/);
  await syncSnapshot(db,snapshot,{applicationPlan:plan});
  const next=observed(B,entries()); const prepared=await syncSnapshot(db,next,{prepareOnly:true});
  db.sqlite.exec('UPDATE monitor SET refresh_rate_hz=1 WHERE product_id=1');
  await assert.rejects(syncSnapshot(db,next,{applicationPlan:prepared.applicationPlan}),/fixed baseline/);
  db.sqlite.exec('UPDATE monitor SET refresh_rate_hz=165 WHERE product_id=1');
  await syncSnapshot(db,next,{applicationPlan:prepared.applicationPlan});
  await assert.rejects(syncSnapshot(db,snapshot,{applicationPlan:plan}),/superseded/);
});

test('DB errors, lost responses and lost leases fail; budget exhaustion stays partial', async t => {
  const db=database();t.after(()=>db.sqlite.close()); const snapshot=observed(A,entries());
  let lost=false;
  const transport={...db,async query(sql,params){const r=await db.query(sql,params);if(sql.startsWith('INSERT INTO ingest')&&!lost){lost=true;throw Error('transport');}return r;}};
  await assert.rejects(syncSnapshot(transport,snapshot),/transport/);
  assert.equal((await latestSync(db)).status,'failed');
  const resumed=await syncSnapshot(db,snapshot);assert.equal(resumed.status,'complete');assert.equal(resumed.updated+resumed.added,0);
  const next=entries();next[0].data.refresh_rate=300;
  const limited=await syncSnapshot(db,observed(B,next),{writeBudget:100});assert.equal(limited.status,'partial');
  const steal={...db,async query(sql,params){if(sql.startsWith('INSERT INTO ingest'))db.sqlite.exec('UPDATE sync_lock SET expires_at=0');return db.query(sql,params);}};
  await assert.rejects(syncSnapshot(steal,observed(B,next)),/lease expired/);
  assert.equal((await latestSync(db)).status,'failed');
});

test('prepared plans require their baseline and new-row local data is protected during resume', async t => {
  const db=database();t.after(()=>db.sqlite.close());const before=observed(A,entries());
  await syncSnapshot(db,before);
  const inputs=entries();inputs[0].data.refresh_rate=240;
  const snapshot=observed(B,inputs), {applicationPlan}=await syncSnapshot(db,snapshot,{prepareOnly:true});
  // Even a valid target row cannot be substituted before this plan has started.
  const target=applicationPlan.rows.find(r=>r.id===1).record;
  await db.query("INSERT INTO sync_lock VALUES(1,'external',unixepoch()+900)");
  const q=ingestionStatement([target],'external');await db.query(q.sql,q.params);await db.query('DELETE FROM sync_lock');
  await assert.rejects(syncSnapshot(db,snapshot,{applicationPlan}),/fixed baseline/);
  const fresh=database();t.after(()=>fresh.sqlite.close());
  await syncSnapshot(fresh,before,{maxProducts:1});
  fresh.sqlite.exec("INSERT INTO local_enrichments(product_id,namespace,key,value_json,evidence) VALUES(1,'spec','note','true','edited during resume')");
  await assert.rejects(syncSnapshot(fresh,before),/New product local data changed/);
});

test('rapid retries allocate ordered run timestamps instead of sorting random UUIDs', async t => {
  const db=database();t.after(()=>db.sqlite.close());const before=observed(A,entries());
  await syncSnapshot(db,before);
  // A controlled clock boundary makes the retry ordering deterministic.
  const boundary=new Date(Date.now()+60000).toISOString();
  await db.query('UPDATE sync_runs SET started_at=?',[boundary]);
  const inputs=entries();inputs[0].data.refresh_rate=240;const next=observed(B,inputs);
  const partial=await syncSnapshot(db,next,{writeBudget:1});
  assert.equal(partial.status,'partial');
  assert.equal((await latestSync(db)).id,partial.run_id);
  assert((await latestSync(db)).started_at>boundary);
  const complete=await syncSnapshot(db,next);
  assert.equal((await latestSync(db)).id,complete.run_id);
  assert.equal((await latestSync(db)).status,'complete');
});

test('baseline v1 is verified against independent source before its generation is replaced', async t => {
  const db=database();t.after(()=>db.sqlite.close()); const data=raw(1), old=normalizeV1('monitor',data,A);
  await db.query("INSERT INTO sync_lock VALUES(1,'old',unixepoch()+900)");const q=ingestionStatement([old],'old');await db.query(q.sql,q.params);await db.query('DELETE FROM sync_lock');
  await db.query("INSERT INTO sync_runs(id,source_commit,normalization_version,status,started_at,finished_at) VALUES('legacy',?,1,'complete','2026-09-21','2026-09-21')",[A]);
  const snapshot=observed(B,[{category:'monitor',data}]);
  await assert.rejects(syncSnapshot(db,snapshot),/Legacy baseline requires/);
  const bad=observed(A,[{category:'monitor',data:raw(1,{screen_size:32})}]);
  await assert.rejects(syncSnapshot(db,snapshot,{baselineSource:bad}),/fixed upstream/);
  const result=await syncSnapshot(db,snapshot,{baselineSource:observed(A,[{category:'monitor',data}])});assert.equal(result.updated,1);
});

test('diagnostic sample bounds preserve totals; publication exclusions are explicit and coverage bounded', () => {
  const d=diagnostics(2);for(let n=0;n<100;n++)d.add({code:'missing',category:'monitor',field:'screen_size',scope:'field'});
  assert.equal(d.report.total,100);assert.equal(d.report.samples.length,2);assert.equal(d.report.omitted,98);assert.equal(d.report.by_code.missing,100);
  d.add({code:'unsupported_category',category:'__proto__',scope:'diagnostic'});
  assert.equal(d.report.by_category.__proto__['diagnostic:unsupported_category:'],1);
  assert.equal(Object.prototype['diagnostic:unsupported_category:'],undefined);
  const fixture=Array.from({length:20},(_,i)=>({id:String(i),category:'monitor',intent:'lookup',expected:{upstream_key:`Monitor/${uuid(i)}`}}));
  const snapshot={records:[],applicationPlan:{quarantined:[{upstream_key:`Monitor/${uuid(1)}`}],quality:{held:{}},counts:{}}};
  const selection=publicationCases(fixture,snapshot);assert.equal(selection.coverage.executed,19);assertPublicationCoverage(selection.coverage,fixture);
  snapshot.applicationPlan.quality.held.monitor=['missing'];snapshot.applicationPlan.counts.monitor=0;
  const empty=publicationCases(fixture,snapshot);assert.equal(empty.coverage.executed,0);assert.throws(()=>assertPublicationCoverage(empty.coverage,fixture));
});
