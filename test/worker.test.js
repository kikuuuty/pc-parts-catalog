import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { database } from '../test-support/database.js';
import { normalize } from '../src/normalize.js';
import { syncSnapshot } from '../src/sync.js';
import { searchQuery } from '../src/queries.js';
import { categories } from '../src/model.js';
import { createWorker } from '../src/worker.js';
import { remoteDatabaseId, remoteCredentials } from '../src/remote-config.js';

async function setup(t) {
  const db = database();
  t.after(() => db.sqlite.close());
  const commit = 'a'.repeat(40);
  const record = (category, name, data = {}) => normalize(category, {
    opendb_id: randomUUID(), metadata: { name, manufacturer: 'Example', part_numbers: [] }, ...data,
  }, commit);
  await syncSnapshot(db, { commit, records: [
    record('cpu', 'Example Core 14900KF'), record('cpu', 'Example Core 14900K'),
    record('cpu', 'AMD Ryzen 7 9800X3D'),
    record('storage', 'Samsung 990 PRO 1TB', { capacity: 1000 }),
    record('storage', 'Samsung 990 PRO 2TB', { capacity: 2000 }),
    record('gpu', 'Example RTX 5080', { chipset_manufacturer: 'NVIDIA', memory: 16 }),
    ...Array.from({ length: 65 }, (_, i) => record('memory', `DDR5 Example Kit ${i}`, { ram_type: 'DDR5', capacity: 32, speed: 6000 })),
  ] });
  const logs = [];
  const statements = [];
  const env = { DB: { prepare(sql) { return { bind(...params) { return { async all() {
    statements.push({ sql, params });
    // Enforce the runtime read-only contract in the integration adapter.
    assert.match(sql, /^(SELECT|WITH) /);
    return db.query(sql, params);
  } }; } }; } } };
  const worker = createWorker({ log: e => logs.push(e) });
  const request = (path, init) => worker.fetch(new Request(`https://catalog.example${path}`, init), env);
  return { db, logs, statements, worker, env, request };
}
const post = value => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });

test('Worker health/categories and GET models execute the shared searchQuery on a real migrated database', async t => {
  const { request, db, statements, logs } = await setup(t);
  assert.deepEqual(await (await request('/v1/health')).json(), { ok: true, database: 'available' });
  assert.deepEqual(await (await request('/v1/categories')).json(), { categories });
  for (const [category, keyword] of [['cpu', '14900k'], ['cpu', '9800x3d'], ['storage', '990pro'], ['gpu', 'rtx5080']]) {
    const response = await request(`/v1/search?${new URLSearchParams({ category, q: keyword })}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    const direct = searchQuery(category, { keyword, limit: 21 });
    assert.equal(statements.at(-1).sql, `${direct.sql} OFFSET ?`);
    assert.deepEqual(statements.at(-1).params, [...direct.params, 0]);
    assert.deepEqual(body.data.map(p => p.id), (await db.query(direct.sql, direct.params)).results.map(p => p.id));
    assert(body.data.length > 0);
    assert.equal(body.meta.source.license, 'ODC-By 1.0');
    assert(!/search_score|search_match|search_fts_relevance|content_hash|raw_json/.test(JSON.stringify(body)));
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.match(response.headers.get('cache-control'), /max-age=60/);
  }
  assert(!/14900k|9800x3d|SELECT|WITH/.test(JSON.stringify(logs)));
  assert(logs.every(e => e.status === 200));
});

test('POST advanced filters/ranges/facets/identifier/orderBy reuse validation and SQL binding', async t => {
  const { request } = await setup(t);
  const response = await request('/v1/search', post({ category: 'gpu', keyword: 'rtx 5080', filters: { chip_vendor: 'NVIDIA' }, ranges: { vram_gb: { min: 16 } }, limit: 20 }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data[0].specs.vram_gb, 16);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  for (const input of [
    { category: 'storage', keyword: '990 pro 2tb', ranges: { capacity_gb: { min: 2000, max: 2000 } } },
    { category: 'cpu_cooler', facets: { socket: ['AM5'] }, orderBy: 'height_mm' },
    { category: 'cpu', identifier: { type: 'jan', value: '0012345678901' } },
    { category: 'cpu', filters: { manufacturer: "'; DROP TABLE products; --" } },
  ]) assert.equal((await request('/v1/search', post(input))).status, 200);
  assert.equal((await request('/v1/health')).status, 200);
});

test('Pagination preserves ranking/ties, lookahead and the explicit 1000-result window', async t => {
  const { request, db } = await setup(t);
  const ids = [];
  for (const offset of [0, 20, 40, 60]) {
    const body = await (await request(`/v1/search?category=memory&q=ddr5&offset=${offset}`)).json();
    ids.push(...body.data.map(p => p.id));
    assert.equal(body.meta.has_more, offset < 60);
    assert.equal(body.meta.next_offset, offset < 60 ? offset + 20 : null);
  }
  const direct = searchQuery('memory', { keyword: 'ddr5', limit: 100 });
  assert.deepEqual(ids, (await db.query(direct.sql, direct.params)).results.map(p => p.id));
  assert.equal(new Set(ids).size, 65);
  assert.equal((await request('/v1/search?category=memory&limit=50&offset=950')).status, 200);
  assert.equal((await request('/v1/search?category=memory&limit=50&offset=951')).status, 400);
  const manyRows = { DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: Array.from({ length: 51 }, () => ({})) }) }) }) } };
  const boundary = await createWorker({ log() {} }).fetch(new Request('https://catalog.example/v1/search?category=memory&offset=950&limit=50'), manyRows);
  const { meta } = await boundary.json();
  assert.equal(meta.has_more, true);
  assert.equal(meta.next_offset, null);
  assert.equal(meta.window_exhausted, true);
});

test('Boundary rejects invalid types, unknown fields and excessive complexity before accessing D1', async t => {
  const { request, statements } = await setup(t);
  for (const query of ['', 'category=unknown', 'category=__proto__', 'category=cpu&limit=0', 'category=cpu&limit=51',
    'category=cpu&limit=1.1', 'category=cpu&limit=', 'category=cpu&offset=-1', 'category=cpu&debug=true',
    'category=cpu&category=gpu', 'category=cpu&q=', `category=cpu&q=${'a'.repeat(201)}`, `category=cpu&q=${'a+'.repeat(13)}`]) {
    assert.equal((await request(`/v1/search?${query}`)).status, 400, query);
  }
  for (const input of [null, [], 'cpu', {}, { category: 'cpu', limit: '20' }, { category: 'cpu', keyword: null },
    { category: 'cpu', filters: null }, { category: 'cpu', facets: [] }, { category: 'cpu', ranges: [] },
    { category: 'cpu', debug: true }, { category: 'cpu', filters: { bogus: 'x' } },
    { category: 'cpu', orderBy: 'id; DROP TABLE products' }, { category: 'cpu', orderBy: false },
    { category: 'cpu', identifier: false }, { category: 'cpu', identifier: { value: 'x', type: '' } },
    { category: 'cpu', identifier: { value: 'x', region: 'jp' } },
    { category: 'cpu', filters: { manufacturer: Array(11).fill('x') } },
    { category: 'cpu', filters: { manufacturer: [true] } },
    { category: 'cpu', ranges: { core_count: { min: '8' } } },
    { category: 'cpu', ranges: { core_count: { min: 8, max: 4 } } },
    { category: 'cpu', facets: { socket: 'x'.repeat(201) } },
    { category: 'cpu', ranges: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [i, { min: 1 }])) },
  ]) assert.equal((await request('/v1/search', post(input))).status, 400, JSON.stringify(input));
  assert.equal(statements.length, 0);
});

test('JSON streaming byte budget, encoding and Content-Type are enforced', async t => {
  const { request, statements } = await setup(t);
  assert.equal((await request('/v1/search', { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await request('/v1/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await request('/v1/search', post({ category: 'cpu', keyword: 'あ'.repeat(6000) }))).status, 413);
  assert.equal((await request('/v1/search', { ...post({ category: 'cpu' }), headers: { 'Content-Type': 'application/json', 'Content-Length': '16385' } })).status, 413);
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(9000)); controller.enqueue(new Uint8Array(9000)); controller.close(); } });
  assert.equal((await request('/v1/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: stream, duplex: 'half' })).status, 413);
  assert.equal(statements.length, 0);
});

test('Routing, methods, CORS preflight and error cache policy', async t => {
  const { request } = await setup(t);
  assert.equal((await request('/unknown')).status, 404);
  assert.equal((await request('/__proto__')).status, 404);
  assert.equal((await request('/v1/search', { method: 'DELETE' })).status, 405);
  assert.equal((await request('/v1/health', post({}))).headers.get('allow'), 'GET, OPTIONS');
  const preflight = await request('/v1/search', { method: 'OPTIONS', headers: { Origin: 'https://estimate.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
  assert.equal(preflight.status, 204);
  assert.equal(await preflight.text(), '');
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
  assert.match(preflight.headers.get('access-control-allow-methods'), /POST/);
  assert.equal((await request('/v1/health', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST' } })).status, 400);
  assert.equal((await request('/v1/search', { method: 'OPTIONS', headers: { 'Access-Control-Request-Headers': 'authorization' } })).status, 400);
  assert.equal((await request('/v1/search?category=bad')).headers.get('cache-control'), 'no-store');
});

test('D1 errors are classified without leaking SQL, stack, secrets or request inputs', async () => {
  const logs = [];
  const worker = createWorker({ log: e => logs.push(e) });
  for (const [message, status] of [['D1_ERROR: temporarily unavailable SELECT secret', 503], ['D1_ERROR: syntax error SELECT secret', 500]]) {
    const env = { DB: { prepare: () => ({ bind: () => ({ all: async () => { throw new Error(message); } }) }) } };
    const response = await worker.fetch(new Request('https://catalog.example/v1/search?category=cpu&q=privatequery'), env);
    assert.equal(response.status, status);
    const text = await response.text();
    assert(!/SELECT|secret|stack|privatequery/.test(text + JSON.stringify(logs)));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('retry-after'), status === 503 ? '30' : null);
  }
  assert.equal((await worker.fetch(new Request('https://catalog.example/v1/health'), {})).status, 500);
});

test('Remote configuration uses the real binding by default and preserves explicit CLI override', () => {
  const id = '12345678-1234-1234-1234-123456789abc';
  const other = 'abcdefab-1234-1234-1234-123456789abc';
  const config = { d1_databases: [{ binding: 'DB', database_name: 'pc-parts-catalog', database_id: id }] };
  assert.equal(remoteDatabaseId(config), id);
  assert.equal(remoteDatabaseId(config, other), other);
  assert.equal(config.d1_databases[0].database_id, id);
  assert.throws(() => remoteDatabaseId(config, '00000000-0000-0000-0000-000000000002'), /real remote/);
  assert.throws(() => remoteDatabaseId(config, '-'.repeat(36)), /real remote/);
  assert.throws(() => remoteDatabaseId({ d1_databases: [...config.d1_databases, ...config.d1_databases] }), /one DB binding/);
});

test('Management CLI credentials prefer API environment and support captured Wrangler OAuth', async () => {
  const account = 'a'.repeat(32);
  const override = 'b'.repeat(32);
  const config = { account_id: account };
  const oauth = async () => 'synthetic-oauth';
  assert.deepEqual(await remoteCredentials(config, {}, oauth), { account, token: 'synthetic-oauth' });
  assert.deepEqual(await remoteCredentials(config, { CLOUDFLARE_ACCOUNT_ID: override, CLOUDFLARE_API_TOKEN: 'synthetic-api' }, () => { throw new Error('must not call Wrangler'); }), { account: override, token: 'synthetic-api' });
  await assert.rejects(remoteCredentials({}, {}, oauth), /account_id/);
  await assert.rejects(remoteCredentials(config, {}, async () => null), /authentication required/);
});
