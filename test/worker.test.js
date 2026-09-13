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
import { searchCacheKey, searchCachePolicy } from '../src/search-cache.js';
import { fakeLimiters } from '../test-support/rate-limiter.js';

async function setup(t, options = {}) {
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
  Object.assign(env, fakeLimiters({ unlimited: true }), { CATALOG_CACHE_EPOCH: 'test-catalog', SEARCH_CACHE_TTL_SECONDS: '300' });
  const worker = createWorker({ log: e => logs.push(e), ...options });
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
    assert.equal(response.headers.get('cache-control'), 'no-store');
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
  const manyRows = { ...fakeLimiters({ unlimited: true }), DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: Array.from({ length: 51 }, () => ({})) }) }) }) } };
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
    const env = { ...fakeLimiters({ unlimited: true }), DB: { prepare: () => ({ bind: () => ({ all: async () => { throw new Error(message); } }) }) } };
    const response = await worker.fetch(new Request('https://catalog.example/v1/search?category=cpu&q=privatequery'), env);
    assert.equal(response.status, status);
    const text = await response.text();
    assert(!/SELECT|secret|stack|privatequery/.test(text + JSON.stringify(logs)));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('retry-after'), status === 503 ? '30' : null);
  }
  assert.equal((await worker.fetch(new Request('https://catalog.example/v1/health'), {})).status, 503);
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

function fakeCache(now = Date.now) {
  const entries = new Map();
  const calls = { match: 0, put: 0 };
  return { entries, calls,
    async match(key) {
      calls.match++;
      assert.equal(key.method, 'GET');
      assert.equal([...key.headers].length, 0);
      const item = entries.get(key.url);
      return item && now() < item.expires ? item.response.clone() : undefined;
    },
    async put(key, response) {
      calls.put++;
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-request-id'), null);
      assert.equal(response.headers.get('server-timing'), null);
      const ttl = Number(response.headers.get('cache-control').match(/max-age=(\d+)/)[1]);
      entries.set(key.url, { response: response.clone(), expires: now() + ttl * 1000 });
    },
  };
}

test('Canonical keys retain every result dimension, namespace, origin, epoch and TTL', () => {
  const policy = { ttl: 300, epoch: 'catalog-a' };
  const url = new URL('https://catalog.example/v1/search');
  const key = (input, p = policy, u = url) => searchCacheKey(u, { category: 'storage', keyword: '990pro', ...input }, p).url;
  assert.equal(key({}), key({ limit: 20, offset: 0, keyword: ' 990pro\t' }));
  for (const change of [{ category: 'cpu' }, { keyword: '990 pro' }, { keyword: '990  pro' }, { keyword: '990PRO' },
    { keyword: undefined }, { limit: 10 }, { offset: 20 }]) assert.notEqual(key({}), key(change));
  assert.notEqual(key({}), key({}, { ...policy, epoch: 'catalog-b' }));
  assert.notEqual(key({}), key({}, { ...policy, ttl: 60 }));
  assert.notEqual(key({}), key({}, policy, new URL('https://other.example')));
});

test('GET canonical variants HIT without DB calls and preserve exact response, attribution, CORS and fresh request IDs', async t => {
  const cache = fakeCache();
  const { request, statements, logs } = await setup(t, { cache });
  const variants = [
    'category=gpu&q=rtx%205080',
    'q=rtx+5080&offset=0&category=gpu&limit=20',
    'offset=000&limit=020&q=%20rtx%205080%20&category=gpu',
  ];
  let body;
  const ids = new Set();
  for (const [i, query] of variants.entries()) {
    const response = await request(`/v1/search?${query}`, { headers: { Origin: 'https://client.example',
      Range: 'bytes=0-5', 'If-None-Match': '*', Cookie: 'arbitrary=1', Authorization: 'Bearer synthetic' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-cache'), i ? 'HIT' : 'MISS');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.match(response.headers.get('access-control-expose-headers'), /X-Cache/);
    if (i) {
      assert.equal(response.headers.get('server-timing'), null);
      assert.equal(logs.at(-1).d1_queries, 0);
      assert.equal(logs.at(-1).rows_read, 0);
      assert.deepEqual(await response.json(), body);
    } else body = await response.json();
    ids.add(response.headers.get('x-request-id'));
  }
  assert.equal(ids.size, 3);
  assert.equal(statements.length, 1);
  assert.equal(cache.calls.put, 1);
  assert.equal(body.meta.source.license, 'ODC-By 1.0');
  assert.equal(body.meta.window_limit, 1000);
});

test('Cached pages preserve all pagination metadata and exact direct POST response equality', async t => {
  const cache = fakeCache();
  const { request, statements } = await setup(t, { cache });
  const allIds = [];
  for (const offset of [0, 20, 40, 60, 100]) {
    const path = `/v1/search?category=memory&q=ddr5&offset=${offset}`;
    const miss = await request(path);
    assert.equal(miss.headers.get('x-cache'), 'MISS');
    const body = await miss.json();
    allIds.push(...body.data.map(p => p.id));
    const calls = statements.length;
    const hit = await request(path);
    assert.equal(hit.headers.get('x-cache'), 'HIT');
    assert.deepEqual(await hit.json(), body);
    assert.equal(statements.length, calls);
    const direct = await request('/v1/search', post({ category: 'memory', keyword: 'ddr5', offset }));
    assert.equal(direct.headers.get('x-cache'), 'BYPASS');
    assert.deepEqual(await direct.json(), body);
  }
  assert.equal(new Set(allIds).size, 65);
  assert.equal(cache.entries.size, 5);
});

test('TTL 60/300/600 expiry and catalog epoch rotation refresh changed DB responses without a version query', async t => {
  let clock = 1_000_000;
  const cache = fakeCache(() => clock);
  const { request, env, statements } = await setup(t, { cache, now: () => clock });
  const path = '/v1/search?category=cpu&q=14900k';
  for (const ttl of [60, 300, 600]) {
    env.SEARCH_CACHE_TTL_SECONDS = String(ttl);
    assert.equal((await request(path)).headers.get('x-cache'), 'MISS');
    clock += ttl * 1000 - 1;
    const hit = await request(path);
    assert.equal(hit.headers.get('x-cache'), 'HIT');
    assert.equal(hit.headers.get('age'), String(ttl - 1));
    clock++;
    assert.equal((await request(path)).headers.get('x-cache'), 'MISS');
  }
  const previousCalls = statements.length;
  const oldBody = await (await request(path)).json();
  const prepare = env.DB.prepare;
  env.DB.prepare = sql => ({ bind: (...params) => ({ all: async () => {
    const result = await prepare(sql).bind(...params).all();
    return { ...result, results: result.results.map(row => ({ ...row, name: `${row.name} updated` })) };
  } }) });
  assert.deepEqual(await (await request(path)).json(), oldBody);
  env.CATALOG_CACHE_EPOCH = 'new-catalog';
  const refreshed = await request(path);
  assert.equal(refreshed.headers.get('x-cache'), 'MISS');
  assert.notDeepEqual(await refreshed.json(), oldBody);
  assert.equal(statements.length, previousCalls + 1);
  assert.equal((await request(path)).headers.get('x-cache'), 'HIT');
  assert(statements.every(({ sql }) => sql.startsWith('WITH search_input AS')));
});

test('Cache admission bounds pagination fanout without changing valid API limits', async t => {
  const cache = fakeCache();
  const { request, env } = await setup(t, { cache });
  for (const query of ['limit=1', 'limit=10', 'limit=50', 'offset=1', 'offset=101', 'offset=120', 'limit=50&offset=950']) {
    const response = await request(`/v1/search?category=memory&q=ddr5&${query}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-cache'), 'BYPASS');
  }
  assert.equal(cache.calls.match, 0);
  for (const value of ['0', 'oops', '3600']) {
    env.SEARCH_CACHE_TTL_SECONDS = value;
    assert.equal(searchCachePolicy(env, {}), null);
  }
  env.SEARCH_CACHE_TTL_SECONDS = '300';
  for (const value of [undefined, '', 'unsafe/epoch']) {
    env.CATALOG_CACHE_EPOCH = value;
    assert.equal((await request('/v1/search?category=memory&q=ddr5')).headers.get('x-cache'), 'BYPASS');
  }
  assert.equal(cache.calls.put, 0);
});

test('POST, health, categories, OPTIONS and every HTTP validation error bypass cache', async t => {
  const cache = fakeCache();
  const { request } = await setup(t, { cache });
  const cases = [
    ['/v1/search', post({ category: 'cpu', keyword: '14900k' }), 200],
    ['/v1/health', undefined, 200], ['/v1/categories', undefined, 200],
    ['/v1/search', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } }, 204],
    ['/v1/search?category=cpu&q=14900k&debug=true', undefined, 400],
    ['/v1/search?category=cpu&q=14900k&category=cpu', undefined, 400],
    ['/v1/search?category=cpu&q=+', undefined, 400],
    ['/unknown', undefined, 404], ['/v1/search', { method: 'HEAD' }, 405],
    ['/v1/search', post({ category: 'cpu', keyword: 'x'.repeat(17000) }), 413],
    ['/v1/search', { method: 'POST', body: '{}' }, 415],
  ];
  for (const [path, init, status] of cases) {
    const response = await request(path, init);
    assert.equal(response.status, status);
    assert.equal(response.headers.get('x-cache'), 'BYPASS');
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    if (path !== '/v1/categories') assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.deepEqual(cache.calls, { match: 0, put: 0 });
});

test('D1 errors are never stored; malformed/error cache entries cannot be returned as a HIT', async () => {
  for (const status of [400, 404, 405, 413, 415, 429, 500, 503]) {
    const cache = { match: async () => new Response('{}', { status }), put: () => assert.fail('No error may be stored') };
    const worker = createWorker({ cache, log() {} });
    const response = await worker.fetch(new Request('https://catalog.example/v1/search?category=cpu&q=14900k'), {
      ...fakeLimiters({ unlimited: true }),
      CATALOG_CACHE_EPOCH: 'test', DB: { prepare: () => ({ bind: () => ({ all: () => { throw new Error(status === 500 ? 'syntax' : 'timeout'); } }) }) },
    });
    assert.equal(response.status, status === 500 ? 500 : 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-cache'), 'BYPASS');
  }
});

test('Cache read/write failures fail open to the identical successful D1 response', async t => {
  for (const operation of ['match', 'put']) {
    const cache = fakeCache();
    cache[operation] = async () => { throw new Error('synthetic cache unavailable'); };
    const { request, logs } = await setup(t, { cache });
    const response = await request('/v1/search?category=cpu&q=14900k');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-cache'), 'BYPASS');
    assert.equal(logs.at(-1).cache_error, operation);
    assert.equal(logs.at(-1).d1_queries, 1);
    assert.deepEqual(await response.json(), await (await request('/v1/search', post({ category: 'cpu', keyword: '14900k' }))).json());
  }
});

test('Cache-key-only whitespace trimming preserves real search results including conflicting specs', async t => {
  const { request } = await setup(t);
  for (const [category, keyword] of [['cpu', '14900k'], ['cpu', 'ryzen 7'], ['storage', '990 pro 2tb'],
    ['memory', 'ddr5'], ['memory', 'ddr5 6000 cl30 32gb'], ['memory', '32gb 64gb'], ['gpu', 'gaming x trio 5080']]) {
    const direct = q => request('/v1/search', post({ category, keyword: q })).then(r => r.json());
    assert.deepEqual(await direct(keyword), await direct(` \t${keyword}\u3000`));
  }
});
