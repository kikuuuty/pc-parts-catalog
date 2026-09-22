import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { database } from '../test-support/database.js';
import { fakeLimiters } from '../test-support/rate-limiter.js';
import { categories, models } from '../src/model.js';
import { normalize } from '../src/normalize.js';
import { syncSnapshot } from '../src/sync.js';
import { createWorker } from '../src/worker.js';
import { filterRegistry } from '../src/filter-schema.js';
import { MAX_FILTER_OPTIONS, FilterOptionLimitError } from '../src/filter-metadata.js';
import { dynamicFacetQueries, loadDynamicFacets, excludeFacet } from '../src/dynamic-facets.js';
import { searchQuery, hasCatalogFullScan } from '../src/queries.js';

async function setup(t) {
  const db = database(); t.after(() => db.sqlite.close());
  const records = [];
  for (const category of categories) for (let n = 0; n < 4; n++) {
    const record = normalize(category, { opendb_id: randomUUID(), metadata: { name: `${category}-${n}`, manufacturer: ['Intel', 'Intel', 'AMD', 'Inactive'][n] } }, 'a'.repeat(40));
    for (const [id, type] of Object.entries(models[category].fields)) {
      const d = filterRegistry[category].find(d => d.id === id);
      record.spec[id] = type === 'TEXT' ? `${id}-${n}` : d?.optionLabels ? n % 2 : (n + 1) * 8;
    }
    if (category === 'cpu') Object.assign(record.spec, {
      manufacturer: record.product.manufacturer,
      family: ['Core i5', 'Core i7', 'Ryzen 7', 'Inactive'][n],
      socket: ['LGA1700', 'LGA1851', 'AM5', 'Inactive'][n],
    });
    record.facets = models[category].facets.flatMap(attribute => [
      { attribute, value: `value-${n}` }, { attribute, value: 'shared' },
    ]);
    records.push(record);
  }
  await syncSnapshot(db, { commit: 'a'.repeat(40), records });
  db.sqlite.exec('UPDATE products SET active=0 WHERE id%4=0');
  const events = [], operations = [];
  const env = { ...fakeLimiters({ unlimited: true }), CATALOG_CACHE_EPOCH: 'facets-test', DB: {
    prepare: sql => ({ bind: (...params) => ({ sql, params }) }),
    batch: qs => { operations.push(qs); return Promise.all(qs.map(q => db.query(q.sql, q.params))); },
  } };
  const worker = createWorker({ log: e => events.push(e), cache: {
    match() { assert.fail('Dynamic facets must bypass cache'); }, put() { assert.fail('Dynamic facets must bypass cache'); },
  } });
  const request = (path, init) => worker.fetch(new Request(`https://catalog.example${path}`, init), env);
  const post = (category, input = {}) => request(`/v1/categories/${category}/facets`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const load = async (category, input) => { const r = await post(category, input); assert.equal(r.status, 200, await r.clone().text()); return r.json(); };
  return { db, env, request, post, load, events, operations, records: records.filter((_, i) => i % 4 !== 3) };
}
const values = (body, field) => body.facets[field].options.map(o => o.value);

test('CPU empty, Intel, AMD, self-exclusion, impossible combination and counts', async t => {
  const h = await setup(t);
  const empty = await h.load('cpu');
  assert.deepEqual(values(empty, 'manufacturer'), ['AMD', 'Intel']);
  assert.deepEqual(values(empty, 'family'), ['Core i5', 'Core i7', 'Ryzen 7']);
  assert.deepEqual(values(empty, 'socket'), ['AM5', 'LGA1700', 'LGA1851']);
  assert.equal(h.events.at(-1).d1_queries, 1);
  const intel = await h.load('cpu', { filters: { manufacturer: ['Intel'] } });
  assert.deepEqual(values(intel, 'family'), ['Core i5', 'Core i7']);
  assert.deepEqual(values(intel, 'socket'), ['LGA1700', 'LGA1851']);
  assert.deepEqual(intel.facets.manufacturer.options, [{ value: 'AMD', label: 'AMD', count: 1 }, { value: 'Intel', label: 'Intel', count: 2 }]);
  assert.deepEqual(intel.facets.includes_cooler.options, [{ value: 0, label: 'なし', count: 1 }, { value: 1, label: 'あり', count: 1 }]);
  assert.equal(h.events.at(-1).d1_queries, 2);
  const amd = await h.load('cpu', { filters: { manufacturer: ['AMD'] } });
  assert.deepEqual(values(amd, 'family'), ['Ryzen 7']); assert.deepEqual(values(amd, 'socket'), ['AM5']);
  const scoped = await h.load('cpu', { filters: { manufacturer: ['Intel'], socket: ['LGA1700'] } });
  assert.deepEqual(values(scoped, 'socket'), ['LGA1700', 'LGA1851']);
  assert.deepEqual(values(scoped, 'family'), ['Core i5']);
  assert.deepEqual(scoped.facets.manufacturer.options, [{ value: 'Intel', label: 'Intel', count: 1 }]);
  assert.equal(h.events.at(-1).d1_queries, 3);
  const impossible = await h.load('cpu', { filters: { manufacturer: ['Intel'], socket: ['AM5'] } });
  assert.deepEqual(values(impossible, 'family'), []);
  assert.deepEqual(values(impossible, 'socket'), ['LGA1700', 'LGA1851']);
  assert.deepEqual(values(impossible, 'manufacturer'), ['AMD']);
  assert(!Object.hasOwn(empty.facets, 'core_count'));
  h.db.sqlite.exec("UPDATE products SET manufacturer='Different product brand' WHERE category='cpu'");
  assert.deepEqual(await h.load('cpu', { filters: { manufacturer: ['Intel'] } }), intel);
});

test('all categories: independent fixture oracle, exact search parity, ranges and multivalue counts', async t => {
  const h = await setup(t);
  for (const category of categories) {
    const definitions = filterRegistry[category].filter(d => d.control === 'multi_select');
    const range = filterRegistry[category].find(d => d.control === 'range');
    const facet = definitions.find(d => d.target === 'facets');
    const first = h.records.find(r => r.product.category === category);
    const allSelected = { filters: {}, facets: {} };
    for (const d of definitions) allSelected[d.target][d.id] = [d.target === 'facets' ? 'shared'
      : Object.hasOwn(models[category].fields, d.id) ? first.spec[d.id] : first.product[d.id]];
    const inputs = [{}, { filters: { manufacturer: ['Intel', 'AMD'] } },
      { filters: { manufacturer: ['Intel'], ...(definitions[1]?.target === 'filters' ? { [definitions[1].id]: [h.records.find(r => r.product.category === category).spec[definitions[1].id]] } : {}) },
        ...(range ? { ranges: { [range.id]: { min: 16, max: 24 } } } : {}),
        ...(facet ? { facets: { [facet.id]: ['shared', 'value-1'] } } : {}) }, allSelected];
    for (const input of inputs) {
      const body = await h.load(category, input);
      assert.deepEqual(Object.keys(body.facets), definitions.map(d => d.id));
      assert.equal(h.events.at(-1).d1_operations, 1);
      assert(h.events.at(-1).d1_queries <= definitions.length);
      for (const d of definitions) {
        const scope = excludeFacet(input, d.id);
        const scalar = (r, id) => Object.hasOwn(models[category].fields, id) ? r.spec[id] : r.product[id];
        const matches = h.records.filter(r => r.product.category === category
          && Object.entries(scope.filters).every(([id, v]) => v.includes(scalar(r, id)))
          && Object.entries(scope.ranges).every(([id, v]) => scalar(r, id) >= v.min && scalar(r, id) <= v.max)
          && Object.entries(scope.facets).every(([id, v]) => r.facets.some(f => f.attribute === id && v.includes(f.value))));
        const expected = new Map();
        for (const r of matches) for (const value of d.target === 'facets' ? r.facets.filter(f => f.attribute === d.id).map(f => f.value) : [scalar(r, d.id)]) expected.set(value, (expected.get(value) ?? 0) + 1);
        assert.deepEqual(body.facets[d.id].options, [...expected].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([value, count]) => ({ value, label: d.optionLabels?.[value] ?? String(value), count })), `${category}.${d.id}`);
        for (const option of body.facets[d.id].options) {
          const q = searchQuery(category, { ...scope, [d.target]: { ...scope[d.target], [d.id]: [option.value] }, limit: 100 });
          assert.equal((await h.db.query(q.sql, q.params)).results.length, option.count, `${category}.${d.id}`);
        }
      }
    }
  }
});

test('self-exclusion removes same ID across targets, while other ranges and legacy facets still restrict', async t => {
  const h = await setup(t);
  const b = await h.load('cpu', { filters: { manufacturer: ['Intel'], includes_cooler: [0] }, ranges: { includes_cooler: { max: 0 }, core_count: { min: 16 } } });
  assert.deepEqual(values(b, 'includes_cooler'), [1]);
  assert.deepEqual(values(b, 'family'), []);
  const legacy = await h.load('cpu', { filters: { manufacturer: ['Intel'], socket: ['LGA1700'] }, facets: { socket: ['value-0'] } });
  assert.deepEqual(values(legacy, 'socket'), ['LGA1700', 'LGA1851']);
  assert.deepEqual(values(legacy, 'family'), ['Core i5']);
  const range = await h.load('cpu', { ranges: { core_count: { min: 16 } }, facets: { memory_type: ['value-2'] } });
  assert.deepEqual(values(range, 'manufacturer'), ['AMD']);
});

test('invalid requests fail before D1, including excluded fields, complexity, body limits and CORS', async t => {
  const h = await setup(t);
  const invalid = [null, [], { keyword: 'Intel' }, { category: 'cpu' }, { limit: 10 }, { filters: null }, { ranges: [] },
    { filters: { manufacturer: [1] } }, { filters: { includes_cooler: ['1'] } }, { filters: { socket: [] } },
    { filters: { socket: Array(11).fill('a') } }, { filters: { socket: ['a'.repeat(201)] } },
    { filters: { 'socket) OR 1=1--': ['a'] } }, { facets: { bogus: ['a'] } }, { facets: { socket: [1] } },
    { ranges: { includes_cooler: { min: 1, max: 0 } } }, { ranges: { socket: { min: 0 } } },
    { ranges: { core_count: {} } }, { ranges: { core_count: { step: 1 } } },
    { filters: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`f${i}`, ['a']])) },
    { ranges: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`r${i}`, { min: 1 }])) },
    { facets: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`f${i}`, ['a']])) },
    { filters: Object.fromEntries(['manufacturer', 'family', 'socket', 'generation', 'microarchitecture'].map(id => [id, Array(10).fill('a')])) },
    { filters: { manufacturer: ['x'], family: ['x'], generation: ['x'], socket: ['x'], microarchitecture: ['x'], core_family: ['x'], name: ['x'], series: ['x'] },
      ranges: Object.fromEntries(['core_count', 'thread_count', 'tdp_w', 'ppt_w', 'max_memory_gb', 'performance_cores', 'efficiency_cores', 'includes_cooler'].map(id => [id, { min: 1 }])), facets: { socket: ['x'] } }];
  for (const input of invalid) assert.equal((await h.post('cpu', input)).status, 400, JSON.stringify(input));
  for (const category of ['bad', '__proto__', 'constructor']) assert.equal((await h.post(category)).status, 404);
  assert.equal((await h.post('cpu?bad=1')).status, 404);
  for (const method of ['GET', 'PUT', 'DELETE', 'HEAD']) assert.equal((await h.request('/v1/categories/cpu/facets', { method })).status, 405);
  const preflight = await h.request('/v1/categories/cpu/facets', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS');
  const raw = (body, headers = { 'Content-Type': 'application/json' }, suffix = '') => h.request(`/v1/categories/cpu/facets${suffix}`, { method: 'POST', headers, body });
  assert.equal((await raw('{}', undefined, '?x=1')).status, 400);
  assert.equal((await raw('{')).status, 400); assert.equal((await raw('{}', {})).status, 415);
  assert.equal((await raw(' '.repeat(16385))).status, 413);
  assert.equal((await raw('{}', { 'Content-Type': 'application/json', 'Content-Length': '20000' })).status, 413);
  assert.equal(h.operations.length, 0);
  assert.equal((await h.post('cpu', { filters: { socket: ["x' OR 1=1--"] } })).status, 200);
});

test('no-store, telemetry, protection, DB failure and explicit option overflow', async t => {
  const h = await setup(t);
  const response = await h.post('cpu');
  assert.equal(response.headers.get('Cache-Control'), 'no-store'); assert.equal(response.headers.get('X-Cache'), 'BYPASS');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(h.events.at(-1).route, '/v1/categories/:category/facets');
  assert.equal(h.events.at(-1).search_cost_class, 'uncached');
  h.env.EXPENSIVE_MISS_LIMITER.limit = async () => ({ success: false });
  assert.equal((await h.post('cpu')).status, 429); assert.equal(h.events.at(-1).d1_queries, 0);
  h.env.EXPENSIVE_MISS_LIMITER.limit = async () => { throw Error('offline'); };
  assert.equal((await h.post('cpu')).status, 503); assert.equal(h.events.at(-1).d1_queries, 0);
  Object.assign(h.env, fakeLimiters({ unlimited: true }));
  const batch = h.env.DB.batch;
  h.env.DB.batch = async () => { throw Error('network timeout secret SQL'); };
  const failed = await h.post('cpu'); assert.equal(failed.status, 503); assert(!(await failed.text()).includes('secret SQL'));
  h.env.DB.batch = batch;
  const id = categories.indexOf('keyboard') * 4 + 1;
  for (let i = 0; i <= MAX_FILTER_OPTIONS; i++) await h.db.query('INSERT INTO product_facets VALUES (?,?,?)', [id, 'connectivity', `extra-${i}`]);
  await assert.rejects(loadDynamicFacets(qs => Promise.all(qs.map(async q => (await h.db.query(q.sql, q.params)).results)), 'keyboard'), FilterOptionLimitError);
  const overflow = await h.post('keyboard'); assert.equal(overflow.status, 500);
  assert.equal((await overflow.json()).error.code, 'FILTER_OPTION_LIMIT');
});

test('empty/invalid values omitted, all-null and empty active catalog remain defined', async t => {
  const h = await setup(t);
  h.db.sqlite.exec("UPDATE cpu SET socket=NULL,includes_cooler=1.5; UPDATE cpu SET socket='   ' WHERE product_id=1; UPDATE cpu SET includes_cooler=1e999 WHERE product_id=2");
  const b = await h.load('cpu');
  assert.deepEqual(values(b, 'socket'), []); assert.deepEqual(values(b, 'includes_cooler'), []);
  await h.db.query('UPDATE cpu SET socket=? WHERE product_id=1', ['😀'.repeat(101)]);
  await h.db.query('UPDATE cpu SET socket=? WHERE product_id=2', ['\t\u3000']);
  assert.deepEqual(values(await h.load('cpu'), 'socket'), []);
  h.db.sqlite.exec("UPDATE product_facets SET value='' WHERE value='shared'; UPDATE products SET active=0 WHERE category='cpu'");
  const empty = await h.load('cpu'); assert(Object.values(empty.facets).every(f => f.options.length === 0));
  assert(!values(await h.load('keyboard'), 'connectivity').includes(''));
});

test('query plans: grouped category walks, typed indexes and facet PK/reverse index, no catalog scans or range aggregates', async t => {
  const h = await setup(t);
  for (const category of categories) for (const input of [{}, { filters: { manufacturer: ['Intel'] } }]) {
    const qs = dynamicFacetQueries(category, input);
    assert(qs.length <= (input.filters ? 2 : 1));
    for (const q of qs) {
      assert(!/\b(min|max)\(/i.test(q.sql));
      const plan = (await h.db.query(`EXPLAIN QUERY PLAN ${q.sql}`, q.params)).results.map(r => r.detail);
      assert(!hasCatalogFullScan(plan) && !plan.some(d => /^SCAN f\b/.test(d)), plan.join('\n'));
    }
  }
  for (const [category, input, index] of [
    ['cpu', { filters: { manufacturer: ['Intel'], socket: ['LGA1700'] } }, 'cpu_socket'],
    ['motherboard', { filters: { socket: ['socket-0'] } }, 'motherboard_socket_memory'],
    ['gpu', { filters: { chip_vendor: ['chip_vendor-0'] } }, 'gpu_vendor_vram'],
    ['keyboard', { facets: { connectivity: ['shared'] } }, 'facets_value'],
  ]) {
    const plans = await Promise.all(dynamicFacetQueries(category, input).map(async q => (await h.db.query(`EXPLAIN QUERY PLAN ${q.sql}`, q.params)).results.map(r => r.detail)));
    assert(plans.flat().some(d => d.includes(index)), plans.flat().join('\n'));
  }
});
