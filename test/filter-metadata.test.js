import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { database } from '../test-support/database.js';
import { fakeLimiters } from '../test-support/rate-limiter.js';
import { categories, models } from '../src/model.js';
import { normalize } from '../src/normalize.js';
import { syncSnapshot } from '../src/sync.js';
import { createWorker } from '../src/worker.js';
import { filterRegistry, validateFilterRegistry } from '../src/filter-schema.js';
import { filterMetadataQueries, loadFilterMetadata, MAX_FILTER_OPTIONS } from '../src/filter-metadata.js';
import { hasCatalogFullScan, searchQuery } from '../src/queries.js';
import { verifyFilterMetadata, assertFilterContract, assertFilterSource } from '../scripts/lib/filter-verification.js';
import { verifyFilterCache, verifyFilterSmoke } from '../scripts/lib/filter-smoke.js';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

async function setup(t) {
  const db = database(); t.after(() => db.sqlite.close());
  const records = [];
  for (const category of categories) for (let n = 0; n < 3; n++) {
    const record = normalize(category, { opendb_id: randomUUID(), metadata: { name: `${category} ${n}`, manufacturer: ['AMD', 'Intel', 'Inactive'][n] } }, 'a'.repeat(40));
    for (const [id, type] of Object.entries(models[category].fields)) {
      const definition = filterRegistry[category].find(d => d.id === id);
      record.spec[id] = type === 'TEXT' ? `${id}-${['A', 'B', 'Inactive'][n]}` : definition?.optionLabels ? n : (n + 1) * 8;
    }
    if (category === 'cpu') record.spec.manufacturer = ['AMD', 'Intel', 'Inactive'][n];
    record.facets = models[category].facets.map(attribute => ({ attribute, value: ['Wired', 'Wireless', 'Inactive'][n] }));
    records.push(record);
  }
  await syncSnapshot(db, { commit: 'a'.repeat(40), records });
  db.sqlite.exec('UPDATE products SET active=0 WHERE id%3=0');
  const entries = new Map(), events = [], operations = [];
  let clock = 1000000;
  const cache = { async match(key) { return entries.get(key.url)?.clone(); }, async put(key, response) { entries.set(key.url, response.clone()); } };
  const worker = createWorker({ cache, now: () => clock, log: event => events.push(event) });
  const env = { ...fakeLimiters({ unlimited: true }), CATALOG_CACHE_EPOCH: 'filters-test', DB: {
    prepare: sql => ({ bind: (...params) => ({ sql, params, all: () => { operations.push([sql]); return db.query(sql, params); } }) }),
    async batch(statements) { operations.push(statements.map(s => s.sql)); return Promise.all(statements.map(s => db.query(s.sql, s.params))); },
  } };
  const request = (path, init) => worker.fetch(new Request(`https://catalog.example${path}`, init), env);
  const metadata = category => request(`/v1/categories/${category}/filters`);
  const search = input => request('/v1/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  return { db, env, cache, request, metadata, search, entries, events, operations, advance: n => clock += n,
    snapshot: { commit: 'a'.repeat(40), records: records.filter((_, i) => i % 3 !== 2) } };
}

test('all 30 filter endpoints expose usable typed selections/ranges/facets and active-only values', async t => {
  const h = await setup(t);
  assert.equal(categories.length, 30);
  for (const [index, category] of categories.entries()) {
    const response = await h.metadata(category);
    assert.equal(response.status, 200, category);
    const body = await response.json();
    assert.equal(body.category, category);
    assert.equal(body.filters.length, filterRegistry[category].length);
    assert.equal(h.events.at(-1).d1_operations, 1);
    assert(h.events.at(-1).d1_queries <= 2);
    assert.equal(body.filters[0].id, 'manufacturer');
    for (const f of body.filters) {
      const definition = filterRegistry[category].find(d => d.id === f.id);
      if (f.control === 'range') {
        assert.deepEqual(f.range, { min: 8, max: 16, step: definition.step });
        assert(Number.isFinite(f.range.min) && f.range.min <= f.range.max);
        const selected = await h.search({ category, ranges: { [f.id]: { min: f.range.max, max: f.range.max } } });
        assert.equal(selected.status, 200, `${category}.${f.id}`);
        assert.deepEqual((await selected.json()).data.map(p => p.id), [index * 3 + 2]);
      } else {
        assert.equal(f.options.length, 2, `${category}.${f.id}`);
        assert(!f.options.some(o => o.value == null || o.value === '' || String(o.value).includes('Inactive')));
        for (const option of f.options) {
          assert.equal(typeof option.value, f.value_type === 'string' ? 'string' : 'number');
          if (f.value_type === 'integer') assert(Number.isInteger(option.value));
          const selected = await h.search({ category, [f.target]: { [f.id]: [option.value] } });
          assert.equal(selected.status, 200, `${category}.${f.target}.${f.id}`);
          const rows = (await selected.json()).data;
          assert.equal(rows.length, 1, `${category}.${f.id}`);
          assert([index * 3 + 1, index * 3 + 2].includes(rows[0].id));
          if (f.target === 'facets') assert.equal((await h.db.query('SELECT value FROM product_facets WHERE product_id=? AND attribute=?', [rows[0].id, f.id])).results[0].value, option.value);
          else assert.equal(Object.hasOwn(models[category].fields, f.id) ? rows[0].specs[f.id] : rows[0][f.id], option.value);
        }
      }
    }
  }
});

test('curated core and peripheral filters, boolean labels, and model consistency', () => {
  validateFilterRegistry();
  for (const [category, ids] of Object.entries({ cpu: ['socket', 'core_count', 'tdp_w'], motherboard: ['socket', 'chipset', 'form_factor'],
    gpu: ['vram_gb', 'chip_series'], monitor: ['screen_size_inches', 'refresh_rate_hz', 'ports'], keyboard: ['switch_type', 'connectivity', 'features'],
    mouse: ['shape', 'weight_g', 'grip_types'], headphones: ['connection_types', 'platforms'], microphone: ['polar_pattern'], webcam: ['connectivity_type'] })) {
    for (const id of ids) assert(filterRegistry[category].some(d => d.id === id), `${category}.${id}`);
  }
  assert.deepEqual(filterRegistry.os.map(d => d.id), ['manufacturer']);
  assert(!filterRegistry.gpu.some(d => d.id === 'pcie_8_pin'));
  assert.deepEqual(filterRegistry.cpu_cooler.find(d => d.id === 'water_cooled').optionLabels, { 0: '空冷', 1: '水冷' });
  for (const mutate of [
    r => { r.cpu[0].id = 'manufactuer'; }, r => { r.cpu[0].id = 'name'; }, r => { r.cpu[0].target = 'facets'; },
    r => { r.cpu[0].control = 'range'; r.cpu[0].target = 'ranges'; r.cpu[0].step = 1; },
    r => { r.cpu.push(r.cpu[0]); }, r => { delete r.os; }, r => { r.cpu[1].id = 'socket); DROP TABLE products;--'; },
  ]) { const copy = structuredClone(filterRegistry); mutate(copy); assert.throws(() => validateFilterRegistry(copy)); }
  const empty = structuredClone(filterRegistry); empty.accessory = []; validateFilterRegistry(empty);
  for (const [category, definitions] of Object.entries(filterRegistry)) for (const d of definitions) {
    const value = d.target === 'ranges' ? { min: 1 } : d.target === 'facets' || (models[category].fields[d.id] ?? 'TEXT') === 'TEXT' ? 'value' : 1;
    assert.doesNotThrow(() => searchQuery(category, { [d.target]: { [d.id]: value } }));
  }
});

test('HTTP errors, SQL injection, query parameters, methods and CORS are consistent', async t => {
  const h = await setup(t);
  for (const category of ['not-a-category', '__proto__', 'constructor', 'cpu%27%3BDROP%20TABLE%20products']) assert.equal((await h.metadata(category)).status, 404);
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
    const response = await h.request('/v1/categories/cpu/filters', { method });
    assert.equal(response.status, 405); assert.equal(response.headers.get('Allow'), 'GET, OPTIONS');
  }
  for (const query of ['?socket=AM5', '?field=manufacturer', '?table=products', '?category=gpu', '?column=name', '?sql=SELECT']) {
    assert.equal((await h.request(`/v1/categories/cpu/filters${query}`)).status, 400);
  }
  const preflight = await h.request('/v1/categories/cpu/filters', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'GET' } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(preflight.headers.get('Access-Control-Allow-Methods'), 'GET, OPTIONS');
  assert.equal((await h.request('/v1/categories/cpu/filters', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST' } })).status, 400);
  assert.equal(h.operations.length, 0); assert.equal(h.entries.size, 0);
  const invalid = await h.search({ category: 'gpu', filters: { 'manufacturer) OR 1=1--': 'AMD' } });
  assert.equal(invalid.status, 400); assert.equal(h.operations.length, 0);
});

test('invalid/empty scalars and facets are excluded; empty active catalog keeps definitions', async t => {
  const h = await setup(t);
  h.db.sqlite.exec("UPDATE cpu SET socket='',core_count='invalid',tdp_w=1e999 WHERE product_id=1; UPDATE cpu SET socket=NULL,core_count=3.5,tdp_w=NULL WHERE product_id=2");
  const cpu = (await (await h.metadata('cpu')).json()).filters;
  assert.deepEqual(cpu.find(f => f.id === 'socket').options, []);
  assert.equal(cpu.find(f => f.id === 'core_count').range, null);
  assert.equal(cpu.find(f => f.id === 'tdp_w').range, null);
  h.db.sqlite.exec("UPDATE product_facets SET value='   ' WHERE value='Wired'; UPDATE product_facets SET value='' WHERE value='Wireless'");
  const keyboard = (await (await h.metadata('keyboard')).json()).filters;
  assert.deepEqual(keyboard.find(f => f.id === 'connectivity').options, []);
  h.db.sqlite.exec("UPDATE products SET active=0 WHERE category='monitor'");
  const monitor = (await (await h.metadata('monitor')).json()).filters;
  for (const f of monitor) f.control === 'range' ? assert.equal(f.range, null) : assert.deepEqual(f.options, []);
});

test('deterministic output, CPU manufacturer precedence, cache HIT/epoch/expiry and rate protection', async t => {
  const h = await setup(t);
  h.db.sqlite.exec("UPDATE products SET manufacturer='Other brand' WHERE category='cpu'");
  const first = await h.metadata('cpu'), body = await first.json();
  assert.equal(first.headers.get('X-Cache'), 'MISS');
  assert.equal(first.headers.get('Cache-Control'), 'public, max-age=0, must-revalidate');
  assert.deepEqual(body.filters[0].options.map(o => o.value), ['AMD', 'Intel']);
  assert.deepEqual([...h.entries.keys()], ['https://catalog.example/__catalog_cache/filters/v1/cpu?epoch=filters-test']);
  const count = h.env.D1_MISS_LIMITER.calls.length;
  const hit = await h.metadata('cpu'); assert.equal(hit.headers.get('X-Cache'), 'HIT');
  assert.equal(h.events.at(-1).d1_queries, 0); assert.equal(h.events.at(-1).d1_operations, 0);
  assert.equal(h.env.D1_MISS_LIMITER.calls.length, count); assert.deepEqual(await hit.json(), body);
  const direct = await loadFilterMetadata(qs => Promise.all(qs.map(async q => (await h.db.query(q.sql, q.params)).results)), 'cpu');
  assert.deepEqual(direct, body);
  h.db.sqlite.exec("UPDATE cpu SET socket='AM5' WHERE product_id=1");
  h.env.CATALOG_CACHE_EPOCH = 'next-release';
  const changed = await h.metadata('cpu'); assert.equal(changed.headers.get('X-Cache'), 'MISS');
  assert((await changed.json()).filters.find(f => f.id === 'socket').options.some(o => o.value === 'AM5'));
  h.advance(600001); assert.equal((await h.metadata('cpu')).headers.get('X-Cache'), 'MISS');
  h.env.BOOTSTRAP_MISS_LIMITER.limit = async () => ({ success: false });
  const denied = await h.metadata('gpu'); assert.equal(denied.status, 429);
  assert.equal(denied.headers.get('Cache-Control'), 'no-store'); assert.equal(h.events.at(-1).d1_queries, 0);
});

test('cache outages are fail-open, missing epoch bypasses, DB errors never cache', async t => {
  const h = await setup(t);
  h.cache.match = async () => { throw Error('cache offline'); };
  h.cache.put = async () => { throw Error('cache offline'); };
  assert.equal((await h.metadata('cpu')).status, 200);
  assert.equal(h.events.at(-1).cache_status, 'BYPASS');
  delete h.env.CATALOG_CACHE_EPOCH;
  assert.equal((await h.metadata('gpu')).headers.get('X-Cache'), 'BYPASS');
  h.env.DB.batch = async () => { throw Error('network timeout secret SQL'); };
  const error = await h.metadata('mouse'); assert.equal(error.status, 503);
  assert.equal(error.headers.get('Cache-Control'), 'no-store');
  assert(!(await error.text()).includes('secret SQL')); assert.equal(h.entries.size, 0);
});

test('option guard rejects entire metadata instead of silently truncating', async t => {
  const h = await setup(t);
  const keyboardId = categories.indexOf('keyboard') * 3 + 1;
  for (let n = 0; n <= MAX_FILTER_OPTIONS; n++) await h.db.query('INSERT INTO product_facets VALUES (?,?,?)', [keyboardId, 'connectivity', `Value ${n}`]);
  const response = await h.metadata('keyboard'); assert.equal(response.status, 500);
  assert.equal(h.entries.size, 0); assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('metadata plans bound every scalar/facet query by category and indexed PK probes', async t => {
  const h = await setup(t);
  for (const category of categories) for (const q of filterMetadataQueries(category)) {
    const plan = (await h.db.query(`EXPLAIN QUERY PLAN ${q.sql}`, q.params)).results.map(r => r.detail);
    assert(!hasCatalogFullScan(plan), plan.join('\n'));
    assert(!plan.some(d => /^SCAN f\b/.test(d)), plan.join('\n'));
    assert(plan.some(d => /SEARCH p USING .*products_category_manufacturer_series \(category=\?\)/.test(d)), plan.join('\n'));
    if (q.sql.includes('product_facets')) assert(plan.some(d => /SEARCH f USING .*\(product_id=\?\)/.test(d)), plan.join('\n'));
  }
});

test('all advertised fields support multi-selection and one-sided ranges with independent exact fixture sets', async t => {
  const h = await setup(t);
  for (const [index, category] of categories.entries()) {
    const body = await (await h.metadata(category)).json();
    for (const f of body.filters) {
      const inputs = f.control === 'range' ? [{ min: 8 }, { max: 16 }] : [f.options.map(o => o.value)];
      for (const value of inputs) {
        const response = await h.search({ category, [f.target]: { [f.id]: value } });
        assert.equal(response.status, 200);
        const ids = (await response.json()).data.map(p => p.id).sort((a, b) => a - b);
        assert.deepEqual(ids, [index * 3 + 1, index * 3 + 2], `${category}.${f.id}`);
      }
    }
  }
});

test('shared release Filter gate is source-grounded, bounded, read-only and retains caller lease', async t => {
  const h = await setup(t);
  h.db.sqlite.exec("INSERT INTO sync_lock VALUES (1,'release-owner',unixepoch()+60)");
  const report = await verifyFilterMetadata({ ...h.db, releaseOwner: 'release-owner' }, { snapshot: h.snapshot, measurement: 'node:sqlite fixture adapter (not D1 cost)' });
  assert(report.pass); assert.equal(report.categories.length, 30); assert.equal(report.rows_written, 0);
  assert.equal(report.sql_statements, 36); assert.equal(report.adapter_operations, 36);
  assert.equal(report.worker_binding_operations, null);
  assert.equal((await h.db.query('SELECT owner FROM sync_lock')).results[0].owner, 'release-owner');
  const body = await loadFilterMetadata(qs => Promise.all(qs.map(async q => (await h.db.query(q.sql, q.params)).results)), 'cpu');
  assertFilterContract(body, 'cpu'); assertFilterSource(body, h.snapshot.records.filter(r => r.product.category === 'cpu'));
  const corrupted = structuredClone(body); corrupted.filters.find(f => f.id === 'socket').options.pop();
  assert.throws(() => assertFilterSource(corrupted, h.snapshot.records.filter(r => r.product.category === 'cpu')), /Source options differ/);
  const boolean = structuredClone(body); boolean.filters.find(f => f.id === 'includes_cooler').options[0].value = '0';
  assert.throws(() => assertFilterContract(boolean, 'cpu'), /JSON type/);
});

test('empty metadata values and non-step-aligned/singleton range endpoints are valid', async t => {
  assert.doesNotThrow(() => assertFilterContract({ category: 'accessory', filters: [] }, 'accessory', []));
  const h = await setup(t);
  const body = await (await h.metadata('mouse')).json();
  body.filters.find(f => f.id === 'weight_g').range = { min: 8.03, max: 8.03, step: 0.1 };
  body.filters.find(f => f.id === 'max_dpi').range = null;
  body.filters.find(f => f.id === 'connectivity').options = [];
  assert.doesNotThrow(() => assertFilterContract(body, 'mouse'));
  const reversed = structuredClone(body); reversed.filters[0].options.reverse();
  assert.throws(() => assertFilterContract(reversed, 'mouse'), /deterministic/);
});

test('Filter gate saves option overflow details and rejects missing costs without treating them as zero', async t => {
  const h = await setup(t);
  await mkdir('.cache', { recursive: true }); const dir = await mkdtemp('.cache/filter-gate-test-');
  t.after(() => rm(dir, { recursive: true, force: true })); const output = path.join(dir, 'filter.json');
  const missing = { ...h.db, async query(sql, params) { const r = await h.db.query(sql, params); if (sql.includes('json_group_array')) delete r.meta.rows_read; return r; } };
  await assert.rejects(verifyFilterMetadata(missing, { snapshot: h.snapshot, output }), /Missing filter cost/);
  let report = JSON.parse(await readFile(output, 'utf8')); assert.equal(report.rows_read, null); assert.equal(report.pass, false);
  for (let i = 0; i <= MAX_FILTER_OPTIONS; i++) await h.db.query('INSERT INTO product_facets VALUES (?,?,?)', [categories.indexOf('keyboard') * 3 + 1, 'connectivity', `option-${i}`]);
  await assert.rejects(verifyFilterMetadata(h.db, { snapshot: h.snapshot, output }), /option limit/);
  report = JSON.parse(await readFile(output, 'utf8'));
  const failure = report.categories.find(c => c.category === 'keyboard').failure;
  assert.deepEqual(failure, { kind: 'option_limit', category: 'keyboard', field: 'connectivity', count: MAX_FILTER_OPTIONS + 3, limit: MAX_FILTER_OPTIONS });
});

test('production Filter cache accepts warm HIT, distinguishes POP changes, and fails inconclusive or same-POP MISS', async () => {
  const result = (cache, pop) => ({ body: { category: 'cpu', filters: [] }, response: new Response('{}', { headers: {
    'Cache-Control': 'public, max-age=0, must-revalidate', 'X-Cache': cache, 'X-Cache-TTL': '600', ...(cache === 'HIT' ? { Age: '1' } : {}), ...(pop ? { 'CF-Ray': `id-${pop}` } : {}),
  } }) });
  const warm = {}; await verifyFilterCache(async () => result('HIT', 'NRT'), result('HIT', 'NRT'), { report: warm }); assert.equal(warm.status, 'passed');
  const moved = {}; const queue = [result('MISS', 'SJC'), result('HIT', 'SJC')];
  await verifyFilterCache(async () => queue.shift(), result('MISS', 'NRT'), { report: moved }); assert.equal(moved.attempts.length, 2);
  const failed = {}; await assert.rejects(verifyFilterCache(async () => result('MISS', 'NRT'), result('HIT', 'NRT'), { report: failed }), /Same-POP/); assert.equal(failed.status, 'failed');
  const unknown = {}; await assert.rejects(verifyFilterCache(async () => result('HIT'), result('HIT'), { report: unknown }), /inconclusive/);
  assert.equal(unknown.status, 'inconclusive'); assert.equal(unknown.attempts.length, 3);
  let clock = 0; const nearExpiry = result('HIT', 'NRT'); nearExpiry.response.headers.set('Age', '598');
  const expiryReport = {}, expiryQueue = [result('MISS', 'NRT'), result('HIT', 'NRT')];
  await verifyFilterCache(async () => { clock += 4000; return expiryQueue.shift(); }, nearExpiry, { report: expiryReport, now: () => clock });
  assert.equal(expiryReport.status, 'passed'); assert.equal(expiryReport.attempts[0].reason, 'previous_entry_expired');
});

test('shared Filter HTTP smoke covers all categories, source-derived POST predicates and boundaries', async t => {
  const h = await setup(t);
  const request = async (url, init, expected = 200) => {
    const response = await h.request(url, init); assert.equal(response.status, expected);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
    return { response, body: expected === 204 ? null : await response.json() };
  };
  const report = await verifyFilterSmoke(request, h.snapshot, { local: true });
  assert.equal(report.status, 'passed'); assert.equal(report.categories.length, 30);
  assert.equal(report.searches.length, 8); assert(report.searches.every(s => s.status === 'passed'));
  assert.equal(report.boundaries, 'passed'); assert.equal(report.cache.status, 'passed');
});
