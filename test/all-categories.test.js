import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { database } from '../test-support/database.js';
import { models, initialCategories, ftsName } from '../src/model.js';
import { normalize } from '../src/normalize.js';
import { categoryCoverage, assertModelSchema } from '../src/upstream.js';
import { syncSnapshot } from '../src/sync.js';
import { searchQuery } from '../src/queries.js';
import { addLocalIdentifier, setLocalEnrichment } from '../src/enrichment.js';
import { extendedCases } from '../test-support/extended-cases.js';
import { createWorker } from '../src/worker.js';
import { fakeLimiters } from '../test-support/rate-limiter.js';
import { assertCategories, assertSearchContract } from '../scripts/lib/api-contract.js';

const commit = 'a'.repeat(40);
const extra = Object.keys(models).filter(c => !initialCategories.includes(c));
const source = (data = {}) => ({
  opendb_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  metadata: { name: 'Example Peripheral', manufacturer: 'Acme', series: 'Seriesword', variant: 'Variantword', part_numbers: ['PART-5678'] },
  identifiers: { version: 1, identifiers: ['mpn', 'upc', 'ean', 'gtin'].map((type, i) => ({ type, value: `001234567890${i}`, region: 'all' })), retailer_listings: [] },
  unmodeled: { keep: ['all', 'data'], zero: 0 }, ...data,
});
const search = async (db, category, options) => { const q = searchQuery(category, options); return (await db.query(q.sql, q.params)).results; };
const count = (db, table) => db.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;

test('category inventory compares the complete tree and schemas, including unknown/schema-only categories', () => {
  const upstream = Object.values(models).map(m => m.upstream);
  const covered = categoryCoverage(upstream, upstream);
  assert.equal(covered.upstream_count, 30); assert.equal(covered.supported_count, 30);
  assert.deepEqual(covered.unsupported, []);
  assert.deepEqual(categoryCoverage([...upstream, 'FuturePart'], upstream).unsupported, ['FuturePart']);
  assert.deepEqual(categoryCoverage(upstream, [...upstream, 'FuturePart']).missing_directories, ['FuturePart']);
  assert.deepEqual(categoryCoverage(upstream, upstream.filter(c => c !== 'Monitor')).missing_schemas, ['Monitor']);
  assert.deepEqual(categoryCoverage(upstream.filter(c => c !== 'Monitor'), upstream.filter(c => c !== 'Monitor')).missing_upstream, ['Monitor']);
  assert.throws(() => assertModelSchema(models.keyboard, { properties: {} }), /modeled field missing/);
  assert.throws(() => assertModelSchema(models.microphone, { properties: { connectivity_type: { type: 'string' } } }), /not an upstream array/);
});

test('forward migration preserves old rows, IDs, local data and FTS; new categories share UUIDs safely', async t => {
  const db = database({ through: '0006_fts_projection_consistency.sql' }); t.after(() => db.sqlite.close());
  const legacy = initialCategories.map(c => normalize(c, source(), commit));
  await syncSnapshot(db, { commit, records: legacy });
  await addLocalIdentifier(db, { productId: 1, type: 'jan', value: 'local-12345', evidence: 'test label' });
  await setLocalEnrichment(db, { productId: 1, namespace: 'test', key: 'preserved', value: { keep: true }, evidence: 'test' });
  const tables = ['products', ...initialCategories.map(c => models[c].table), 'upstream_raw', 'upstream_identifiers', 'product_facets', 'product_fts', 'local_identifiers', 'local_enrichments', 'local_identifier_fts'];
  const contents = () => tables.map(table => db.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const before = contents();
  db.sqlite.exec(readFileSync(new URL('../migrations/0007_all_categories.sql', import.meta.url), 'utf8'));
  assert.deepEqual(contents(), before);
  const snapshot = { commit, records: [...legacy, ...extra.map(c => normalize(c, source(), commit))] };
  const result = await syncSnapshot(db, snapshot);
  assert.equal(result.unchanged, 9); assert.equal(result.added, 21); assert.equal(result.updated, 0);
  assert.equal(count(db, 'products'), 30); assert.equal(count(db, 'product_fts'), 9); assert.equal(count(db, 'extended_product_fts'), 21);
  for (const category of extra) {
    assert.equal(count(db, models[category].table), 1);
    const row = (await search(db, category, {}))[0];
    assert.equal(row.upstream_key, `${models[category].upstream}/${source().opendb_id}`);
    assert.deepEqual(JSON.parse(db.sqlite.prepare('SELECT raw_json FROM upstream_raw WHERE product_id=?').get(row.id).raw_json), source());
  }
  const stable = contents();
  const extendedFTS = db.sqlite.prepare('SELECT * FROM extended_product_fts ORDER BY rowid').all();
  // Fail on ANY attempted write, not just differences in the resulting values.
  for (const table of tables.filter(name => !name.endsWith('_fts'))) for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
    db.sqlite.exec(`CREATE TRIGGER no_write_${table}_${event} BEFORE ${event} ON ${table} BEGIN SELECT RAISE(ABORT,'unexpected catalog rewrite'); END;`);
  }
  db.sqlite.exec("CREATE TRIGGER no_ingest BEFORE INSERT ON ingest BEGIN SELECT RAISE(ABORT,'unexpected FTS rewrite'); END;");
  const repeat = await syncSnapshot(db, snapshot);
  assert.equal(repeat.unchanged, 30); assert.equal(repeat.updated, 0);
  assert.deepEqual(contents(), stable);
  assert.deepEqual(db.sqlite.prepare('SELECT * FROM extended_product_fts ORDER BY rowid').all(), extendedFTS);
  assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
});

test('new-corpus documents and duplicate identifiers cannot perturb legacy relevance or identifier trust', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  const cpu = normalize('cpu', source({ metadata: { name: 'Intel Example CPU', part_numbers: ['MODEL-12345'] } }), commit);
  const snapshot = { commit, records: [cpu] };
  await syncSnapshot(db, snapshot);
  const before = await search(db, 'cpu', { keyword: 'MODEL-12345', debug: true });
  assert.equal(before[0].search_match, 'exact-identifier');
  snapshot.records.push(...extra.map(c => normalize(c, source({ metadata: { name: 'Intel Example CPU', part_numbers: ['MODEL-12345'] } }), commit)));
  await syncSnapshot(db, snapshot);
  assert.deepEqual(await search(db, 'cpu', { keyword: 'MODEL-12345', debug: true }), before);
});

test('new indexed range ordering starts with typed index before facet/product lookups', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  const record = normalize('keyboard', source(extendedCases.keyboard.data), commit);
  await syncSnapshot(db, { commit, records: [record] });
  const q = searchQuery('keyboard', { ranges: { polling_rate_hz: { min: 1000 } }, facets: { connectivity: 'Bluetooth' }, orderBy: 'polling_rate_hz' });
  const details = (await db.query(`EXPLAIN QUERY PLAN ${q.sql}`, q.params)).results.map(r => r.detail);
  assert(details.some(d => d.includes('keyboard_polling')));
  assert(!details.some(d => d.includes('TEMP B-TREE FOR ORDER BY')));
  assert.equal((await db.query(q.sql, q.params)).results.length, 1);
});

test('all new categories preserve local identifiers/enrichment across atomic failure, partial update and resume', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  const snapshot = { commit, records: extra.map(c => normalize(c, source(extendedCases[c]?.data), commit)) };
  await syncSnapshot(db, snapshot);
  for (const category of extra) {
    const row = (await search(db, category, {}))[0];
    await addLocalIdentifier(db, { productId: row.id, type: 'mpn', value: `LOCAL-${category}-1234`, evidence: 'synthetic label' });
    await setLocalEnrichment(db, { productId: row.id, namespace: 'test', key: 'local', value: { category }, evidence: 'synthetic' });
  }
  const local = () => ['local_identifiers', 'local_enrichments', 'local_identifier_fts'].map(table => db.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const before = local();
  const changed = { commit, records: extra.map(c => normalize(c, source({ ...extendedCases[c]?.data, metadata: { ...source().metadata, name: 'Changed Peripheral' } }), commit)) };
  const ftsRows = () => extra.map(c => db.sqlite.prepare(`SELECT rowid,* FROM ${ftsName(c)} ORDER BY rowid`).all());
  const ftsBefore = ftsRows();
  db.sqlite.exec("CREATE TRIGGER reject_monitor BEFORE INSERT ON monitor BEGIN SELECT RAISE(ABORT,'new spec rollback'); END;");
  await assert.rejects(syncSnapshot(db, changed), /new spec rollback/);
  assert.deepEqual(ftsRows(), ftsBefore);
  assert.deepEqual(local(), before);
  db.sqlite.exec('DROP TRIGGER reject_monitor');
  assert.equal((await syncSnapshot(db, changed, { maxProducts: 5 })).status, 'partial');
  const resumed = await syncSnapshot(db, changed);
  assert.equal(resumed.status, 'complete'); assert.equal(resumed.unchanged, 5);
  assert.deepEqual(local(), before);
  for (const category of extra) {
    const rows = await search(db, category, { keyword: `LOCAL-${category}-1234`, debug: true });
    assert.equal(rows.length, 1); assert.equal(rows[0].name, 'Changed Peripheral');
    assert.equal(rows[0].search_match, 'exact-identifier');
  }
});

for (const category of extra) test(`${category}: ingest, common/identifier/FTS, scalar/range/facet filters and HTTP contract`, async t => {
  const db = database(); t.after(() => db.sqlite.close());
  const fixture = extendedCases[category] ?? { data: {}, spec: {} };
  const record = normalize(category, source(fixture.data), commit);
  const unknown = normalize(category, { opendb_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', metadata: { name: 'Unknown 165Hz 32GB Bluetooth 4k', manufacturer: 'Other' } }, commit);
  assert.deepEqual(record.spec, fixture.spec);
  assert(Object.values(unknown.spec).every(v => v === null)); // No name-derived specifications.
  await syncSnapshot(db, { commit, records: [record, unknown] });
  for (const keyword of ['Example Peripheral', 'Acme', 'Seriesword', 'Variantword', 'PART-5678']) {
    assert.equal((await search(db, category, { keyword }))[0].upstream_key, record.product.upstream_key);
  }
  for (const key of ['manufacturer', 'series', 'variant']) assert.equal((await search(db, category, { filters: { [key]: record.product[key] } })).length, 1);
  for (const identifier of record.identifiers) {
    assert.equal((await search(db, category, { identifier: { type: identifier.type, value: identifier.value } }))[0].upstream_key, record.product.upstream_key);
    assert.equal((await search(db, category, { keyword: identifier.value }))[0].upstream_key, record.product.upstream_key);
  }
  for (const [field, value] of Object.entries(fixture.spec)) {
    assert.equal((await search(db, category, { filters: { [field]: value }, orderBy: field })).length, 1, field);
    if (typeof value === 'number') {
      assert.equal((await search(db, category, { ranges: { [field]: { min: value, max: value } }, orderBy: field })).length, 1, field);
      assert.equal((await search(db, category, { ranges: { [field]: { min: value + 1 } } })).length, 0, field);
    }
  }
  for (const facet of record.facets) {
    assert.equal((await search(db, category, { facets: { [facet.attribute]: facet.value } })).length, 1);
    assert.equal((await search(db, category, { filters: { manufacturer: 'Acme' }, facets: { [facet.attribute]: facet.value } })).length, 1);
    assert.equal((await search(db, category, { facets: { [facet.attribute]: 'not present' } })).length, 0);
  }
  if (category === 'monitor') assert.deepEqual(record.facets.map(f => f.value), ['hdmi_2_1', 'usb_c']);
  const logs = [];
  const worker = createWorker({ log: event => logs.push(event) });
  const env = { ...fakeLimiters({ unlimited: true }), DB: { prepare: sql => ({ bind: (...params) => ({ all: () => db.query(sql, params) }) }) } };
  const request = (path, input) => worker.fetch(new Request(`https://catalog.example${path}`, input === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  }), env);
  assertCategories(await (await request('/v1/categories')).json());
  const base = { category, keyword: 'Example Peripheral', limit: 1 };
  const ordinary = await (await request('/v1/search', base)).json();
  assertSearchContract(ordinary, base);
  assert.equal(logs.at(-1).d1_queries, 1);
  assert.deepEqual(ordinary.data[0].specs, fixture.spec);
  const expanded = await (await request('/v1/search', { ...base, include: ['identifiers', 'facets'] })).json();
  assertSearchContract(expanded, base);
  assert.equal(logs.at(-1).d1_queries, 2);
  assert.equal(expanded.data[0].identifiers.length, record.identifiers.length);
  assert(expanded.data[0].identifiers.every(i => i.origin === 'upstream'));
  const expectedFacets = {};
  for (const f of record.facets) (expectedFacets[f.attribute] ??= []).push(f.value);
  for (const values of Object.values(expectedFacets)) values.sort();
  assert.deepEqual(expanded.data[0].facets, expectedFacets);
  const { identifiers, facets, ...withoutExpansion } = expanded.data[0];
  assert.deepEqual(withoutExpansion, ordinary.data[0]);
  const numeric = Object.entries(fixture.spec).find(([, value]) => typeof value === 'number');
  const typedInput = { category, filters: { manufacturer: 'Acme' },
    ...(numeric ? { ranges: { [numeric[0]]: { min: numeric[1], max: numeric[1] } }, orderBy: numeric[0] } : {}),
    ...(record.facets.length ? { facets: { [record.facets[0].attribute]: record.facets[0].value } } : {}),
  };
  const typedResponse = await (await request('/v1/search', typedInput)).json();
  assertSearchContract(typedResponse, typedInput);
  assert.deepEqual(typedResponse.data.map(p => p.upstream_key), [record.product.upstream_key]);
  for (const include of [true, ['raw'], ['identifiers', 'identifiers'], 'identifiers']) assert.equal((await request('/v1/search', { ...base, include })).status, 400);
  const firstPage = await (await request(`/v1/search?category=${category}&limit=1`)).json();
  assertSearchContract(firstPage, { category, limit: 1 });
  assert.equal(firstPage.meta.next_offset, 1);
  const secondPage = await (await request(`/v1/search?category=${category}&limit=1&offset=1`)).json();
  assertSearchContract(secondPage, { category, limit: 1, offset: 1 });
  assert.notEqual(firstPage.data[0].id, secondPage.data[0].id);
  assert.equal(secondPage.meta.has_more, false);
});
