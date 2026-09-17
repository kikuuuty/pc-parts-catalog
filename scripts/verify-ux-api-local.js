// Execute the real Worker fetch handler against persisted local D1. No remote
// credentials, mutation, deployment or public protection bypass are involved.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openDatabase } from '../src/database.js';
import { createWorker } from '../src/worker.js';
import { fakeLimiters } from '../test-support/rate-limiter.js';
import { loadQualityCatalog } from '../src/quality/catalog.js';
import { loadSnapshot } from '../src/upstream.js';
import { sourceCatalog,matchesFilters } from '../src/quality/ux.js';
import { buildURL,referencesFromURL,restoreBuild } from '../examples/shared-build.js';

const db=await openDatabase(false);
try {
  const snapshot=await loadSnapshot(),catalog=await loadQualityCatalog(db);
  assert.equal(snapshot.commit,catalog.metadata.last_sync.source_commit);
  const source=sourceCatalog(snapshot,catalog),events=[];
  const worker=createWorker({log:e=>events.push(e)});
  const env={DB:{prepare:sql=>({bind:(...params)=>({all:()=>db.query(sql,params)})})},...fakeLimiters({unlimited:true}),CATALOG_CACHE_EPOCH:'local-ux-api'};
  const fetcher=(url,init)=>worker.fetch(new Request(url,init),env);
  const input={category:'memory',filters:{ram_type:'DDR5',capacity_gb:32}};
  const search=async extra=>{
    const response=await fetcher('https://local.catalog/v1/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...input,...extra})});
    assert.equal(response.status,200);return response.json();
  };
  const first=await search({limit:17}),all=[...first.data];let cursor=first.meta.next_cursor,pages=1;
  assert(first.meta.has_more);assert.equal(first.meta.window_limit,null);
  const replay={cursor,limit:37};assert.deepEqual(await search(replay),await search(replay));
  while(cursor) {const page=await search({cursor,limit:37});all.push(...page.data);cursor=page.meta.next_cursor;pages++;}
  const expected=source.products.filter(p=>p.category===input.category&&matchesFilters(p,input)).map(p=>p.id).sort((a,b)=>a-b);
  assert.deepEqual(all.map(p=>p.id).sort((a,b)=>a-b),expected);assert.equal(new Set(all.map(p=>p.id)).size,expected.length);
  const selected=[...new Set(source.products.map(p=>p.category))].map(c=>source.products.find(p=>p.category===c));
  const refs=referencesFromURL(buildURL('https://frontend.example/build',selected));refs.push(refs[0],{source:'unknown',upstream_key:'CPU/missing'});
  const before=events.length,restored=await restoreBuild('https://local.catalog',refs,fetcher);
  assert.equal(events.length,before+1);assert.equal(events.at(-1).d1_queries,1);assert.equal(events.at(-1).cache_status,'BYPASS');
  assert.deepEqual(restored.map(p=>p.id),[...selected.map(p=>p.id),selected[0].id,null]);assert.equal(restored.at(-1).status,'missing');
  for(const p of restored.slice(0,-1)) {
    const response=await fetcher(`https://local.catalog/v1/products/${p.id}`),detail=await response.json();
    assert.equal(response.status,200);assert.equal(detail.source,p.source);assert.equal(detail.upstream_key,p.upstream_key);
  }
  const report={environment:'local D1 + real Worker fetch handler',snapshot:snapshot.commit,pagination:{pages,products:all.length,duplicates:0,missing:0,replay:'pass',page_sizes:[17,37]},shared_build:{references:refs.length,categories:selected.length,resolve_queries:1,detail_identity:'pass'},events};
  await writeFile('.cache/ux-api-local.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({...report,events:undefined},null,2));
} finally {await db.close();}
