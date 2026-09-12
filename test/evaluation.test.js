import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { database } from '../test-support/database.js';
import { normalize } from '../src/normalize.js';
import { syncSnapshot } from '../src/sync.js';
import { loadQualityCatalog } from '../src/quality/catalog.js';
import { resolveExpected, benchmarkSearch } from '../src/quality/benchmark.js';
import { loadSearchFixture } from '../src/quality/fixtures.js';

test('expanded suites retain byte-identical legacy queries/expected and cover all categories', async () => {
  const input = readFileSync(new URL('./fixtures/search-benchmark.json',import.meta.url));
  assert.equal(createHash('sha256').update(input).digest('hex'),'3e2fec360c8051c375ec4091783b88dc09997da834c44979f05effaf86e64bc8');
  const {fixture,hash} = await loadSearchFixture();
  assert.equal(hash,'68d4f73da2ba143c06b5307cd84b97cb232db6489fbcee77b94e9974d925bfb7');
  assert.equal(fixture.length,120);
  assert.equal(new Set(fixture.map(r => r.id)).size,120);
  assert.equal(fixture.filter(r => r.suite === 'regression').length,40);
  assert.equal(fixture.filter(r => r.suite === 'holdout').length,28);
  for (const legacy of JSON.parse(input)) {
    const expanded = fixture.find(r => r.id === legacy.id);
    for (const [key,value] of Object.entries(legacy)) assert.deepEqual(expanded[key],value);
  }
  assert.equal(new Set(fixture.map(r => r.category)).size,9);
});

test('evaluation set predicates are typed, category-specific, ANDed and not legacy ambiguity overrides', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  const records = [32,64,null].map(capacity => normalize('memory',{
    opendb_id:randomUUID(),capacity,ram_type:'DDR5',speed:6000,
    metadata:{name:'Shared RAM',manufacturer:'Example',part_numbers:[]},
  },'a'.repeat(40)));
  await syncSnapshot(db,{commit:'a'.repeat(40),records});
  const catalog = await loadQualityCatalog(db);
  assert.equal(resolveExpected(catalog,'memory',{nameContains:['Shared']}).status,'EXPECTED_DATA_INVALID');
  const selector = {set:{fields:{'spec.capacity_gb':[32,64],'spec.ram_type':'ddr5'},nameTokens:['RAM']}};
  assert.equal(resolveExpected(catalog,'memory',selector).products.length,2);
  for (const expected of [{set:{}},{set:{fields:{'spec.capacity_gb':'32'}}},{set:{fields:{'spec.wattage':850}}},
    {set:{fields:{'spec.capacity_gb':null}}},{set:{nameTokens:['RAM OR']}}]) {
    assert.equal(resolveExpected(catalog,'memory',expected).status,'EXPECTED_DATA_INVALID');
  }
  await db.query('UPDATE products SET active=0 WHERE id=1');
  assert.equal(resolveExpected(await loadQualityCatalog(db),'memory',selector).products.length,1);
});

test('precision uses fixed K slots, suites/classes aggregate separately, invalid cases are excluded', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  const records = Array.from({length:6},(_,i) => normalize('memory',{
    opendb_id:randomUUID(),capacity:i < 2 ? 32 : 64,
    metadata:{name:'Common RAM',manufacturer:'Example',part_numbers:[]},
  },'a'.repeat(40)));
  await syncSnapshot(db,{commit:'a'.repeat(40),records});
  const catalog = await loadQualityCatalog(db);
  const expected = {set:{fields:{'spec.capacity_gb':32}}};
  const fixture = [
    {id:'dev',category:'memory',query:'common',class:'broad',suite:'development',expected,acceptable:expected},
    {id:'held',category:'memory',query:'missing',class:'spec_only',suite:'holdout',expected,acceptable:expected},
    {id:'bad',category:'memory',query:'common',class:'made_up',expected},
  ];
  const report = await benchmarkSearch(db,catalog,fixture);
  assert.equal(report.results[0].precision_at_5,2/5);
  assert.equal(report.results[0].precision_at_10,2/10);
  assert.equal(report.results[1].precision_at_5,0);
  assert.equal(report.summary.precision_at_5,1/5);
  assert.equal(report.summary.precision_query_count,2);
  assert.equal(report.by_suite.development.hit_at_1,1);
  assert.equal(report.by_class.spec_only.hit_at_1,0);
  assert.equal(report.new_suite.scored_query_count,2);
  assert.equal((await benchmarkSearch(db,catalog,fixture,{suite:'holdout'})).summary.query_count,1);
  assert.equal((await benchmarkSearch(db,catalog,fixture,{queryClass:'broad'})).summary.query_count,1);
  await assert.rejects(benchmarkSearch(db,catalog,fixture,{suite:'unknown'}),/Unknown suite/);
});
