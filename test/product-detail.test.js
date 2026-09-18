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
import { detailProductQuery,detailQueries,canonicalIdentifiers,loadProductDetail } from '../src/product-detail.js';
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
  const operations=[];
  const query=async(sql,params)=>{assert.match(sql,/^(SELECT|WITH) /);return db.query(sql,params);};
  const env={...fakeLimiters({unlimited:true}),CATALOG_CACHE_EPOCH:'detail-test',DB:{
    prepare:sql=>({bind:(...params)=>({sql,params,all:()=>{operations.push([sql]);return query(sql,params);}})}),
    async batch(statements){operations.push(statements.map(s=>s.sql));return Promise.all(statements.map(s=>query(s.sql,s.params)));},
  }};
  const request=(path,options)=>worker.fetch(new Request(`https://catalog.example${path}`,options),env);
  return{db,records,env,request,log,entries,operations,advance:n=>clock+=n};
}

test('Product Detail covers 30 categories, typed spec/facets, canonical multi-type identifiers and provenance',async t=>{
  const h=await setup(t);
  await addLocalIdentifier(h.db,{productId:1,type:'mpn',value:'MPN-12345',region:'all',evidence:'test'});
  for(let i=0;i<categories.length;i++){
    const response=await h.request(`/v1/products/${i+1}`);assert.equal(response.status,200);
    const product=await response.json();assert.equal(product.id,i+1);assert.equal(product.category,categories[i]);
    const [base]=(await h.db.query(detailProductQuery.sql,[i+1])).results;
    const queries=detailQueries(categories[i]);
    const identifiers=canonicalIdentifiers((await h.db.query(queries.identifiers,[i+1])).results);
    assert.deepEqual(product,{...base,identifiers,spec:h.records[i].spec,facets:h.records[i].facets.sort((a,b)=>a.attribute.localeCompare(b.attribute)||a.value.localeCompare(b.value))});
    assert.equal(product.source,'buildcores');assert.equal(product.upstream_key,h.records[i].product.upstream_key);
    const fallback=await loadProductDetail(async(sql,params)=>(await h.db.query(sql,params)).results,i+1);
    assert.deepEqual(product,JSON.parse(JSON.stringify(fallback)),'batch and query-only adapters preserve the complete response');
    assert.deepEqual(product.spec,h.records[i].spec);assert.deepEqual(product.facets,h.records[i].facets.sort((a,b)=>a.attribute.localeCompare(b.attribute)||a.value.localeCompare(b.value)));
    assert.equal(product.identifiers.length,5);
    const mpn=product.identifiers.find(i=>i.type==='mpn');assert(mpn.origins.some(o=>o.origin_field==='metadata.part_numbers'));
    assert(mpn.origins.some(o=>o.origin_field==='identifiers'));
    if(i===0)assert(mpn.origins.some(o=>o.origin==='local'));
    assert.equal(h.log.at(-1).d1_queries,4);
    assert.equal(h.log.at(-1).d1_operations,2);
    assert.deepEqual(h.operations.slice(-2),[[detailProductQuery.sql],Object.values(queries)]);
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
  assert.equal(h.log.at(-1).d1_queries,1);assert.equal(h.log.at(-1).d1_operations,1);
  assert(h.operations.every(op=>op.length===1),'missing/inactive must not issue a batch');
  assert.equal(h.entries.size,0);
});

test('detail cache HIT executes zero SQL, expiry/epoch invalidates, errors bypass cache',async t=>{
  const h=await setup(t);const miss=await h.request('/v1/products/1');const first=await miss.json();
  assert.equal(miss.headers.get('X-Cache'),'MISS');assert.equal(miss.headers.get('X-Cache-TTL'),'600');
  assert.deepEqual([...h.entries.keys()],['https://catalog.example/__catalog_cache/product/v3/1?epoch=detail-test&ttl=600']);
  const cached=await h.request('/v1/products/1');assert.equal(cached.headers.get('X-Cache'),'HIT');assert.equal(h.log.at(-1).d1_queries,0);
  assert.equal(h.log.at(-1).d1_operations,0);
  assert.deepEqual(await cached.json(),first);assert.equal(cached.headers.get('Cache-Control'),'no-store');
  h.db.sqlite.exec("UPDATE products SET name='Changed' WHERE id=1");
  h.advance(600001);assert.equal((await(await h.request('/v1/products/1')).json()).name,'Changed');
  h.env.CATALOG_CACHE_EPOCH='next';assert.equal((await h.request('/v1/products/1')).headers.get('X-Cache'),'MISS');
  delete h.env.DB;h.env.CATALOG_CACHE_EPOCH='unavailable';assert.equal((await h.request('/v1/products/1')).status,500);
  assert.equal(h.log.at(-1).cache_status,'BYPASS');
});

test('batch metadata sums each statement; missing costs remain unknown',async t=>{
  const h=await setup(t),batch=h.env.DB.batch;
  const metas=[{rows_read:2,rows_written:0,duration:1.25},{rows_read:7,rows_written:0,duration:2.5},{rows_read:3,rows_written:0,duration:0.75}];
  const prepare=h.env.DB.prepare;
  h.env.DB.prepare=sql=>({bind:(...params)=>{
    const statement=prepare(sql).bind(...params),all=statement.all;
    return{...statement,async all(){const result=await all();return{...result,meta:{rows_read:1,rows_written:0,duration:0.5}};}};
  }});
  h.env.DB.batch=async statements=>(await batch(statements)).map((r,i)=>({...r,meta:metas[i]}));
  const response=await h.request('/v1/products/1');assert.equal(response.status,200);
  assert.equal(response.headers.get('Server-Timing'),'d1;dur=5');
  assert.equal(h.log.at(-1).rows_read,13);assert.equal(h.log.at(-1).rows_written,0);
  assert.equal(h.log.at(-1).d1_queries,4);assert.equal(h.log.at(-1).d1_operations,2);
  delete metas[1].duration;delete metas[2].rows_read;
  const unknown=await h.request('/v1/products/2');assert.equal(unknown.status,200);
  assert.equal(unknown.headers.get('Server-Timing'),null);
  assert.equal(h.log.at(-1).rows_read,null);assert.equal(h.log.at(-1).sql_duration_ms,null);
});

test('batch failure never returns/caches partial Detail and preserves sanitized database errors',async t=>{
  const h=await setup(t);
  for(const [failure,status,code] of [
    [async()=>{throw Error('network timeout: private SQL');},503,'DATABASE_UNAVAILABLE'],
    [async()=>[{success:true,results:[]},{success:false,error:'private SQL'},{success:true,results:[]}],500,'DATABASE_ERROR'],
  ]){
    h.env.DB.batch=failure;
    const response=await h.request('/v1/products/1');assert.equal(response.status,status);
    const text=await response.text();assert.equal(JSON.parse(text).error.code,code);assert(!text.includes('private SQL'));
    assert.equal(response.headers.get('X-Cache'),'BYPASS');assert.equal(response.headers.get('Server-Timing'),null);
    assert.equal(h.entries.size,0);assert.equal(h.log.at(-1).rows_read,null);assert.equal(h.log.at(-1).sql_duration_ms,null);
    assert.equal(h.log.at(-1).d1_queries,4);assert.equal(h.log.at(-1).d1_operations,2);
  }
});

test('all detail queries use PK/product_id indexes, never catalog or identifier/facet scans',async t=>{
  const {db}=await setup(t);
  for(const category of categories)for(const sql of [detailProductQuery.sql,...Object.values(detailQueries(category))]){
    const details=(await db.query(`EXPLAIN QUERY PLAN ${sql}`,[1])).results.map(r=>r.detail);
    assert(!hasCatalogFullScan(details));assert(!details.some(d=>/^SCAN (?:upstream_identifiers|local_identifiers|product_facets)\b/.test(d)),details.join('\n'));
    assert(details.some(d=>/SEARCH .* (?:INDEX|INTEGER PRIMARY KEY)/.test(d)),details.join('\n'));
  }
});
