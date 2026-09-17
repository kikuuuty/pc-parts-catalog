import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { database } from '../test-support/database.js';
import { normalize } from '../src/normalize.js';
import { syncSnapshot } from '../src/sync.js';
import { loadQualityCatalog } from '../src/quality/catalog.js';
import { loadUXFixture,classifyIntent,setMetrics,evaluateUX,sourceCatalog,qualityFailures } from '../src/quality/ux.js';
import { createWorker } from '../src/worker.js';
import { fakeLimiters } from '../test-support/rate-limiter.js';
import { verifySourceCatalog } from '../src/quality/integrity.js';
import { selectExpectedSet } from '../src/quality/selection.js';
import { diagnoseResult } from '../src/quality/diagnostics.js';

test('intent classification keeps lookup/identifier distinct from candidate-set and filter use',async()=>{
  assert.equal(classifyIntent({query:'9800X3D',class:'exact_model'}),'lookup');
  assert.equal(classifyIntent({query:'MPN',search:{identifier:{value:'MPN'}}}),'identifier');
  assert.equal(classifyIntent({query:'MAG',class:'family'}),'browse');
  assert.equal(classifyIntent({query:'MAG',search:{filters:{form_factor:'ATX'}}}),'browse_filter');
  assert.equal(classifyIntent({search:{filters:{form_factor:'ATX'}}}),'filter_only');
  const {fixture}=await loadUXFixture();assert.equal(fixture.length,236);assert.equal(fixture.filter(r=>r.intent==='lookup').length,111);
  assert(fixture.every(r=>!Object.hasOwn(r,'review')));
  assert(fixture.filter(r=>['browse','browse_filter'].includes(r.intent)).every(r=>r.relevant));
});

test('recall/precision denominators, contamination, empty results and equivalent sets are explicit',()=>{
  const m=setMetrics([1,3,9],[1,2,3,4]);assert.equal(m.recall,.5);assert.equal(m.precision,2/3);
  assert.equal(m.false_positive_count,1);assert.equal(m.false_negative_count,2);assert.equal(m.exact_set_equality,false);
  assert.equal(setMetrics([],[]).exact_set_equality,true);assert.equal(setMetrics([],[1]).precision,0);
  assert.deepEqual(setMetrics([3,1],[1,3]),setMetrics([1,3],[1,3]));
});

test('source MPN equivalence excludes bundle and special edition; compact family is not SKU equivalence',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const commit='a'.repeat(40);
  const records=[['G502 HERO','910-005469'],['G502 HERO Black','910-005469'],['G502 HERO Bundle','BUNDLE'],['G502 HERO KDA','910-006095']].map(([name,mpn])=>normalize('mouse',{opendb_id:randomUUID(),metadata:{manufacturer:'Logitech',name,part_numbers:[mpn]}},commit));
  const snapshot={commit,records};await syncSnapshot(db,snapshot);const catalog=await loadQualityCatalog(db),source=sourceCatalog(snapshot,catalog);
  const equivalent={set:{fields:{'product.manufacturer':'Logitech'},identifier:{type:'mpn',value:'910-005469'}}};
  assert.equal(selectExpectedSet(source,'mouse',equivalent).length,2);
  assert.throws(()=>selectExpectedSet(source,'mouse',{set:{identifier:{type:'bad',value:'x'}}}));
  const item={id:'identity',intent:'lookup',category:'mouse',query:'G502HERO',expected:{upstream_key:records[1].product.upstream_key},equivalents:equivalent};
  const report=await evaluateUX(db,catalog,[item],{source,operations:false});
  const evidence=await diagnoseResult(db,source,report.results[0]);
  assert.equal(evidence.expected_products.length,2);assert.equal(evidence.required,'Hit@3');
  assert(evidence.top_results.every(p=>p.identifiers&&p.source_condition&&Number.isFinite(p.final_score)));
});

test('diagnostics exposes the actual missing source product and failed MATCH, not just FN totals',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const commit='a'.repeat(40);
  const record=normalize('storage',{opendb_id:randomUUID(),metadata:{name:'Kingston KC600 mSATA'},capacity:1000,storage_type:'SSD',nvme:false},commit);
  const snapshot={commit,records:[record]};await syncSnapshot(db,snapshot);const catalog=await loadQualityCatalog(db),source=sourceCatalog(snapshot,catalog);
  const item={id:'missing',intent:'browse_filter',category:'storage',query:'sata',search:{filters:{capacity_gb:1000}},relevant:{set:{nameContains:['SATA']}}};
  db.sqlite.exec('DELETE FROM storage_fts');
  const report=await evaluateUX(db,catalog,[item],{source,operations:false});const evidence=await diagnoseResult(db,source,report.results[0]);
  assert.equal(evidence.false_negative_count,1);assert.equal(evidence.false_negatives[0].upstream_key,record.product.upstream_key);
  assert.equal(evidence.missing_traces[0].fts_membership,false);assert.equal(evidence.missing_traces[0].fts_match,false);
  assert.equal(evidence.missing_traces[0].source_filters_match,true);assert.equal(evidence.missing_traces[0].typed_row.capacity_gb,1000);
});

test('human judgments neither block release nor bypass lookup or browse quality checks',()=>{
  for(const review of [undefined,'pending','reviewed','needs_changes','unsure']) {
    const lookup={id:'lookup',intent:'lookup',class:'exact_model',rank:1,rows_read:1,sql_duration_ms:1,review};
    assert(!qualityFailures({results:[lookup]}).some(f=>f.startsWith('lookup:')));
    lookup.rank=2;assert(qualityFailures({results:[lookup]}).includes('lookup: Hit@1 floor'));
  }
  const r={id:'browse',intent:'browse',review:'pending',rows_read:1,sql_duration_ms:1,relevant_count:80,relevant_coverage:1,precision:80/84,window_limit:1000};
  assert(!qualityFailures({results:[r]}).some(f=>f.startsWith('browse:')));
  r.precision=.8;assert(!qualityFailures({results:[r]}).some(f=>f.startsWith('browse:')));
  r.precision=.79;assert(qualityFailures({results:[r]}).includes('browse: candidate precision floor'));
  r.precision=.1;assert(qualityFailures({results:[r]}).includes('browse: candidate precision floor'));
  Object.assign(r,{precision:1,relevant_count:2677,relevant_coverage:1000/2677,window_exhausted:true});
  assert(!qualityFailures({results:[r]}).some(f=>f.startsWith('browse:')));
  r.relevant_coverage=.1;assert(qualityFailures({results:[r]}).includes('browse: candidate coverage floor'));
});

test('identifier collisions derive all equivalents from source; corrupt mapping fails Hit@1',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const commit='a'.repeat(40);
  const records=Array.from({length:5},(_,i)=>normalize('cpu',{opendb_id:randomUUID(),metadata:{name:`CPU ${i}`,part_numbers:['SAME-MPN-123']}},commit));
  const snapshot={commit,records};await syncSnapshot(db,snapshot);const catalog=await loadQualityCatalog(db),source=sourceCatalog(snapshot,catalog);
  const fixture=[{id:'collision',category:'cpu',intent:'identifier',search:{identifier:{type:'mpn',value:'same-mpn-123'}}}];
  const report=await evaluateUX(db,catalog,fixture,{source});assert.equal(report.results[0].rank,1);assert.equal(report.results[0].equivalent_refs.length,5);
  db.sqlite.exec('DELETE FROM upstream_identifiers');
  const broken=await evaluateUX(db,catalog,fixture,{source});assert.equal(broken.results[0].rank,null);assert(qualityFailures(broken).includes('collision: Hit@1 floor'));
});

test('intent performance budgets apply p95/count and missing metadata fails closed',()=>{
  const results=[{id:'id',intent:'identifier',rank:1,source_grounded:true,rows_read:123,sql_duration_ms:7,query_count:2}];
  assert(qualityFailures({results},{budgets:{identifier:{rows_read_p95:100,sql_duration_ms_p95:5,max_query_count:1}}}).filter(f=>f.includes('budget')).length===3);
  assert.throws(()=>qualityFailures({results},{budgets:{identifier:{rows_read_p95:-1}}}));
  results[0].sql_duration_ms=null;assert(qualityFailures({results}).includes('id: missing D1 cost metadata'));
});

test('automated lookup floors distinguish exact, normal, fallback and explicit overrides',()=>{
  for(const [cls,cutoff] of [['exact_model',1],['manufacturer_model',3],['fallback',5]]) {
    const r={id:'lookup',intent:'lookup',class:cls,rank:cutoff,rows_read:1,sql_duration_ms:1};
    assert(!qualityFailures({results:[r]}).some(f=>f.startsWith('lookup:')));
    r.rank++;assert(qualityFailures({results:[r]}).includes(`lookup: Hit@${cutoff} floor`));
    r.rank=null;assert(qualityFailures({results:[r]}).includes(`lookup: Hit@${cutoff} floor`));
  }
  const r={id:'override',intent:'lookup',review:'reviewed',class:'manufacturer_model',rank:2,floors:{hit_at:1},rows_read:1,sql_duration_ms:1};
  assert(qualityFailures({results:[r]}).includes('override: Hit@1 floor'));
});

test('source-derived sets catch missing retrieval and incorrect filters; filter pagination exceeds 1000',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const commit='a'.repeat(40);
  const records=Array.from({length:1051},(_,i)=>normalize('motherboard',{opendb_id:randomUUID(),metadata:{name:`MAG board ${String(i).padStart(4,'0')}`,part_numbers:[`MODEL-${i}`]},form_factor:i===1050?'Micro ATX':'ATX',chipset:'AMD B850'},commit));
  const snapshot={commit,records};await syncSnapshot(db,snapshot);const catalog=await loadQualityCatalog(db),source=sourceCatalog(snapshot,catalog);
  const expected={upstream_key:records[0].product.upstream_key};
  const fixture=[
    {id:'lookup',category:'motherboard',query:records[0].product.name,intent:'lookup',expected},
    {id:'id',category:'motherboard',intent:'identifier',search:{identifier:{type:'mpn',value:'MODEL-0'}},expected},
    {id:'browse',category:'motherboard',intent:'browse',query:'MAG',relevant:{set:{nameTokens:['MAG']}}},
    {id:'filtered',category:'motherboard',intent:'browse_filter',query:'MAG',search:{filters:{form_factor:'Micro ATX'}},relevant:{set:{nameTokens:['MAG']}}},
    {id:'only',category:'motherboard',intent:'filter_only',search:{filters:{form_factor:'ATX'},orderBy:'name'}},
    {id:'empty',category:'motherboard',intent:'filter_only',search:{filters:{chipset:'absent'}}},
  ];
  const report=await evaluateUX(db,catalog,fixture,{source});
  assert.equal(report.results[0].rank,1);assert.equal(report.results[1].rank,1);
  assert.equal(report.results[2].rank,null);assert.equal(report.results[2].recall_at_20,20/1051);
  assert.equal(report.results[3].recall,1);assert.equal(report.results[3].precision,1);
  assert.equal(report.results[4].returned,1050);assert(report.results[4].exact_set_equality);assert(report.results[4].pagination_correctness);
  assert(report.results[5].zero_results);assert(report.results[5].exact_set_equality);
  const env={...fakeLimiters({unlimited:true}),DB:{prepare:sql=>({bind:(...params)=>({all:()=>db.query(sql,params)})})}};
  const worker=createWorker({log(){}});let cursor,all=[];
  do {
    const response=await worker.fetch(new Request('https://catalog.example/v1/search',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({category:'motherboard',filters:{form_factor:'ATX'},limit:50,cursor})}),env);
    assert.equal(response.status,200);const page=await response.json();all.push(...page.data);
    assert.equal(page.meta.window_limit,null);assert.equal(page.meta.next_offset,null);cursor=page.meta.next_cursor??undefined;
  }while(cursor);
  assert.equal(all.length,1050);assert.equal(new Set(all.map(p=>p.id)).size,1050);
  assert((await verifySourceCatalog(db,catalog,snapshot)).pass);
  db.sqlite.exec("UPDATE upstream_raw SET raw_json='{}' WHERE product_id=1");
  assert(!(await verifySourceCatalog(db,catalog,snapshot)).pass);
  // Source stays intact when the retrieval index loses a document.
  db.sqlite.exec('DELETE FROM motherboard_fts WHERE rowid=1051');
  const broken=await evaluateUX(db,catalog,[fixture[3]],{source});assert.equal(broken.results[0].false_negative_count,1);
  assert(qualityFailures(broken).some(f=>f.includes('filtered set mismatch')));
});
