import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { database } from '../test-support/database.js';
import { normalize } from '../src/normalize.js';
import { syncSnapshot } from '../src/sync.js';
import { loadQualityCatalog } from '../src/quality/catalog.js';
import { verifySourceCatalog } from '../src/quality/integrity.js';
import { loadUXFixture, prepareUXCase, evaluateUX, sourceCatalog, qualityFailures } from '../src/quality/ux.js';
import { diagnoseResult } from '../src/quality/diagnostics.js';

// Reproduce the kinds of changes in 992dacfa..., not its IDs or search rankings.
const A='a'.repeat(40), B='b'.repeat(40);
const {fixture}=await loadUXFixture();
const caseFailures=report=>qualityFailures(report).filter(f=>report.results.some(r=>f.startsWith(`${r.id}:`)));
function localDatabase(t) {
  const db=database();t.after(()=>db.sqlite.close());
  // SQLite test adapter has no D1 duration; synthetic metadata tests correctness,
  // never supplies evidence for remote performance budgets.
  return {...db,async query(sql,params) {
    const response=await db.query(sql,params);
    return {...response,meta:{...response.meta,duration:1}};
  }};
}

test('all discovery fixtures require authored source rules; historical IDs remain valid only as evidence or exact targets',async()=>{
  assert(fixture.filter(r=>['browse','browse_filter'].includes(r.intent)).every(r=>r.relevant?.set));
  for(const cls of ['typed_spec','facet','range','broad']) {
    const item={id:'stale',category:'monitor',class:cls,query:'asus',expected:{anyOf:[{upstream_key:`Monitor/${randomUUID()}`}]}};
    assert.throws(()=>prepareUXCase({...item,acceptable:item.expected}),/Source-derived relevant.set required/);
    assert.throws(()=>prepareUXCase({...item,search:{filters:{resolution_width:2560}}}),/Source-derived relevant.set required/);
    assert.doesNotThrow(()=>prepareUXCase({...item,relevant:{set:{nameTokens:['ASUS']}}}));
    assert.doesNotThrow(()=>prepareUXCase({...item,query:null,search:{filters:{resolution_width:2560}}}));
  }
  const exact={id:'exact',query:'specific SKU',class:'exact_model',expected:{upstream_key:`GPU/${randomUUID()}`}};
  assert.equal(prepareUXCase(exact).intent,'lookup');
  assert.throws(()=>prepareUXCase({...exact,intent:'lookup',class:'family'}),/equivalents.set/);
  assert.throws(()=>prepareUXCase({...exact,intent:'lookup',class:'typed_spec'}),/Set query class/);
  assert.throws(()=>prepareUXCase({...exact,intent:'filter_only'}),/full set/);
  assert.throws(()=>prepareUXCase({...exact,intent:'browse',relevant:{set:{nameTokens:['SKU']}},search:{filters:{manufacturer:'ASUS'}}}),/browse_filter/);
});

for(const [id,category,brand,match,nonmatch,addition] of [
  ['ext-monitor-10','monitor','ASUS',{resolution:{horizontalRes:2560,verticalRes:1440}},{resolution:{horizontalRes:3840,verticalRes:2160}},true],
  ['ext-headphones-10','headphones','HyperX',{headphone_type:'Closed-Back'},{headphone_type:'Open-Back'},false],
  ['ext-headphones-11','headphones','HyperX',{connection_types:['Wireless 2.4GHz']},{connection_types:['Wired USB-C']},false],
  ['ext-headphones-12','headphones','HyperX',{weight:400},{weight:401},false],
]) test(`${id}: source addition/enrichment grows the full set, missing and extra retrieval still fail`,async t=>{
  const db=localDatabase(t),item=fixture.find(r=>r.id===id),keys=Array.from({length:4},()=>randomUUID());
  const make=(n,name,data,commit)=>normalize(category,{opendb_id:keys[n],metadata:{name},...data},commit);
  const snapshot=commit=>({commit,records:[
    make(0,`${brand} Existing`,match,commit),
    ...(!addition||commit===B?[make(1,`${brand} Newly Qualified`,commit===B?match:{},commit)]:[]),
    make(2,'Other Brand',match,commit),make(3,`${brand} Nonmatching`,nonmatch,commit),
  ]});
  // These randomized products deliberately occur in none of the frozen anyOf IDs.
  let source,catalog,report;
  for(const [commit,count] of [[A,1],[B,2]]) {
    const current=snapshot(commit);await syncSnapshot(db,current);
    catalog=await loadQualityCatalog(db);
    assert((await verifySourceCatalog(db,catalog,current)).pass);
    source=sourceCatalog(current,catalog);
    report=await evaluateUX(db,catalog,[item],{source,operations:false});
    assert.equal(report.results[0].relevant_count,count);
    assert.equal(report.results[0].recall,1);assert.equal(report.results[0].precision,1);
    assert.equal(report.results[0].false_positive_count,0);assert.equal(report.results[0].false_negative_count,0);
    assert.equal(report.results[0].invalid_filter_products,0);
    assert.deepEqual(caseFailures(report),[]);
  }
  const expected=report.results[0].relevant_ids;
  const added=source.products.find(p=>p.upstream_id===keys[1]);
  assert(expected.includes(added.id));
  // Search regression only: don't touch canonical source or expected selectors.
  db.sqlite.prepare(`DELETE FROM ${category}_fts WHERE rowid=?`).run(added.id);
  const missing=await evaluateUX(db,catalog,[item],{source,operations:false});
  assert.deepEqual(missing.results[0].relevant_ids,expected);
  assert.equal(missing.results[0].false_negative_count,1);
  assert(caseFailures(missing).includes(`${id}: filtered set mismatch`));
  const evidence=await diagnoseResult(db,source,missing.results[0]);
  assert.equal(evidence.false_negatives[0].id,added.id);
  assert.equal(evidence.missing_traces[0].fts_membership,false);
  // Simulate both semantic contamination and a broken SQL filter independently.
  for(const n of [2,3]) {
    const extra=source.products.find(p=>p.upstream_id===keys[n]);
    const polluted={...db,async query(sql,params) {
      const response=await db.query(sql,params);
      if(sql.includes(' OFFSET ?') && !sql.startsWith('EXPLAIN'))return {...response,results:[...response.results,added,extra]};
      return response;
    }};
    const bad=await evaluateUX(polluted,catalog,[item],{source,operations:false});
    assert.deepEqual(bad.results[0].relevant_ids,expected);
    assert.equal(bad.results[0].false_negative_count,0);
    assert.equal(bad.results[0].false_positive_count,1);
    assert.equal(bad.results[0].invalid_filter_products,n===3?1:0);
    assert(caseFailures(bad).includes(`${id}: filtered set mismatch`));
  }
  await assert.rejects(evaluateUX(db,catalog,[item],{source:sourceCatalog(snapshot(A),catalog),operations:false}),/matching the catalog/);
  await assert.rejects(evaluateUX(db,catalog,[{...item,relevant:item.expected}],{source,operations:false}),/Source-derived relevant.set required/);
  // Missing database rows keep source membership, represented by a missing: ID.
  const missingCatalog={...catalog,products:catalog.products.filter(p=>p.id!==added.id)};
  const independent=sourceCatalog(snapshot(B),missingCatalog);
  const absent=await evaluateUX(db,missingCatalog,[item],{source:independent,operations:false});
  assert.equal(absent.results[0].relevant_count,2);
  assert(absent.results[0].relevant_ids.some(id=>String(id).startsWith('missing:')));
  assert.equal(absent.results[0].false_negative_count,1);
});

test('TUF family accepts added derivatives, rejects unrelated top slots, and keeps exact MPN/SKU Hit@1',async t=>{
  const db=localDatabase(t),keys=Array.from({length:8},()=>randomUUID());
  const family=fixture.filter(r=>['gpu-tuf5080','gpu-asus-tuf5080'].includes(r.id));
  const make=(n,name,manufacturer,chipset,mpn,commit)=>normalize('gpu',{
    opendb_id:keys[n],metadata:{name,manufacturer,part_numbers:[mpn]},chipset,
  },commit);
  const snapshot=commit=>({commit,records:[
    make(0,'ASUS TUF Gaming GeForce RTX 5080 OC','ASUS','GeForce RTX 5080','TUF-RTX5080-O16G-GAMING',commit),
    ...(commit===B?Array.from({length:4},(_,i)=>make(i+1,`ASUS TUF Gaming GeForce RTX 5080 Edition ${i}`,'ASUS','GeForce RTX 5080',`DERIVATIVE-${i}`,commit)):[]),
    make(5,'ASUS ROG GeForce RTX 5080','ASUS','GeForce RTX 5080','OTHER-SERIES',commit),
    make(6,'ASUS TUF Gaming GeForce RTX 5070','ASUS','GeForce RTX 5070','OTHER-CHIPSET',commit),
    make(7,'Other Gaming GeForce RTX 5080','Other','GeForce RTX 5080','OTHER-MAKER',commit),
  ]});
  let catalog,source,report;
  for(const [commit,count] of [[A,1],[B,5]]) {
    const current=snapshot(commit);await syncSnapshot(db,current);catalog=await loadQualityCatalog(db);
    assert((await verifySourceCatalog(db,catalog,current)).pass);
    source=sourceCatalog(current,catalog);
    report=await evaluateUX(db,catalog,family,{source,operations:false});
    assert(report.results.every(r=>r.relevant_count===count));
    assert.deepEqual(caseFailures(report),[]);
  }
  const members=source.products.filter(p=>report.results[0].relevant_ids.includes(p.id));
  const original=members.find(p=>p.upstream_id===keys[0]);
  const derivatives=members.filter(p=>p!==original);
  const outsiders=source.products.filter(p=>!members.includes(p));
  // Controlled ordering isolates evaluator regressions from ranking implementation.
  const ordered=products=>({...db,async query(sql,params) {
    if(sql.includes(' OFFSET ?')&&!sql.startsWith('EXPLAIN'))return {results:products,meta:{rows_read:products.length,duration:1}};
    return db.query(sql,params);
  }});
  const valid=await evaluateUX(ordered([...derivatives,original]),catalog,family,{source,operations:false});
  assert.deepEqual(caseFailures(valid),[]); // Historical SKU is now rank 5.
  assert(valid.results.every(r=>r.rank===1&&r.family_precision_at_3===1));
  const diagnostic=await diagnoseResult(db,source,valid.results[0]);
  assert.equal(diagnostic.expected_products.length,5);
  assert.match(diagnostic.required,/family top3/);
  for(const rows of [[...outsiders,...members],[members[0],outsiders[0],...members.slice(1)],[members[0]]]) {
    const bad=await evaluateUX(ordered(rows),catalog,family,{source,operations:false});
    for(const item of family)assert(caseFailures(bad).includes(`${item.id}: family top3 purity/completeness floor`));
  }
  const exact={id:'exact-tuf',category:'gpu',intent:'lookup',class:'exact_model',query:original.name,expected:{upstream_key:original.upstream_key}};
  const identifier={id:'mpn-tuf',category:'gpu',intent:'identifier',query:'TUF-RTX5080-O16G-GAMING',search:{identifier:{type:'mpn',value:'TUF-RTX5080-O16G-GAMING'}}};
  const exactGood=await evaluateUX(db,catalog,[exact,identifier],{source,operations:false});
  assert.deepEqual(caseFailures(exactGood),[]);
  const exactBad=await evaluateUX(ordered([...derivatives,original]),catalog,[exact,identifier],{source,operations:false});
  assert(caseFailures(exactBad).includes('exact-tuf: Hit@1 floor'));
  assert(caseFailures(exactBad).includes('mpn-tuf: Hit@1 floor'));
  assert.deepEqual(exactBad.results[1].relevant_ids,[original.id]);
});

test('browse and filter-only also grow from source, independent of their historical expected IDs',async t=>{
  const db=localDatabase(t),keys=Array.from({length:4},()=>randomUUID());
  const historical={anyOf:[{upstream_key:`Monitor/${keys[0]}`}]};
  const cases=[
    {id:'browse',intent:'browse',category:'monitor',query:'ASUS',expected:historical,relevant:{set:{nameTokens:['ASUS']}}},
    {id:'only',intent:'filter_only',category:'monitor',search:{filters:{resolution_width:2560}},expected:historical},
  ];
  for(const [commit,size] of [[A,2],[B,4]]) {
    const snapshot={commit,records:keys.slice(0,size).map((key,i)=>normalize('monitor',{
      opendb_id:key,metadata:{name:`ASUS Monitor ${i}`},resolution:{horizontalRes:i===3?3840:2560,verticalRes:1440},
    },commit))};
    await syncSnapshot(db,snapshot);const catalog=await loadQualityCatalog(db);
    const report=await evaluateUX(db,catalog,cases,{source:sourceCatalog(snapshot,catalog),operations:false});
    assert.deepEqual(caseFailures(report),[]);
    assert.equal(report.results[0].relevant_count,size);
    assert.equal(report.results[1].relevant_count,size===4?3:2);
    assert(report.results[1].exact_set_equality&&report.results[1].pagination_correctness&&report.results[1].stable_ordering);
  }
});

for(const type of ['mpn','ean','upc','jan','gtin'])test(`${type}: identifier enrichment expands only source owners and still requires Hit@1`,async t=>{
  const db=localDatabase(t),keys=Array.from({length:3},()=>randomUUID()),value='0012345678901';
  const item={id:`exact-${type}`,category:'monitor',intent:'identifier',query:value,search:{identifier:{type,value}},floors:{hit_at:5}};
  let catalog,source,report;
  for(const [commit,count] of [[A,1],[B,2]]) {
    const snapshot={commit,records:keys.map((key,i)=>normalize('monitor',{
      opendb_id:key,metadata:{name:`Identifier Monitor ${i}`},identifiers:{version:1,identifiers:i===1&&commit===A?[]:[{type:i===2?(type==='mpn'?'ean':'mpn'):type,value,region:'all'}]},
    },commit))};
    await syncSnapshot(db,snapshot);catalog=await loadQualityCatalog(db);source=sourceCatalog(snapshot,catalog);
    assert((await verifySourceCatalog(db,catalog,snapshot)).pass);
    report=await evaluateUX(db,catalog,[item],{source,operations:false});
    assert.deepEqual(caseFailures(report),[]);
    assert.equal(report.results[0].relevant_ids.length,count);
  }
  const wrong=source.products.find(p=>p.upstream_id===keys[2]);
  const polluted={...db,async query(sql,params) {
    const response=await db.query(sql,params);
    return sql.includes(' OFFSET ?')&&!sql.startsWith('EXPLAIN')?{...response,results:[wrong,...response.results]}:response;
  }};
  const bad=await evaluateUX(polluted,catalog,[item],{source,operations:false});
  assert.deepEqual(bad.results[0].relevant_ids,report.results[0].relevant_ids);
  assert.equal(bad.results[0].rank,2);
  assert(caseFailures(bad).includes(`${item.id}: Hit@1 floor`));
});
