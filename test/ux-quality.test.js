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

test('intent classification keeps lookup/identifier distinct from candidate-set and filter use',async()=>{
  assert.equal(classifyIntent({query:'9800X3D',class:'exact_model'}),'lookup');
  assert.equal(classifyIntent({query:'MPN',search:{identifier:{value:'MPN'}}}),'identifier');
  assert.equal(classifyIntent({query:'MAG',class:'family'}),'browse');
  assert.equal(classifyIntent({query:'MAG',search:{filters:{form_factor:'ATX'}}}),'browse_filter');
  assert.equal(classifyIntent({search:{filters:{form_factor:'ATX'}}}),'filter_only');
  const {fixture}=await loadUXFixture();assert.equal(fixture.length,233);assert.equal(fixture.filter(r=>r.review==='pending').length,102);
  assert(fixture.filter(r=>['browse','browse_filter'].includes(r.intent)).every(r=>r.relevant));
});

test('recall/precision denominators, contamination, empty results and equivalent sets are explicit',()=>{
  const m=setMetrics([1,3,9],[1,2,3,4]);assert.equal(m.recall,.5);assert.equal(m.precision,2/3);
  assert.equal(m.false_positive_count,1);assert.equal(m.false_negative_count,2);assert.equal(m.exact_set_equality,false);
  assert.equal(setMetrics([],[]).exact_set_equality,true);assert.equal(setMetrics([],[1]).precision,0);
  assert.deepEqual(setMetrics([3,1],[1,3]),setMetrics([1,3],[1,3]));
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
  const response=await createWorker({log(){}}).fetch(new Request('https://catalog.example/v1/search',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({category:'motherboard',filters:{form_factor:'ATX'},orderBy:'name',limit:50,offset:1000})}),env);
  assert.equal(response.status,200);const page=await response.json();assert.equal(page.data.length,50);
  assert.equal(page.meta.window_limit,100000);assert.equal(page.meta.next_offset,null);assert.equal(page.data[0].name,'MAG board 1000');
  assert((await verifySourceCatalog(db,catalog,snapshot)).pass);
  db.sqlite.exec("UPDATE upstream_raw SET raw_json='{}' WHERE product_id=1");
  assert(!(await verifySourceCatalog(db,catalog,snapshot)).pass);
  // Source stays intact when the retrieval index loses a document.
  db.sqlite.exec('DELETE FROM motherboard_fts WHERE rowid=1051');
  const broken=await evaluateUX(db,catalog,[fixture[3]],{source});assert.equal(broken.results[0].false_negative_count,1);
  assert(qualityFailures(broken,{requireReview:false}).some(f=>f.includes('filtered set mismatch')));
});
