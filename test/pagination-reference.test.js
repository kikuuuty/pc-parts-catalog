import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { database } from '../test-support/database.js';
import { normalize } from '../src/normalize.js';
import { syncSnapshot } from '../src/sync.js';
import { createWorker } from '../src/worker.js';
import { fakeLimiters } from '../test-support/rate-limiter.js';
import { cursorContext,encodeCursor } from '../src/pagination.js';
import { resolveQuery } from '../src/product-reference.js';
import { searchQuery,hasCatalogFullScan } from '../src/queries.js';
import { serializeBuild,parseBuild,buildURL,referencesFromURL,restoreBuild } from '../examples/shared-build.js';

const post=input=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
async function setup(t) {
  const db=database();t.after(()=>db.sqlite.close());const commit='a'.repeat(40);
  const records=Array.from({length:67},(_,i)=>normalize(i===66?'gpu':'memory',{opendb_id:randomUUID(),metadata:{name:`Kit ${String(66-i).padStart(3,'0')}`,manufacturer:i%2?'Acme':'Other'},ram_type:'DDR5',capacity:32},commit));
  await syncSnapshot(db,{commit,records});
  // Deliberately exercise legacy empty strings, NULL and ASCII case ties.
  db.sqlite.exec("UPDATE products SET series=CASE id%3 WHEN 0 THEN NULL WHEN 1 THEN '' ELSE 'Alpha' END; UPDATE products SET manufacturer='acme' WHERE id%4=1");
  const queries=[],logs=[];
  const env={...fakeLimiters({unlimited:true}),CATALOG_CACHE_EPOCH:'epoch-1',DB:{prepare:sql=>({bind:(...params)=>({all:()=>{queries.push({sql,params});return db.query(sql,params);}})})}};
  const worker=createWorker({log:e=>logs.push(e),cache:{match(){throw Error('cursor/resolve must bypass cache');},put(){throw Error('must bypass');}}});
  const request=(path,init)=>worker.fetch(new Request(`https://catalog.example${path}`,init),env);
  return {db,records,queries,logs,env,request,search:input=>request('/v1/search',post({category:'memory',...input}))};
}
const ascii=s=>(s??'').replace(/[A-Z]/g,c=>c.toLowerCase());
function compare(a,b) {
  const aa=[ascii(a.manufacturer),a.series===null?1:0,ascii(a.series),ascii(a.name),a.id];
  const bb=[ascii(b.manufacturer),b.series===null?1:0,ascii(b.series),ascii(b.name),b.id];
  for(let i=0;i<aa.length;i++)if(aa[i]!==bb[i])return aa[i]<bb[i]?-1:1;
  return 0;
}

test('cursor first/next/final pages change size, replay, NOCASE/NULL/empty order, no duplicate/missing',async t=>{
  const {db,search,queries}=await setup(t);
  const first=await (await search({limit:7})).json();assert(first.meta.has_more);assert(first.meta.next_cursor);
  assert.equal(first.meta.window_limit,null);assert.equal(first.meta.next_offset,null);
  const nextInput={limit:13,cursor:first.meta.next_cursor};
  assert.deepEqual(await (await search(nextInput)).json(),await (await search(nextInput)).json());
  const all=[...first.data];let cursor=first.meta.next_cursor,page;
  do {page=await (await search({limit:13,cursor})).json();all.push(...page.data);cursor=page.meta.next_cursor;}while(cursor);
  assert.equal(page.meta.has_more,false);assert.equal(page.meta.window_exhausted,false);
  const expected=(await db.query("SELECT * FROM products WHERE category='memory' AND active=1")).results.sort(compare);
  assert.deepEqual(all.map(p=>p.id),expected.map(p=>p.id));assert.equal(new Set(all.map(p=>p.id)).size,66);
  assert(queries.every(q=>!q.sql.includes('OFFSET')));
  for(const q of [queries[0],queries[1]])assert(!hasCatalogFullScan((await db.query(`EXPLAIN QUERY PLAN ${q.sql}`,q.params)).results.map(r=>r.detail)));
});

test('cursor rejects malformed/corrupted/version/category/filter/order/epoch/unsafe context before SQL',async t=>{
  const {search,queries,env}=await setup(t);
  const input={category:'memory',filters:{ram_type:'DDR5'}};
  const first=await(await search({...input,limit:3})).json();const cursor=first.meta.next_cursor;
  const context=await cursorContext(input,env.CATALOG_CACHE_EPOCH);
  const unsafe=await encodeCursor(context,['Acme',0,'','x',-1]);
  const envelope=JSON.parse(Buffer.from(cursor,'base64url').toString());
  const payload=JSON.parse(envelope.payload);payload.v=99;envelope.payload=JSON.stringify(payload);
  envelope.checksum=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(envelope.payload))),b=>b.toString(16).padStart(2,'0')).join('');
  const unsupported=Buffer.from(JSON.stringify(envelope)).toString('base64url');
  for(const change of [{cursor:'!'}, {cursor:cursor.slice(0,-5)+'AAAAA'}, {cursor:unsupported},{cursor:unsafe},
    {category:'gpu',cursor},{filters:{ram_type:'DDR4'},cursor},{ranges:{speed:{min:1}},cursor},{orderBy:'name',cursor},{keyword:'kit',cursor},{offset:1,cursor}]) {
    const before=queries.length;const response=await search({...input,...change});assert.equal(response.status,400);assert.equal(queries.length,before);
    assert(!/SELECT|WHERE|SQL|stack/.test(await response.text()));
  }
  env.CATALOG_CACHE_EPOCH='epoch-2';assert.equal((await search({...input,cursor})).status,400);
});

test('active-state changes do not shift keyset boundary; removed anchor can be reused',async t=>{
  const {db,search}=await setup(t);const first=await(await search({limit:7})).json();
  const anchor=first.data.at(-1);const next=await(await search({limit:50,cursor:first.meta.next_cursor})).json();
  const removed=next.data[0].id;
  await db.query('UPDATE products SET active=0 WHERE id IN (?,?)',[anchor.id,removed]);
  const page=await(await search({limit:50,cursor:first.meta.next_cursor})).json();
  assert.deepEqual(page.data.slice(0,49).map(p=>p.id),next.data.slice(1).map(p=>p.id));
  assert(!page.data.some(p=>first.data.some(r=>r.id===p.id)||p.id===removed));
});

test('custom typed order cursor and filter fingerprint preserve page-size independent traversal',async t=>{
  const {db,search}=await setup(t);await db.query('UPDATE memory SET capacity_gb=NULL WHERE product_id=2');
  const input={orderBy:'capacity_gb',filters:{ram_type:['DDR5','DDR4']}};let cursor,ids=[];
  do {const page=await(await search({...input,limit:11,...(cursor?{cursor,filters:{ram_type:['DDR4','DDR5']}}:{})})).json();ids.push(...page.data.map(p=>p.id));cursor=page.meta.next_cursor;}while(cursor);
  assert.equal(ids.length,66);assert.equal(new Set(ids).size,66);assert.equal(ids.at(-1),2);
  const q=searchQuery('memory',{...input,limit:100});assert.deepEqual(ids,(await db.query(q.sql,q.params)).results.map(p=>p.id));
});

test('resolve one indexed batch preserves active/inactive/missing, duplicates, order and categories',async t=>{
  const {db,request,records,queries}=await setup(t);await db.query('UPDATE products SET active=0 WHERE id=2');
  const ref=r=>({source:'buildcores',upstream_key:r.product.upstream_key});
  const refs=[ref(records[66]),ref(records[1]),{source:'unknown',upstream_key:'CPU/missing'},ref(records[0]),ref(records[0])];
  const response=await request('/v1/products/resolve',post({products:refs}));assert.equal(response.status,200);
  assert.equal(response.headers.get('x-cache'),'BYPASS');assert.equal(response.headers.get('cache-control'),'no-store');
  const result=await response.json();assert.equal(queries.length,1);
  assert.deepEqual(result.products.map(p=>p.status),['active','inactive','missing','active','active']);
  assert.deepEqual(result.products.map(({source,upstream_key})=>({source,upstream_key})),refs);
  assert.deepEqual(result.products.map(p=>p.category),['gpu','memory',null,'memory','memory']);
  assert.deepEqual(result.products.map(p=>p.active),[true,false,null,true,true]);
  const q=resolveQuery(refs);const plan=(await db.query(`EXPLAIN QUERY PLAN ${q.sql}`,q.params)).results.map(r=>r.detail);
  assert(!hasCatalogFullScan(plan));assert(plan.some(p=>/SEARCH p USING INDEX.*source=\? AND upstream_key=\?/.test(p)));
  assert.equal((await request('/v1/products/2')).status,404);
  assert.equal((await request('/v1/products/resolve', {method:'GET'})).status,405);
  assert.equal((await request('/v1/products/resolve', {method:'OPTIONS'})).status,204);
});

test('resolve bounded 64 refs uses one bind; malformed input rejected before SQL',async t=>{
  const {request,records,queries}=await setup(t);const ref={source:'buildcores',upstream_key:records[0].product.upstream_key};
  const response=await request('/v1/products/resolve',post({products:Array(64).fill(ref)}));assert.equal(response.status,200);
  assert.equal((await response.json()).products.length,64);assert.equal(queries[0].params.length,1);
  for(const input of [{products:[]},{products:Array(65).fill(ref)},{products:[null]},{products:[{source:'buildcores'}]},
    {products:[{...ref,source:'x; DROP TABLE products'}]},{products:[{...ref,upstream_key:'../bad'}]},
    {products:[{...ref,id:1}]},{products:[ref],extra:true}]) {
    const before=queries.length;assert.equal((await request('/v1/products/resolve',post(input))).status,400);assert.equal(queries.length,before);
  }
});

test('saved/shared builds resolve after numeric ID changes; search/detail include durable fields',async t=>{
  const {db,search,request}=await setup(t);const first=await(await search({limit:1})).json();const product=first.data[0];
  const detail=await(await request(`/v1/products/${product.id}`)).json();assert.equal(detail.source,product.source);assert.equal(detail.upstream_key,product.upstream_key);
  const saved=serializeBuild([product]);assert(!saved.includes('"id"'));const refs=parseBuild(saved);
  assert.deepEqual(referencesFromURL(buildURL('https://frontend.example/build',[product])),refs);
  // Rebuild simulation: fresh database import assigns this reference a new ID.
  const fresh=database();t.after(()=>fresh.sqlite.close());
  const row=(await db.query('SELECT * FROM products WHERE id=?',[product.id])).results[0];
  const columns=Object.keys(row);const q=`INSERT INTO products(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`;
  await fresh.query(q,columns.map(k=>k==='id'?9999:row[k]));
  const worker=createWorker({log(){}}),env={...fakeLimiters({unlimited:true}),DB:{prepare:sql=>({bind:(...params)=>({all:()=>fresh.query(sql,params)})})}};
  let calls=0;const restored=await restoreBuild('https://catalog.example',refs,(url,init)=>{calls++;return worker.fetch(new Request(url,init),env);});
  assert.equal(calls,1);assert.equal(restored[0].id,9999);assert.equal(restored[0].status,'active');assert.equal(restored[0].upstream_key,product.upstream_key);
});
