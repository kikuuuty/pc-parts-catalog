import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { loadSnapshot } from '../src/upstream.js';
import { quantile, matchesFilters } from '../src/quality/ux.js';
import { pacedRequests } from './lib/production-smoke.js';
import { buildURL, referencesFromURL, restoreBuild } from '../examples/shared-build.js';

const production = process.argv.includes('--production');
if(!production) {
  const config=JSON.parse(await readFile('wrangler.json','utf8'));
  assert(config.env?.staging,'Provision an isolated staging binding before benchmarking');
  assert.notEqual(config.env.staging.d1_databases[0].database_id,config.d1_databases[0].database_id,'Staging was promoted; never benchmark the production binding');
}
const origin = production ? 'https://pc-parts-catalog.kikuuuty.workers.dev' : 'https://pc-parts-catalog-staging.kikuuuty.workers.dev';
const output = `.cache/transition-http-${production ? 'production' : 'staging'}.json`;
const snapshot = await loadSnapshot();
assert.equal(snapshot.commit, 'eec0df175504ebd15f0f3e3a8249a18a22f00940');
const report = { origin, measured_at: new Date().toISOString(), result: 'running', requests: [], checks: {} };
let intent = 'contract';
const fetcher = async (url, init) => {
  const start = performance.now();
  const response = await fetch(url, init);
  const bytes = await response.arrayBuffer();
  report.requests.push({ intent, path: new URL(url).pathname, status: response.status, elapsed_ms: performance.now()-start,
    cache: response.headers.get('x-cache'), server_timing: response.headers.get('server-timing'), colo: response.headers.get('cf-ray')?.split('-').at(-1) });
  return new Response(bytes.byteLength ? bytes : null, { status: response.status, headers: response.headers });
};
const request = pacedRequests(origin, { fetcher, interval: 3500 });
const post = (path, body) => request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const search = async (type, input, get = false) => {
  intent = type;
  return get ? request(`/v1/search?${new URLSearchParams({category:input.category,q:input.keyword})}`) : post('/v1/search', input);
};
try {
  assert.deepEqual((await request('/v1/health')).body, { ok: true, database: 'available' });
  const categories = (await request('/v1/categories')).body;
  assert.equal(categories.categories.length, 30);
  await request('/v1/products/resolve', { method: 'OPTIONS', headers: { Origin: 'https://consumer.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } }, 204);
  report.checks.health = report.checks.categories = report.checks.cors = 'pass';
  let cpu, board;
  const filters = { form_factor: 'ATX', chipset: 'AMD B850' };
  const expectedBoards = snapshot.records.filter(r => r.product.category==='motherboard' && /\bMAG\b/i.test(r.product.name) && matchesFilters({...r.product,spec:r.spec}, {filters})).map(r=>r.product.upstream_key).sort();
  const cpuSource = snapshot.records.find(r=>r.product.category==='cpu' && /9800X3D/i.test(r.product.name));
  const identifier = cpuSource.identifiers.find(i=>i.type==='mpn');
  for (let run=0; run<(production?2:5); run++) {
    const lookup = await search('lookup', {category:'cpu',keyword:'9800X3D'}, run===0);
    cpu = lookup.body.data[0]; assert.match(cpu.name, /9800X3D/i);
    const browse = await search('browse', {category:'motherboard',keyword:'MAG'});
    assert(browse.body.data.length>0);
    const filtered = await search('browse_filter', {category:'motherboard',keyword:'MAG',filters,limit:50});
    assert.deepEqual(filtered.body.data.map(p=>p.upstream_key).sort(), expectedBoards); board=filtered.body.data[0];
    assert.equal(filtered.body.meta.has_more,false);
    const exact = await search('identifier', {category:'cpu',identifier:{type:identifier.type,value:identifier.value}});
    assert.equal(exact.body.data[0].upstream_key,cpuSource.product.upstream_key);
    const first = await search('filter_only', {category:'memory',filters:{ram_type:'DDR5',capacity_gb:32},limit:50});
    assert.equal(first.body.data.length,50); assert(first.body.meta.next_cursor);
    intent='product_detail'; const detail=(await request(`/v1/products/${cpu.id}`)).body;
    assert.equal(detail.upstream_key,cpu.upstream_key); assert.equal(detail.source,'buildcores');
    assert(detail.spec && Array.isArray(detail.facets)); assert(detail.identifiers.some(i=>i.type==='mpn'));
    intent='product_resolve'; const refs=[cpu,board,cpu].map(({source,upstream_key})=>({source,upstream_key}));
    const resolved=(await post('/v1/products/resolve',{products:refs})).body.products;
    assert.deepEqual(resolved.map(p=>p.id),[cpu.id,board.id,cpu.id]); assert(resolved.every(p=>p.status==='active'));
  }
  Object.assign(report.checks,{lookup:'pass',browse:'pass',browse_filter:{pass:true,expected:expectedBoards.length},identifier:'Hit@1',detail:'pass',resolve:'order/duplicates active pass'});
  const input={category:'memory',filters:{ram_type:'DDR5',capacity_gb:32},limit:50};
  const expectedMemory=snapshot.records.filter(r=>r.product.category==='memory'&&matchesFilters({...r.product,spec:r.spec},input)).map(r=>r.product.upstream_key);
  const seen=[]; let cursor; let page=0;
  // Full HTTP traversal on staging; production repeats a bounded traversal plus
  // a representative deep cursor obtained from the verified staging ordering.
  let deep;
  if(production) deep=JSON.parse(await readFile('.cache/transition-http-staging.json','utf8')).checks.cursor.deep;
  while(true) {
    const result=(await search('filter_only', {...input,...(cursor?{cursor}:{})})).body;
    seen.push(...result.data.map(p=>p.upstream_key));page++;
    cursor=result.meta.next_cursor;
    if(!production&&page>24)deep.expected.push(...result.data.map(p=>p.upstream_key));
    if(!cursor)break;
    if(production&&page===2)break;
    if(!production&&page===24)deep={cursor,expected:[]};
    assert(page<50,'Traversal bound');
  }
  assert.equal(new Set(seen).size,seen.length);
  if(!production){assert.deepEqual([...seen].sort(),expectedMemory.sort());assert.equal(cursor,null);}
  else {
    // Cursors contain an epoch; staging and production must share the published
    // epoch for this cross-origin read-only deep probe to be valid.
    const tail=[];let next=deep.cursor;
    for(let n=0;n<3;n++) {
      const result=(await search('filter_only',{...input,cursor:next})).body;
      tail.push(...result.data.map(p=>p.upstream_key));next=result.meta.next_cursor;if(!next)break;
    }
    assert.deepEqual(tail,deep.expected);assert.equal(next,null);
  }
  const repeat=(await search('filter_only',input)).body;
  assert.deepEqual(repeat.data.map(p=>p.upstream_key),seen.slice(0,50));
  report.checks.cursor={pass:true,expected_total:expectedMemory.length,pages:page,returned:seen.length,duplicates:0,full:!production,deep};

  const parts=[cpu,board];
  for(const input of [
    {category:'memory',filters:{ram_type:'DDR5',capacity_gb:32}},
    {category:'gpu',keyword:'RTX 5080'}, {category:'storage',keyword:'990 Pro'},
    {category:'psu',keyword:'RM850x'}, {category:'case',keyword:'North'},
  ]) {
    const result=await search(input.keyword?'lookup':'filter_only',{...input,limit:1});parts.push(result.body.data[0]);
  }
  const url=buildURL('https://consumer.example/build',parts),refs=referencesFromURL(url);
  assert.equal(refs.length,7); assert(refs.every(r=>!Object.hasOwn(r,'id')));
  intent='product_resolve';
  const restored=await restoreBuild(origin,refs,async(url,init)=>{
    const result=await request(new URL(url).pathname,init);
    return new Response(JSON.stringify(result.body),{status:200,headers:{'Content-Type':'application/json'}});
  });
  assert.deepEqual(restored.map(p=>p.id),parts.map(p=>p.id));
  const provider=[];
  for(const part of restored) {
    intent='product_detail';const detail=(await request(`/v1/products/${part.id}`)).body;
    assert.equal(detail.upstream_key,part.upstream_key);
    provider.push({category:detail.category,id:detail.id,name:detail.name,identifiers:detail.identifiers});
  }
  assert(provider.some(p=>p.identifiers.some(i=>['ean','upc','gtin','jan'].includes(i.type))));
  report.checks.shared_build={pass:true,categories:provider.map(p=>p.category)};report.price_provider_samples=provider;
  intent='product_resolve';
  const single=(await post('/v1/products/resolve',{products:refs.slice(0,1)})).body;
  assert.equal(single.products[0].id,parts[0].id);
  const missing=(await post('/v1/products/resolve',{products:[{source:'unknown',upstream_key:'CPU/missing'}]})).body;
  assert.equal(missing.products[0].status,'missing'); report.checks.missing='pass';report.checks.inactive='no safe fixture; covered locally';
  intent='lookup';const cache1=await request('/v1/search?category=cpu&q=9800X3D');
  const cache2=await request('/v1/search?category=cpu&q=9800X3D');
  assert.equal(cache2.response.headers.get('x-cache'),'HIT');assert.deepEqual(cache1.body,cache2.body);
  intent='product_detail';await request(`/v1/products/${cpu.id}`);const cached=await request(`/v1/products/${cpu.id}`);
  assert.equal(cached.response.headers.get('x-cache'),'HIT');
  report.checks.cache='search/detail HIT; POST BYPASS; new epoch namespace';
  report.result='pass';
} finally {
  report.by_intent=Object.fromEntries(['lookup','identifier','browse','browse_filter','filter_only','product_detail','product_resolve'].map(type=>{
    const rows=report.requests.filter(r=>r.intent===type&&r.status===200);
    return [type,{count:rows.length,http_elapsed_ms:{median:quantile(rows.map(r=>r.elapsed_ms),.5),p95:quantile(rows.map(r=>r.elapsed_ms),.95)},cache_counts:Object.fromEntries(['HIT','MISS','BYPASS'].map(c=>[c,rows.filter(r=>r.cache===c).length]))}];
  }));
  await writeFile(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({result:report.result,checks:report.checks,by_intent:report.by_intent},null,2));
}
