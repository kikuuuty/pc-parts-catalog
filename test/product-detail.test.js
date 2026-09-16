import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { database } from '../test-support/database.js';
import { fakeLimiters } from '../test-support/rate-limiter.js';
import { extendedCases } from '../test-support/extended-cases.js';
import { categories } from '../src/model.js';
import { normalize } from '../src/normalize.js';
import { syncSnapshot } from '../src/sync.js';
import { createWorker } from '../src/worker.js';
import { detailProductQuery,detailQueries } from '../src/product-detail.js';
import { addLocalIdentifier } from '../src/enrichment.js';
import { hasCatalogFullScan } from '../src/queries.js';
const commit='a'.repeat(40);

async function setup(t){
  const db=database();t.after(()=>db.sqlite.close());
  const records=categories.map(category=>normalize(category,{opendb_id:randomUUID(),...extendedCases[category]?.data,
    metadata:{name:`Example ${category}`,part_numbers:['MPN-12345']},
    identifiers:{version:1,identifiers:['mpn','upc','ean','gtin','jan'].map(type=>({type,value:type==='mpn'?'MPN-12345':'0012345678901',region:'all'}))}},commit));
  records.push(normalize('cpu',{opendb_id:randomUUID(),metadata:{name:'No identifiers'}},commit));
  await syncSnapshot(db,{commit,records});
  let clock=1000000;const entries=new Map(),log=[];
  const cache={async match(key){return entries.get(key.url)?.clone();},async put(key,response){entries.set(key.url,response.clone());}};
  const worker=createWorker({cache,now:()=>clock,log:e=>log.push(e)});
  const env={...fakeLimiters({unlimited:true}),CATALOG_CACHE_EPOCH:'detail-test',DB:{prepare:sql=>({bind:(...params)=>({all:()=>db.query(sql,params)})})}};
  const request=(path,options)=>worker.fetch(new Request(`https://catalog.example${path}`,options),env);
  return{db,records,env,request,log,entries,advance:n=>clock+=n};
}

test('Product Detail covers 30 categories, typed spec/facets, canonical multi-type identifiers and provenance',async t=>{
  const h=await setup(t);
  await addLocalIdentifier(h.db,{productId:1,type:'mpn',value:'MPN-12345',region:'all',evidence:'test'});
  for(let i=0;i<categories.length;i++){
    const response=await h.request(`/v1/products/${i+1}`);assert.equal(response.status,200);
    const product=await response.json();assert.equal(product.id,i+1);assert.equal(product.category,categories[i]);
    assert.deepEqual(product.spec,h.records[i].spec);assert.deepEqual(product.facets,h.records[i].facets.sort((a,b)=>a.attribute.localeCompare(b.attribute)||a.value.localeCompare(b.value)));
    assert.equal(product.identifiers.length,5);
    const mpn=product.identifiers.find(i=>i.type==='mpn');assert(mpn.origins.some(o=>o.origin_field==='metadata.part_numbers'));
    assert(mpn.origins.some(o=>o.origin_field==='identifiers'));
    if(i===0)assert(mpn.origins.some(o=>o.origin==='local'));
    assert.equal(h.log.at(-1).d1_queries,4);
  }
  const empty=await(await h.request('/v1/products/31')).json();assert.deepEqual(empty.identifiers,[]);
  const search=await(await h.request('/v1/search?category=cpu&q=Example')).json();
  assert.equal((await(await h.request(`/v1/products/${search.data[0].id}`)).json()).upstream_key,search.data[0].upstream_key);
});

test('detail errors, methods and ID validation never cache 404; inactive products are unavailable',async t=>{
  const h=await setup(t);
  for(const path of ['/v1/products/9999','/v1/products/0','/v1/products/-1','/v1/products/1/nope'])assert.equal((await h.request(path)).status,404);
  assert.equal((await h.request('/v1/products/9007199254740992')).status,400);
  assert.equal((await h.request('/v1/products/1?q=x')).status,400);
  assert.equal((await h.request('/v1/products/1',{method:'POST'})).status,405);
  assert.equal((await h.request('/v1/products/1',{method:'OPTIONS'})).status,204);
  assert.equal(h.entries.size,0);
  h.db.sqlite.exec('UPDATE products SET active=0 WHERE id=1');assert.equal((await h.request('/v1/products/1')).status,404);
});

test('detail cache HIT executes zero SQL, expiry/epoch invalidates, errors bypass cache',async t=>{
  const h=await setup(t);const first=await(await h.request('/v1/products/1')).json();
  const cached=await h.request('/v1/products/1');assert.equal(cached.headers.get('X-Cache'),'HIT');assert.equal(h.log.at(-1).d1_queries,0);
  assert.deepEqual(await cached.json(),first);assert.equal(cached.headers.get('Cache-Control'),'no-store');
  h.db.sqlite.exec("UPDATE products SET name='Changed' WHERE id=1");
  h.advance(600001);assert.equal((await(await h.request('/v1/products/1')).json()).name,'Changed');
  h.env.CATALOG_CACHE_EPOCH='next';assert.equal((await h.request('/v1/products/1')).headers.get('X-Cache'),'MISS');
  delete h.env.DB;h.env.CATALOG_CACHE_EPOCH='unavailable';assert.equal((await h.request('/v1/products/1')).status,500);
  assert.equal(h.log.at(-1).cache_status,'BYPASS');
});

test('all detail queries use PK/product_id indexes, never catalog or identifier/facet scans',async t=>{
  const {db}=await setup(t);
  for(const category of categories)for(const sql of [detailProductQuery.sql,...Object.values(detailQueries(category))]){
    const details=(await db.query(`EXPLAIN QUERY PLAN ${sql}`,[1])).results.map(r=>r.detail);
    assert(!hasCatalogFullScan(details));assert(!details.some(d=>/^SCAN (?:upstream_identifiers|local_identifiers|product_facets)\b/.test(d)),details.join('\n'));
    assert(details.some(d=>/SEARCH .* (?:INDEX|INTEGER PRIMARY KEY)/.test(d)),details.join('\n'));
  }
});
