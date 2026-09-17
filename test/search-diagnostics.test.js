import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { database } from '../test-support/database.js';
import { normalize } from '../src/normalize.js';
import { syncSnapshot } from '../src/sync.js';
import { searchQuery } from '../src/queries.js';
import { createSearchDiagnostics } from '../scripts/lib/search-diagnostics.js';

async function setup(t) {
  const db=database();t.after(()=>db.sqlite.close());const commit='a'.repeat(40);
  await syncSnapshot(db,{commit,records:[
    normalize('cpu',{opendb_id:randomUUID(),metadata:{name:'Intel Core 14900K',manufacturer:'Intel',part_numbers:['CPU-14900K']}},commit),
    normalize('cpu',{opendb_id:randomUUID(),metadata:{name:'Intel Core 14900KF',manufacturer:'Intel'}},commit),
    ...Array.from({length:24},(_,i)=>normalize('memory',{opendb_id:randomUUID(),metadata:{name:`Memory Kit ${i}`,manufacturer:'Example'},capacity:i<22?32:64,ram_type:'DDR5'},commit)),
  ]});
  const calls=[];const handle=createSearchDiagnostics({db:{query:async(sql,params)=>{assert.match(sql,/^(SELECT|WITH|EXPLAIN)\b/);calls.push(sql);return db.query(sql,params);}}});
  return {db,calls,handle,search:input=>handle(new Request('http://127.0.0.1:8788/api/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}))};
}

test('local diagnostics uses actual API ordering and reports independent debug score/plan/cost',async t=>{
  const {db,search}=await setup(t);
  const response=await search({category:'cpu',keyword:'14900k'});assert.equal(response.status,200);
  const body=await response.json();const q=searchQuery('cpu',{keyword:'14900k'});
  assert.deepEqual(body.data.map(p=>p.id),(await db.query(q.sql,q.params)).results.map(p=>p.id));
  assert.equal(body.data[0].name,'Intel Core 14900K');assert.equal(body.diagnostics.query_count,1);
  assert(body.diagnostics.scores.every(r=>Number.isFinite(r.score)));
  assert(body.diagnostics.plan.some(p=>p.includes('cpu_fts')));assert.equal(body.diagnostics.catalog_full_scan,false);
});

test('optional typed filters and cursor next pages match the public search contract',async t=>{
  const {search,handle}=await setup(t);
  const input={category:'memory',filters:{capacity_gb:32}};
  const first=await(await search(input)).json();assert.equal(first.data.length,20);assert(first.meta.next_cursor);
  const next=await(await search({...input,cursor:first.meta.next_cursor})).json();assert.equal(next.data.length,2);assert.equal(next.meta.has_more,false);
  assert.equal(new Set([...first.data,...next.data].map(p=>p.id)).size,22);
  assert([...first.data,...next.data].every(p=>p.specs.capacity_gb===32));
  const found=await(await search({category:'cpu',keyword:'14900k'})).json();
  const detail=await(await handle(new Request(`http://127.0.0.1:8788/api/products/${found.data[0].id}`))).json();
  assert.equal(detail.identifiers[0].value,'CPU-14900K');
});

test('invalid diagnostics input and foreign origin never reach local SQL',async t=>{
  const {search,handle,calls}=await setup(t);
  for(const input of [{category:'invalid'},{category:'cpu',limit:500},{category:'memory',cursor:'bad'},{category:'memory',filters:{table:'products'}}])assert.equal((await search(input)).status,400);
  const response=await handle(new Request('http://127.0.0.1:8788/api/search',{method:'POST',headers:{origin:'https://foreign.example','Content-Type':'application/json'},body:'{}'}));
  assert.equal(response.status,403);assert.equal(calls.length,0);
  assert.equal((await handle(new Request('http://127.0.0.1:8788/api/search',{method:'POST',headers:{'Content-Type':'application/json'},body:'{'}))).status,400);
});

test('diagnostic landing page and category controls do not require a reviewer or fixture approvals',async t=>{
  const {handle,calls}=await setup(t);
  const page=await handle(new Request('http://127.0.0.1:8788/'));assert.equal(page.status,200);
  const text=await page.text();assert(text.includes('ローカル検索チェック'));assert(!text.includes('id="reviewer"'));assert(!text.includes('id="rationale"'));
  const registry=await(await handle(new Request('http://127.0.0.1:8788/api/categories'))).json();assert.equal(registry.categories.length,30);
  assert.equal(registry.categories.find(c=>c.category==='memory').fields.capacity_gb,'REAL');assert.equal(calls.length,0);
});
