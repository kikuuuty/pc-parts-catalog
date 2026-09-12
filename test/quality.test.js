import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { database } from '../test-support/database.js';
import { categories, models } from '../src/model.js';
import { normalize, identifierKey } from '../src/normalize.js';
import { searchQuery } from '../src/queries.js';
import { syncSnapshot } from '../src/sync.js';
import { addLocalIdentifier } from '../src/enrichment.js';
import { loadQualityCatalog, isMissing, nameKey, declaredIdentifierTypes, auditScope, assertCatalogState } from '../src/quality/catalog.js';
import { coverage, auditCompleteness, auditDuplicates } from '../src/quality/audit.js';
import { matchesExpected, resolveExpected, classifyFailure, benchmarkMetrics, benchmarkSearch } from '../src/quality/benchmark.js';
import { formatCompleteness, formatDuplicates, formatBenchmark } from '../src/quality/format.js';

const record = (category, name, overrides = {}) => normalize(category, {
  opendb_id: randomUUID(), ...overrides,
  metadata: { manufacturer: 'AMD', part_numbers: [], ...overrides.metadata, name },
}, 'a'.repeat(40));
const seed = (db, records) => syncSnapshot(db, { commit: 'a'.repeat(40), records });
const row = (db, sql, ...params) => db.sqlite.prepare(sql).get(...params);

test('coverage is count-based; zero denominator is null, not 100%', () => {
  assert.deepEqual(coverage(3,4), { total:4,present:3,missing:1,coverage:0.75,missing_rate:0.25 });
  assert.deepEqual(coverage(0,0), { total:0,present:0,missing:0,coverage:null,missing_rate:null });
  assert.throws(() => coverage(5,4), /Invalid/);
  assert.throws(() => coverage(-1,4), /Invalid/);
});

test('missing means null/undefined/empty/whitespace, not zero/false/None', () => {
  for (const v of [null,undefined,'',' \t\n','\u3000']) assert.equal(isMissing(v),true);
  for (const v of [0,false,'0','None','Unknown']) assert.equal(isMissing(v),false);
  assert.equal(nameKey(' ＧＰＵ  Alpha\tOC '),'gpu alpha oc');
  assert.notEqual(nameKey('AB-123'),nameKey('AB123'));
  assert.deepEqual(declaredIdentifierTypes("type TEXT CHECK(type IN ('mpn', 'jan'))"), ['mpn','jan']);
});

test('completeness derives model fields, distinct identifier ownership, scope denominators and absent spec rows', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  const records = [
    record('cpu','CPU A',{cores:{total:8,performance:0},specifications:{tdp:65,includesCooler:false},metadata:{releaseYear:2024,part_numbers:['A','A']},identifiers:{version:1,identifiers:[{type:'mpn',value:'A',region:'all'}],retailer_listings:[]}}),
    record('cpu','CPU B',{metadata:{manufacturer:' ',series:'  '}}),
    record('cpu','CPU C',{metadata:{manufacturer:'Intel',releaseYear:2018}}),
    record('gpu','GPU A',{length:300,metadata:{manufacturer:'MSI',releaseYear:2025}}),
  ];
  await seed(db,records);
  const b = row(db,'SELECT id FROM products WHERE name=?','CPU B').id;
  await db.query('UPDATE products SET name=? WHERE id=?',[' \t ',b]);
  await db.query('DELETE FROM cpu WHERE product_id=?',[b]);
  await db.query("UPDATE products SET active=0 WHERE name='CPU C'");
  db.sqlite.exec('PRAGMA query_only=ON');
  const catalog = await loadQualityCatalog(db);
  assert(catalog.identifierTypes.includes('jan'));
  assert(catalog.identifierTypes.includes('gtin'));
  assert.deepEqual((await loadQualityCatalog(db)).metadata.catalog_sha256,catalog.metadata.catalog_sha256);
  const report = auditCompleteness(catalog,{category:'cpu'});
  const cpu = report.categories[0];
  assert.equal(cpu.total_products,3);
  assert.equal(cpu.active_products,2);
  assert.equal(cpu.evaluated_products,2);
  assert.equal(cpu.missing_spec_rows,1);
  assert.equal(cpu.fields['product.manufacturer'].missing,1);
  assert.equal(cpu.fields['product.name'].missing,1);
  assert.equal(cpu.fields['spec.includes_cooler'].present,1);
  assert.equal(cpu.fields['spec.performance_cores'].present,1);
  assert.equal(cpu.identifiers.mpn.present,1); // three origins/entries do not multiply ownership
  assert.equal(cpu.identifiers.jan.present,0);
  assert.equal(Object.keys(cpu.fields).filter(k => k.startsWith('spec.')).length,Object.keys(models.cpu.fields).length);
  assert.equal(auditCompleteness(catalog).categories.length,categories.length);
  assert.equal(auditCompleteness(catalog,{category:'cpu',includeInactive:true}).categories[0].evaluated_products,3);
  assert.equal(auditCompleteness(catalog,{category:'cpu',yearFrom:2024,yearTo:2024}).categories[0].evaluated_products,1);
  assert.equal(auditCompleteness(catalog,{category:'cpu',unknownYear:true}).categories[0].evaluated_products,1);
  assert.equal(auditCompleteness(catalog,{category:'cpu',manufacturer:'amd'}).categories[0].evaluated_products,1);
  const grouped = auditCompleteness(catalog,{category:'cpu',field:'core_count',byManufacturer:true});
  assert.equal(grouped.categories[0].manufacturers.find(g => g.manufacturer_key === 'amd').fields['spec.core_count'].coverage,1);
  assert.equal(grouped.categories[0].manufacturers.find(g => g.manufacturer_key === 'intel').fields['spec.core_count'].coverage,null);
  assert.equal(auditCompleteness(catalog,{category:'memory'}).summary.identifiers.mpn.coverage,null);
  assert.throws(() => auditCompleteness(catalog,{category:'cpu',field:'length_mm'}),/Unknown field/);
  assert.match(formatCompleteness(grouped),/By manufacturer/);
  assert.deepEqual(JSON.parse(JSON.stringify(report)).summary,report.summary);
});

test('scope rejects bad categories, fields, and ambiguous year ranges', () => {
  assert.throws(() => auditScope({category:'__proto__'}),/Unknown category/);
  assert.throws(() => auditScope({yearFrom:2026,yearTo:2024}),/year-from/);
  assert.throws(() => auditScope({unknownYear:true,yearFrom:2024}),/unknown-year/);
  assert.throws(() => auditScope({yearFrom:NaN}),/Year/);
});

test('duplicates use manufacturer + normalized MPN, retain provenance and do not count same-product repeats', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  const records = [
    record('cpu','Alpha',{metadata:{part_numbers:['ab-001','ab-001']}}),
    record('cpu','Different name',{metadata:{manufacturer:'amd',part_numbers:[' AB-001 ']}}),
    record('cpu','Other vendor',{metadata:{manufacturer:'Intel',part_numbers:['AB-001']}}),
    record('gpu',' Ａlpha   GPU ',{metadata:{manufacturer:'MSI'}}),
    record('gpu','alpha gpu',{metadata:{manufacturer:'msi'}}),
    record('cpu','alpha gpu',{metadata:{manufacturer:'MSI'}}),
  ];
  await seed(db,records);
  const alpha = row(db,"SELECT id FROM products WHERE name='Alpha'").id;
  const other = row(db,"SELECT id FROM products WHERE name='Other vendor'").id;
  await addLocalIdentifier(db,{productId:alpha,type:'mpn',value:'AB-001',evidence:'test'});
  await addLocalIdentifier(db,{productId:alpha,type:'ean',value:'00123',evidence:'test'});
  await addLocalIdentifier(db,{productId:other,type:'ean',value:'00123',evidence:'test'});
  await db.query("UPDATE upstream_identifiers SET value_key='stale-key' WHERE product_id=?",[alpha]);
  db.sqlite.exec('PRAGMA query_only=ON');
  const catalog = await loadQualityCatalog(db);
  const report = auditDuplicates(catalog);
  assert.equal(report.summary.identifier_conflict_groups,2);
  assert.equal(report.summary.identifier_key_mismatch_rows,1);
  const mpn = report.identifier_conflicts.find(g => g.type === 'mpn');
  assert.equal(mpn.manufacturer_key,'amd');
  assert.equal(mpn.value_key,'AB-001');
  assert.equal(mpn.product_count,2);
  assert.equal(mpn.products.find(p => p.id === alpha).evidence.length,2);
  assert.equal(report.identifier_conflicts.find(g => g.type === 'ean').manufacturer_key,null);
  assert.equal(report.summary.possible_name_duplicate_groups,1);
  assert.equal(report.possible_name_duplicates[0].classification,'POSSIBLE_DUPLICATE_NAME');
  assert.equal(report.possible_name_duplicates[0].products_without_identifiers,2);
  assert.equal(auditDuplicates(catalog,{manufacturer:'Intel'}).summary.identifier_conflict_groups,0);
  assert.match(formatDuplicates(report),/not confirmed duplicates/);
});

test('expected selectors cover stable IDs, identifiers, MPN, names, missing and ambiguity', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  const a = record('cpu','Shared name',{metadata:{part_numbers:['mpn-a']}});
  const b = record('cpu','Shared name',{metadata:{part_numbers:['mpn-b']}});
  await seed(db,[a,b]);
  const catalog = await loadQualityCatalog(db);
  const p = catalog.products[0];
  for (const selector of [{upstream_id:p.upstream_id},{upstream_key:p.upstream_key},{mpn:' MPN-A '},{identifier:{type:'mpn',value:'MPN-A',region:'all'}}]) {
    assert.equal(resolveExpected(catalog,'cpu',selector).products[0].id,p.id);
    assert.equal(matchesExpected(p,selector),true);
  }
  assert.equal(resolveExpected(catalog,'cpu',{nameContains:['Shared']}).status,'EXPECTED_DATA_INVALID');
  assert.equal(resolveExpected(catalog,'cpu',{mpn:'not-in-db'}).status,'MISSING_PRODUCT');
  assert.equal(resolveExpected(catalog,'cpu',{nameContains:[]}).status,'EXPECTED_DATA_INVALID');
  assert.equal(resolveExpected(catalog,'cpu',{identifier:{type:'asin',value:'X'}}).status,'EXPECTED_DATA_INVALID');
  assert.equal(resolveExpected(catalog,'cpu',{upstream_id:p.upstream_id,mpn:'MPN-A'}).status,'EXPECTED_DATA_INVALID');
  assert.equal(resolveExpected(catalog,'cpu',{upstream_ids:[a.product.upstream_id,b.product.upstream_id]}).products.length,2);
  const any = resolveExpected(catalog,'cpu',{anyOf:[{upstream_id:p.upstream_id},{mpn:'missing'}]});
  assert.equal(any.status,null);
  assert.equal(any.missing.length,1);
  assert.equal(any.products.length,1);
  assert.equal(matchesExpected(p,{nameContains:['shared','NAME'],manufacturer:'amd'}),true);
  assert.equal(matchesExpected(p,{mpn:'MPN-A',manufacturer:'Intel'}),false);
});

test('Hit@K, full MRR and classification have explicit denominators', () => {
  const results = [1,5,10,11,null].map(rank => ({rank,status:classifyFailure({rank}),zero_results:rank === null}));
  results.push({rank:null,status:'EXPECTED_DATA_INVALID',zero_results:null});
  const metrics = benchmarkMetrics(results);
  assert.equal(metrics.query_count,6);
  assert.equal(metrics.scored_query_count,5);
  assert.equal(metrics.hit_at_1,1/5);
  assert.equal(metrics.hit_at_5,2/5);
  assert.equal(metrics.hit_at_10,3/5);
  assert.equal(metrics.mrr,(1+1/5+1/10+1/11)/5);
  assert.equal(metrics.zero_result_count,1);
  assert.equal(metrics.failed_query_count,3);
  assert.equal(classifyFailure({expectedStatus:'MISSING_PRODUCT',rank:null}),'MISSING_PRODUCT');
  assert.equal(benchmarkMetrics([]).mrr,null);
});

test('benchmark executes real searchQuery unchanged, finds rank >100, and distinguishes all failures', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  const records = Array.from({length:125},(_,i) => record('cpu',`Ranked CPU ${i+1}`));
  await seed(db,records);
  const catalog = await loadQualityCatalog(db);
  db.sqlite.exec('PRAGMA query_only=ON');
  const fixture = [
    {id:'first',category:'cpu',query:'ranked',expected:{upstream_id:records[0].product.upstream_id}},
    {id:'late',category:'cpu',query:'ranked',expected:{upstream_id:records[124].product.upstream_id}},
    {id:'none',category:'cpu',query:'absentword',expected:{upstream_id:records[0].product.upstream_id}},
    {id:'missing',category:'cpu',query:'ranked',expected:{upstream_id:randomUUID()}},
    {id:'ambiguous',category:'cpu',query:'ranked',expected:{nameContains:['Ranked']}},
  ];
  const calls = [];
  const observed = {query:async (sql,params) => { calls.push({sql,params}); return db.query(sql,params); }};
  const report = await benchmarkSearch(observed,catalog,fixture);
  const late = report.results[1];
  assert.equal(late.status,'RANKING_FAILURE');
  assert.equal(late.rank,125);
  assert.equal(late.executed_pages,2);
  assert.equal(report.results[2].status,'NO_SEARCH_MATCH');
  assert.equal(report.results[3].status,'MISSING_PRODUCT');
  assert.equal(report.results[4].status,'EXPECTED_DATA_INVALID');
  assert.equal(report.summary.scored_query_count,4);
  assert.equal(report.summary.hit_at_10,1/4);
  assert.equal(report.summary.mrr,(1+1/125)/4);
  assert.equal(report.summary.zero_result_count,1);
  const original = searchQuery('cpu',{keyword:'ranked',limit:100});
  assert.deepEqual(calls[0],original);
  assert(calls.some(q => q.sql === `${original.sql} OFFSET ?` && q.params.at(-1) === 100));
  assert.match(formatBenchmark(report),/rank: 125/);
  assert.match(formatBenchmark(report,{verbose:true}),/PASS first/);
  assert.deepEqual(JSON.parse(JSON.stringify(report)).summary,report.summary);
  const name = await benchmarkSearch(db,catalog,[{id:'name',category:'cpu',query:'ranked',expected:{nameContains:['Ranked CPU 125']}}]);
  assert.equal(name.results[0].rank,125);
});

test('benchmark exhausts matching pages before claiming NO_SEARCH_MATCH and respects typed filters', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  const target = record('cpu','Different target',{cores:{total:8}});
  const others = Array.from({length:101},(_,i) => record('cpu',`Common ${i}`,{cores:{total:4}}));
  await seed(db,[...others,target]);
  const catalog = await loadQualityCatalog(db);
  const report = await benchmarkSearch(db,catalog,[
    {id:'not-common',category:'cpu',query:'common',expected:{upstream_id:target.product.upstream_id}},
    {id:'filtered',category:'cpu',query:'target',search:{ranges:{core_count:{max:4}}},expected:{upstream_id:target.product.upstream_id}},
  ]);
  assert.equal(report.results[0].executed_pages,2);
  assert.equal(report.results[0].retrieved_count,101);
  assert.equal(report.results[0].search_exhausted,true);
  assert.equal(report.results[0].status,'NO_SEARCH_MATCH');
  assert.equal(report.results[1].status,'NO_SEARCH_MATCH');
  assert.equal(report.results[1].zero_results,true);
});

test('diagnostic pagination also supports a real query at the D1 100-parameter ceiling', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  const records = Array.from({length:101},(_,i) => record('cpu',`Ranked ${i}`,{series:'Ryzen 7 9000',socket:'AM5',metadata:{variant:'test'}}));
  await seed(db,records);
  const catalog = await loadQualityCatalog(db);
  const values = (value,n) => [value,...Array.from({length:n-1},(_,i) => `other-${i}`)];
  const search = {filters:{manufacturer:values('AMD',20),family:values('Ryzen 7',20),generation:values('9000',20),socket:values('AM5',20),variant:values('test',16)}};
  assert.equal(searchQuery('cpu',{...search,keyword:'ranked',limit:100}).params.length,100);
  const bounded = {query:async (sql,params = []) => { assert(params.length<=100); return db.query(sql,params); }};
  const report = await benchmarkSearch(bounded,catalog,[{id:'full-binds',category:'cpu',query:'ranked',search,expected:{upstream_id:records[100].product.upstream_id}}]);
  assert.equal(report.results[0].rank,101);
  assert.equal(report.results[0].status,'RANKING_FAILURE');
});

test('inactive expected products and missing typed rows are reported as data-related no-match', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  const a = record('cpu','Inactive');
  const b = record('cpu','No spec');
  await seed(db,[a,b]);
  await db.query("UPDATE products SET active=0 WHERE name='Inactive'");
  await db.query("DELETE FROM cpu WHERE product_id=(SELECT id FROM products WHERE name='No spec')");
  const catalog = await loadQualityCatalog(db);
  const report = await benchmarkSearch(db,catalog,[
    {id:'inactive',category:'cpu',query:'inactive',expected:{upstream_id:a.product.upstream_id}},
    {id:'spec',category:'cpu',query:'spec',expected:{upstream_id:b.product.upstream_id}},
  ]);
  assert.equal(report.results[0].reason,'INACTIVE_PRODUCT');
  assert.equal(report.results[1].reason,'MISSING_SPEC_ROW');
});

test('fixture errors are not silently scored, and DB failures propagate instead of becoming zero results', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  const a = record('cpu','Test CPU');
  await seed(db,[a]);
  const catalog = await loadQualityCatalog(db);
  const valid = {id:'same',category:'cpu',query:'test',expected:{upstream_id:a.product.upstream_id}};
  const report = await benchmarkSearch(db,catalog,[valid,valid,{...valid,id:'invalid-filter',search:{filters:{made_up:'value'}}}]);
  assert.equal(report.summary.failures.EXPECTED_DATA_INVALID,3);
  assert.equal(report.summary.mrr,null);
  await assert.rejects(benchmarkSearch(db,catalog,[]),/nonempty JSON array/);
  await assert.rejects(benchmarkSearch({query:async () => {throw new Error('DB unavailable');}},catalog,[valid]),/DB unavailable/);
  await db.query("UPDATE sync_runs SET status='partial'");
  await assert.rejects(assertCatalogState(db,catalog.metadata.last_sync),/changed during measurement/);
  await db.query("INSERT INTO sync_lock VALUES(1,'writer',unixepoch()+900)");
  await assert.rejects(loadQualityCatalog(db),/synchronized/);
  await assert.rejects(assertCatalogState(db,catalog.metadata.last_sync),/synchronized/);
});

test('tracked golden fixture has 30–50 valid cases and requires no network for structural validation', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  const catalog = await loadQualityCatalog(db);
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/search-benchmark.json',import.meta.url),'utf8'));
  assert(fixture.length >= 30 && fixture.length <= 50);
  const report = await benchmarkSearch(db,catalog,fixture);
  assert.equal(report.summary.failures.EXPECTED_DATA_INVALID,0);
  assert.equal(report.summary.failures.MISSING_PRODUCT,fixture.length);
  assert.equal(report.summary.zero_result_count,fixture.length);
});
