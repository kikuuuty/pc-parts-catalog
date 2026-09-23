import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { classifySearchCost, protectionBindings, yahooOfferBinding, validateProtectionConfig, createRefillGuard } from '../src/search-protection.js';
import { protectionWorker } from '../test-support/protection-worker.js';
import { categories } from '../src/model.js';
import { cursorContext, encodeCursor } from '../src/pagination.js';

const broad = { category: 'memory', keyword: 'ddr5' };
const calls = h => Object.fromEntries(protectionBindings.map(b => [b.name, h.env[b.name].calls.length]));
const facet = h => h.fetch('/v1/categories/cpu/facets', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
});
// Finite public bootstrap keyspace: no cache-busters or synthetic query keys.
const bootstrapPaths = categories.flatMap(category => [
  `/v1/categories/${category}/filters`, `/v1/search?category=${category}&limit=20`,
]);
const cpuBootstrapPaths = ['/v1/categories/cpu/filters', '/v1/search?category=cpu&limit=20'];

function noD1(h) {
  const event = h.logs.at(-1);
  assert.equal(event.d1_queries, 0);
  assert.equal(event.d1_operations, 0);
  assert.equal(event.rows_read, 0);
  assert.equal(event.rows_written, 0);
}

async function rateLimited(response) {
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-cache'), 'BYPASS');
  assert.equal(response.headers.get('retry-after'), '60');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.match(response.headers.get('access-control-expose-headers'), /Retry-After/);
  assert.deepEqual(await response.json(), {
    error: { code: 'RATE_LIMITED', message: 'Too many search requests' }, request_id: response.headers.get('x-request-id'),
  });
}

test('bootstrap admits 40 cold reads and rejects the 41st before D1/global tokens', async () => {
  const h = protectionWorker({ limits: { EXPENSIVE_MISS_LIMITER: 0, FACET_MISS_LIMITER: 0 } });
  for (const path of bootstrapPaths.slice(0, 40)) {
    assert.equal((await h.fetch(path)).status, 200, path);
    assert.equal(h.logs.at(-1).cache_status, 'MISS');
    assert.equal(h.logs.at(-1).search_cost_class, 'bootstrap');
    assert.equal(h.logs.at(-1).rate_limit_status, 'allowed');
    assert.equal(h.logs.at(-1).rate_limit_class, 'bootstrap_miss');
    assert(h.logs.at(-1).d1_queries > 0);
  }
  const statements = h.statements.length;
  await rateLimited(await h.fetch(bootstrapPaths[40]));
  assert.equal(h.logs.at(-1).rate_limit_status, 'denied');
  assert.equal(h.logs.at(-1).rate_limit_class, 'bootstrap_miss');
  noD1(h);
  assert.equal(h.statements.length, statements);
  assert.equal(h.writes, 40);
  assert.deepEqual(calls(h), { QUERY_REFILL_LIMITER: 41, D1_MISS_LIMITER: 40, EXPENSIVE_MISS_LIMITER: 0,
    HEALTH_LIMITER: 0, FACET_MISS_LIMITER: 0, BOOTSTRAP_MISS_LIMITER: 41 });
  assert.deepEqual([...new Set(h.env.BOOTSTRAP_MISS_LIMITER.calls)], ['bootstrap-miss']);
  h.advance(60_000);
  assert.equal((await h.fetch(bootstrapPaths[40])).status, 200);
});

test('20 Search + 20 Bootstrap + 20 Facet use independent budgets and stop at global 61st MISS', async () => {
  const h = protectionWorker();
  for (let i = 0; i < 20; i++) {
    assert.equal((await h.request({ ...broad, keyword: `ddr5${'!'.repeat(i + 1)}` })).status, 200);
    assert.equal(h.env.BOOTSTRAP_MISS_LIMITER.calls.length, i);
    assert.equal(h.env.FACET_MISS_LIMITER.calls.length, i);
    assert.equal((await h.fetch(bootstrapPaths[i])).status, 200);
    assert.equal(h.env.EXPENSIVE_MISS_LIMITER.calls.length, i + 1);
    assert.equal(h.env.FACET_MISS_LIMITER.calls.length, i);
    assert.equal((await facet(h)).status, 200);
    assert.equal(h.env.BOOTSTRAP_MISS_LIMITER.calls.length, i + 1);
    assert.equal(h.env.EXPENSIVE_MISS_LIMITER.calls.length, i + 1);
  }
  assert.deepEqual(calls(h), { QUERY_REFILL_LIMITER: 40, D1_MISS_LIMITER: 60, EXPENSIVE_MISS_LIMITER: 20,
    HEALTH_LIMITER: 0, FACET_MISS_LIMITER: 20, BOOTSTRAP_MISS_LIMITER: 20 });
  const statements = h.statements.length, writes = h.writes;
  await rateLimited(await h.fetch(bootstrapPaths[20]));
  assert.equal(h.logs.at(-1).rate_limit_class, 'd1_miss');
  assert.equal(h.logs.at(-1).rate_limit_status, 'denied');
  assert.equal(h.logs.at(-1).search_cost_class, 'bootstrap');
  noD1(h);
  assert.equal(h.statements.length, statements);
  assert.equal(h.writes, writes);
  assert.equal(h.env.BOOTSTRAP_MISS_LIMITER.calls.length, 21);
  assert.equal(h.env.D1_MISS_LIMITER.calls.length, 61);
  assert.deepEqual([...new Set(h.env.D1_MISS_LIMITER.calls)], ['search-d1-miss']);
});

test('a global D1 denial cannot refund the preceding bootstrap token', async () => {
  const h = protectionWorker();
  for (const path of bootstrapPaths.slice(0, 39)) assert.equal((await h.fetch(path)).status, 200);
  assert.equal((await h.request(broad, 'POST')).status, 200);
  for (let i = 0; i < 20; i++) assert.equal((await facet(h)).status, 200);
  await rateLimited(await h.fetch(bootstrapPaths[39]));
  assert.equal(h.logs.at(-1).rate_limit_class, 'd1_miss');
  noD1(h);
  assert.equal(h.env.BOOTSTRAP_MISS_LIMITER.calls.length, 40);
  assert.equal(h.env.D1_MISS_LIMITER.calls.length, 61);
  await rateLimited(await h.fetch(bootstrapPaths[40]));
  assert.equal(h.logs.at(-1).rate_limit_class, 'bootstrap_miss');
  noD1(h);
  assert.equal(h.env.BOOTSTRAP_MISS_LIMITER.calls.length, 41);
  assert.equal(h.env.D1_MISS_LIMITER.calls.length, 61);
});

test('both bootstrap routes preserve HIT without any limiter tokens or D1, even with missing bindings', async () => {
  for (const path of cpuBootstrapPaths) {
    const h = protectionWorker();
    const miss = await h.fetch(path);
    assert.equal(miss.status, 200);
    assert.equal(miss.headers.get('x-cache'), 'MISS');
    const previous = calls(h), statements = h.statements.length;
    for (const missing of [false, true]) {
      if (missing) for (const b of protectionBindings) delete h.env[b.name];
      const hit = await h.fetch(path);
      assert.equal(hit.status, 200);
      assert.equal(hit.headers.get('x-cache'), 'HIT');
      assert.deepEqual(await hit.json(), await miss.clone().json());
      assert.equal(h.logs.at(-1).rate_limit_status, 'not_checked');
      assert.equal(h.logs.at(-1).search_cost_class, 'not_classified');
      noD1(h);
      assert.equal(h.statements.length, statements);
      if (!missing) assert.deepEqual(calls(h), previous);
    }
  }
});

test('bootstrap refill denies the third cold canonical key before dedicated/global tokens', async () => {
  for (const paths of [[cpuBootstrapPaths[0], cpuBootstrapPaths[0], cpuBootstrapPaths[0]],
    ['/v1/search?category=cpu', '/v1/search?limit=20&category=cpu&offset=0', '/v1/search?offset=00&category=cpu&limit=020']]) {
    const h = protectionWorker();
    h.cache.match = async () => undefined;
    for (const path of paths.slice(0, 2)) assert.equal((await h.fetch(path)).status, 200);
    const denied = await h.fetch(paths[2]);
    assert.equal(denied.status, 429);
    assert.equal(denied.headers.get('retry-after'), '10');
    assert.equal(h.logs.at(-1).rate_limit_class, 'query_refill');
    noD1(h);
    assert.equal(h.env.BOOTSTRAP_MISS_LIMITER.calls.length, 2);
    assert.equal(h.env.D1_MISS_LIMITER.calls.length, 2);
    assert.equal(new Set(h.env.QUERY_REFILL_LIMITER.calls).size, 1);
    assert.match(h.env.QUERY_REFILL_LIMITER.calls[0], /^[a-f0-9]{64}$/);
    h.advance(10_000);
    assert.equal((await h.fetch(paths[0])).status, 200);
  }
});

test('bootstrap in-flight guard bounds parallel cold reads and releases after failures', { timeout: 5000 }, async () => {
  for (const path of cpuBootstrapPaths) {
    let release;
    const h = protectionWorker({ unlimited: true, blockedDB: new Promise(resolve => { release = resolve; }) });
    const work = Array.from({ length: 6 }, () => h.fetch(path));
    while (h.logs.length < 4 || h.statements.length < 2) await new Promise(resolve => setTimeout(resolve, 1));
    assert(h.logs.every(e => e.status === 429 && e.rate_limit_class === 'query_inflight' && e.d1_queries === 0));
    assert.equal(h.env.QUERY_REFILL_LIMITER.calls.length, 2);
    assert.equal(h.env.BOOTSTRAP_MISS_LIMITER.calls.length, 2);
    assert.equal(h.env.D1_MISS_LIMITER.calls.length, 2);
    release();
    assert.equal((await Promise.all(work)).filter(r => r.status === 200).length, 2);
    assert.equal((await h.fetch(path)).headers.get('x-cache'), 'HIT');
    const broken = protectionWorker({ unlimited: true });
    broken.env.DB.prepare = () => { throw new Error('failure'); };
    for (let i = 0; i < 4; i++) assert.equal((await broken.fetch(path)).status, 500);
  }
});

test('all bootstrap tiers fail closed, preserve denial ordering and release the guard', async () => {
  for (const path of cpuBootstrapPaths) for (const [name, tier] of [
    ['QUERY_REFILL_LIMITER', 'query_refill'], ['BOOTSTRAP_MISS_LIMITER', 'bootstrap_miss'], ['D1_MISS_LIMITER', 'd1_miss'],
  ]) for (const failure of [undefined, { limit() { throw new Error('secret'); } }, { limit: async () => ({ success: 'yes' }) }]) {
    const h = protectionWorker({ unlimited: true });
    const binding = h.env[name]; h.env[name] = failure;
    const response = await h.fetch(path);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).error.code, 'PROTECTION_UNAVAILABLE');
    assert.equal(h.logs.at(-1).rate_limit_status, 'unavailable');
    assert.equal(h.logs.at(-1).rate_limit_class, tier);
    noD1(h);
    assert.equal(h.statements.length, 0);
    assert.equal(h.writes, 0);
    if (name !== 'D1_MISS_LIMITER') assert.equal(h.env.D1_MISS_LIMITER.calls.length, 0);
    if (name === 'QUERY_REFILL_LIMITER') assert.equal(h.env.BOOTSTRAP_MISS_LIMITER.calls.length, 0);
    h.env[name] = binding;
    assert.equal((await h.fetch(path)).status, 200);
  }
});

test('both bootstrap routes preserve the dedicated and global 429 contract', async () => {
  for (const path of cpuBootstrapPaths) for (const [name, tier] of [
    ['BOOTSTRAP_MISS_LIMITER', 'bootstrap_miss'], ['D1_MISS_LIMITER', 'd1_miss'],
  ]) {
    const h = protectionWorker({ limits: { [name]: 0 } });
    await rateLimited(await h.fetch(path));
    assert.equal(h.logs.at(-1).rate_limit_class, tier);
    noD1(h);
    assert.equal(h.statements.length, 0);
    assert.equal(h.writes, 0);
    assert.equal(h.env.D1_MISS_LIMITER.calls.length, name === 'D1_MISS_LIMITER' ? 1 : 0);
  }
});

test('only canonical first-page listings classify as bootstrap, not arbitrary cacheable GET', async () => {
  for (const category of categories) for (const page of [{}, { limit: 20 }, { offset: 0 }, { limit: 20, offset: 0 }]) {
    assert.equal(classifySearchCost(Object.freeze({ category, ...page })), 'bootstrap');
  }
  for (const extra of [{ keyword: 'ryzen' }, { cursor: 'cursor' }, { offset: 20 }, { limit: 10 }, { limit: 50 },
    { filters: { manufacturer: 'Intel' } }, { ranges: { core_count: { min: 8 } } }, { facets: {} }, { identifier: { value: '14900k' } },
    { orderBy: 'name' }, { include: [] }, { futureCondition: 'value' }]) {
    assert.notEqual(classifySearchCost({ category: 'cpu', ...extra }, { cacheEligible: true }), 'bootstrap');
  }
  assert.notEqual(classifySearchCost({}), 'bootstrap');
  assert.notEqual(classifySearchCost({ category: 'not-a-category' }), 'bootstrap');
  assert.equal(classifySearchCost({ category: 'cpu' }, { method: 'POST' }), 'uncached');
  assert.equal(classifySearchCost({ category: 'cpu' }, { cacheEligible: false }), 'uncached');
  const cursor = await encodeCursor(await cursorContext({ category: 'cpu' }, 'test'), ['Intel', 0, 'Core', 'CPU', 1]);
  for (const [input, method, expected] of [
    [{ category: 'cpu' }, 'GET', 'bootstrap'], [{ category: 'cpu', limit: 20 }, 'GET', 'bootstrap'],
    [{ category: 'cpu', limit: 20, offset: 0 }, 'GET', 'bootstrap'],
    [{ category: 'cpu', keyword: 'ryzen' }, 'GET', 'expensive'],
    [{ category: 'memory', keyword: 'corsair' }, 'GET', 'expensive'],
    [{ category: 'cpu', keyword: '14900k' }, 'GET', 'normal'],
    [{ category: 'cpu' }, 'POST', 'uncached'],
    [{ category: 'cpu', filters: { manufacturer: ['Intel'] } }, 'POST', 'uncached'],
    [{ category: 'cpu', cursor }, 'GET', 'uncached'],
    [{ category: 'cpu', limit: 10 }, 'GET', 'uncached'],
    [{ category: 'cpu', keyword: 'ryzen', offset: 20 }, 'GET', 'expensive'],
  ]) {
    const h = protectionWorker();
    assert.equal((await h.request(input, method)).status, 200);
    assert.equal(h.logs.at(-1).search_cost_class, expected);
    assert.equal(h.env.BOOTSTRAP_MISS_LIMITER.calls.length, expected === 'bootstrap' ? 1 : 0);
    assert.equal(h.env.EXPENSIVE_MISS_LIMITER.calls.length, ['uncached', 'expensive'].includes(expected) ? 1 : 0);
  }
});

test('cache outages and ineligible bootstrap reads retain uncached expensive protection', async () => {
  for (const path of cpuBootstrapPaths) for (const failure of ['match', 'epoch']) {
    const h = protectionWorker({ cacheFailure: failure, limits: { EXPENSIVE_MISS_LIMITER: 0 } });
    if (failure === 'epoch') delete h.env.CATALOG_CACHE_EPOCH;
    await rateLimited(await h.fetch(path));
    assert.equal(h.logs.at(-1).search_cost_class, 'uncached');
    assert.equal(h.logs.at(-1).rate_limit_class, 'expensive_miss');
    assert.equal(h.env.BOOTSTRAP_MISS_LIMITER.calls.length, 0);
    noD1(h);
  }
  const h = protectionWorker({ limits: { EXPENSIVE_MISS_LIMITER: 0 } });
  h.env.SEARCH_CACHE_TTL_SECONDS = '0';
  await rateLimited(await h.request({ category: 'cpu' }));
  assert.equal(h.env.BOOTSTRAP_MISS_LIMITER.calls.length, 0);
});

test('bootstrap validation rejects unbounded or noncanonical input before any tokens or D1', async () => {
  const h = protectionWorker();
  const previous = calls(h);
  for (const path of ['/v1/categories/unknown/filters', '/v1/categories/cpu/filters?q=anything',
    '/v1/search?category=cpu&offset=20', '/v1/search?category=cpu&filters={}', '/v1/search?category=cpu&orderBy=name',
    '/v1/search?category=cpu&q=', '/v1/search?category=cpu&cursor=invalid', '/v1/search?category=cpu&category=gpu']) {
    assert([400, 404].includes((await h.fetch(path)).status), path);
    noD1(h);
  }
  assert.deepEqual(calls(h), previous);
  assert.equal(h.statements.length, 0);
});

test('cacheable product detail and product resolve stay on expensive protection', async () => {
  for (const [path, init, refill] of [
    ['/v1/products/1', undefined, 1],
    ['/v1/products/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ products: [{ source: 'opendb', upstream_key: 'cpu/model' }] }) }, 0],
  ]) {
    const h = protectionWorker({ limits: { EXPENSIVE_MISS_LIMITER: 0 } });
    await rateLimited(await h.fetch(path, init));
    assert.equal(h.logs.at(-1).rate_limit_class, 'expensive_miss');
    assert.equal(h.env.BOOTSTRAP_MISS_LIMITER.calls.length, 0);
    assert.equal(h.env.QUERY_REFILL_LIMITER.calls.length, refill);
    noD1(h);
  }
});

test('cache MISS admission fills; HIT never invokes bindings, even missing bindings', async () => {
  const h = protectionWorker();
  const miss = await h.request();
  assert.equal(miss.status, 200);
  assert.equal(miss.headers.get('x-cache'), 'MISS');
  assert.deepEqual(calls(h), { QUERY_REFILL_LIMITER: 1, D1_MISS_LIMITER: 1, EXPENSIVE_MISS_LIMITER: 0, HEALTH_LIMITER: 0, FACET_MISS_LIMITER: 0, BOOTSTRAP_MISS_LIMITER: 0 });
  assert.equal(h.statements.length, 1);
  assert.equal(h.writes, 1);
  for (const b of protectionBindings) delete h.env[b.name];
  const hit = await h.request();
  assert.equal(hit.status, 200);
  assert.deepEqual(await hit.json(), await miss.json());
  assert.equal(h.logs.at(-1).rate_limit_status, 'not_checked');
  assert.equal(h.logs.at(-1).search_cost_class, 'not_classified');
  assert.equal(h.logs.at(-1).d1_queries, 0);
  assert.equal(h.logs.at(-1).rows_read, 0);
  assert.equal(h.statements.length, 1);
});

test('each denied tier returns safe no-store 429 before D1 or cache write', async () => {
  for (const name of ['QUERY_REFILL_LIMITER', 'D1_MISS_LIMITER', 'EXPENSIVE_MISS_LIMITER']) {
    const h = protectionWorker({ limits: { [name]: 0 } });
    const response = await h.request(broad);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-cache'), 'BYPASS');
    assert.equal(response.headers.get('retry-after'), name === 'QUERY_REFILL_LIMITER' ? '10' : '60');
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.match(response.headers.get('access-control-expose-headers'), /Retry-After/);
    assert.deepEqual(await response.json(), { error: { code: 'RATE_LIMITED', message: 'Too many search requests' }, request_id: response.headers.get('x-request-id') });
    assert.equal(h.statements.length, 0);
    assert.equal(h.writes, 0);
    assert.equal(h.logs.at(-1).rows_read, 0);
    if (name !== 'D1_MISS_LIMITER') assert.equal(h.env.D1_MISS_LIMITER.calls.length, 0);
  }
});

test('POST and legal uncached pagination always use expensive and D1 tiers, never facet', async () => {
  for (const [input, method] of [[{ category: 'cpu', keyword: '14900k' }, 'POST'],
    ...[{ limit: 1 }, { limit: 50 }, { offset: 1 }, { offset: 120 }, { limit: 50, offset: 950 }].map(p => [{ ...broad, ...p }, 'GET'])]) {
    const h = protectionWorker({ limits: { EXPENSIVE_MISS_LIMITER: 1 } });
    assert.equal((await h.request(input, method)).status, 200);
    assert.equal((await h.request(input, method)).status, 429);
    assert.equal(h.statements.length, 1);
    assert.equal(h.writes, 0);
    assert.equal(h.env.QUERY_REFILL_LIMITER.calls.length, 0);
    assert.equal(h.env.EXPENSIVE_MISS_LIMITER.calls.length, 2);
    assert.equal(h.env.D1_MISS_LIMITER.calls.length, 1);
    assert.equal(h.env.FACET_MISS_LIMITER.calls.length, 0);
    assert.equal(h.env.BOOTSTRAP_MISS_LIMITER.calls.length, 0);
    assert.equal(h.logs.at(-1).search_cost_class, 'uncached');
  }
});

test('expensive GET MISS uses expensive and D1 tiers; its HIT uses no tokens', async () => {
  const h = protectionWorker({ limits: { FACET_MISS_LIMITER: 0 } });
  assert.equal((await h.request(broad)).status, 200);
  assert.deepEqual(calls(h), { QUERY_REFILL_LIMITER: 1, D1_MISS_LIMITER: 1, EXPENSIVE_MISS_LIMITER: 1, HEALTH_LIMITER: 0, FACET_MISS_LIMITER: 0, BOOTSTRAP_MISS_LIMITER: 0 });
  assert.equal(h.logs.at(-1).rate_limit_class, 'expensive_miss');
  const previous = calls(h);
  assert.equal((await h.request(broad)).headers.get('x-cache'), 'HIT');
  assert.deepEqual(calls(h), previous);
});

test('facet admits 30 requests, rejects the 31st before D1/global tokens, and recovers', async () => {
  const h = protectionWorker({ limits: { EXPENSIVE_MISS_LIMITER: 0, QUERY_REFILL_LIMITER: 0 } });
  for (let i = 0; i < 30; i++) {
    const response = await facet(h);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-cache'), 'BYPASS');
    assert.equal(h.logs.at(-1).rate_limit_status, 'allowed');
    assert.equal(h.logs.at(-1).rate_limit_class, 'facet_miss');
  }
  assert.deepEqual(calls(h), { QUERY_REFILL_LIMITER: 0, D1_MISS_LIMITER: 30, EXPENSIVE_MISS_LIMITER: 0, HEALTH_LIMITER: 0, FACET_MISS_LIMITER: 30, BOOTSTRAP_MISS_LIMITER: 0 });
  const response = await facet(h);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '60');
  assert.equal(h.logs.at(-1).rate_limit_class, 'facet_miss');
  assert.equal(h.logs.at(-1).d1_queries, 0);
  assert.equal(h.statements.length, 30);
  assert.equal(h.env.D1_MISS_LIMITER.calls.length, 30);
  assert.equal(h.env.FACET_MISS_LIMITER.calls.length, 31);
  assert.equal(h.writes, 0);
  h.advance(60_000);
  assert.equal((await facet(h)).status, 200);
});

test('facet and global denials preserve the public 429 contract and stop before D1', async () => {
  for (const [name, tier] of [['FACET_MISS_LIMITER', 'facet_miss'], ['D1_MISS_LIMITER', 'd1_miss']]) {
    const h = protectionWorker({ limits: { [name]: 0 } });
    const response = await facet(h);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-cache'), 'BYPASS');
    assert.equal(response.headers.get('retry-after'), '60');
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.match(response.headers.get('access-control-expose-headers'), /Retry-After/);
    assert.deepEqual(await response.json(), { error: { code: 'RATE_LIMITED', message: 'Too many search requests' }, request_id: response.headers.get('x-request-id') });
    assert.equal(h.logs.at(-1).rate_limit_status, 'denied');
    assert.equal(h.logs.at(-1).rate_limit_class, tier);
    assert.equal(h.logs.at(-1).d1_queries, 0);
    assert.equal(h.logs.at(-1).rows_read, 0);
    assert.equal(h.statements.length, 0);
    assert.equal(h.writes, 0);
    assert.equal(h.env.FACET_MISS_LIMITER.calls.length, 1);
    assert.equal(h.env.D1_MISS_LIMITER.calls.length, name === 'FACET_MISS_LIMITER' ? 0 : 1);
    assert.equal(h.env.EXPENSIVE_MISS_LIMITER.calls.length, 0);
    assert.equal(h.env.QUERY_REFILL_LIMITER.calls.length, 0);
  }
});

test('20 advanced Searches plus 20 facets have independent budgets and share the global D1 ceiling', async () => {
  const h = protectionWorker();
  const search = () => h.request({ category: 'cpu', filters: { manufacturer: ['Intel'] } }, 'POST');
  for (let i = 0; i < 20; i++) {
    assert.equal((await facet(h)).status, 200);
    assert.equal((await search()).status, 200);
  }
  assert.deepEqual(calls(h), { QUERY_REFILL_LIMITER: 0, D1_MISS_LIMITER: 40, EXPENSIVE_MISS_LIMITER: 20, HEALTH_LIMITER: 0, FACET_MISS_LIMITER: 20, BOOTSTRAP_MISS_LIMITER: 0 });
  assert.equal((await search()).status, 429);
  assert.equal(h.logs.at(-1).rate_limit_status, 'denied');
  assert.equal(h.logs.at(-1).rate_limit_class, 'expensive_miss');
  assert.equal(h.logs.at(-1).d1_queries, 0);
  assert.equal(h.logs.at(-1).rows_read, 0);
  assert.equal(h.logs.at(-1).rows_written, 0);
  assert.equal(h.statements.length, 40);
  assert.equal(h.env.D1_MISS_LIMITER.calls.length, 40);
  for (let i = 0; i < 11; i++) assert.equal((await h.request({ category: 'cpu', keyword: `model${1000 + i}` })).status, 200);
  for (let i = 0; i < 9; i++) assert.equal((await facet(h)).status, 200);
  assert.equal(h.statements.length, 60);
  // Facet still has its 30th token, but Search + Facet have used all 60 D1 tokens.
  const response = await facet(h);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '60');
  assert.equal(h.logs.at(-1).rate_limit_class, 'd1_miss');
  assert.equal(h.logs.at(-1).d1_queries, 0);
  assert.equal(h.statements.length, 60);
  assert.equal(h.env.FACET_MISS_LIMITER.calls.length, 30);
  assert.equal(h.env.D1_MISS_LIMITER.calls.length, 61);
  assert.equal(new Set(h.env.D1_MISS_LIMITER.calls).size, 1);
  // Nontransactional: the D1 rejection did not refund the 30th facet token.
  assert.equal((await facet(h)).status, 429);
  assert.equal(h.logs.at(-1).rate_limit_class, 'facet_miss');
  assert.equal(h.env.D1_MISS_LIMITER.calls.length, 61);
});

test('both facet tiers fail closed on missing, throwing or malformed bindings before D1', async () => {
  for (const [name, tier] of [['FACET_MISS_LIMITER', 'facet_miss'], ['D1_MISS_LIMITER', 'd1_miss']]) {
    for (const failure of [undefined, { limit() { throw new Error('secret'); } }, { limit: async () => ({ success: 'yes' }) }]) {
      const h = protectionWorker();
      h.env[name] = failure;
      const response = await facet(h);
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('retry-after'), '60');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { error: { code: 'PROTECTION_UNAVAILABLE', message: 'Request protection temporarily unavailable' }, request_id: response.headers.get('x-request-id') });
      assert.equal(h.logs.at(-1).rate_limit_status, 'unavailable');
      assert.equal(h.logs.at(-1).rate_limit_class, tier);
      assert.equal(h.logs.at(-1).d1_queries, 0);
      assert.equal(h.statements.length, 0);
      assert.equal(h.writes, 0);
      assert.equal(h.env.EXPENSIVE_MISS_LIMITER.calls.length, 0);
      if (name === 'FACET_MISS_LIMITER') assert.equal(h.env.D1_MISS_LIMITER.calls.length, 0);
    }
  }
});

test('concurrent canonical cold queries admit two refills; other query and filled HIT survive', { timeout: 5000 }, async () => {
  let release;
  const blockedDB = new Promise(resolve => { release = resolve; });
  const h = protectionWorker({ blockedDB });
  const work = Array.from({ length: 10 }, (_, i) => h.request({ category: 'cpu', keyword: i % 2 ? ' 14900k ' : '14900k' }));
  // D1 is held until all limiter decisions finish, making every lookup cold.
  while (h.logs.length < 8 || h.statements.length < 2) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(h.statements.length, 2);
  release();
  const responses = await Promise.all(work);
  assert.equal(responses.filter(r => r.status === 429).length, 8);
  assert.equal(h.env.D1_MISS_LIMITER.calls.length, 2);
  const keys = h.env.QUERY_REFILL_LIMITER.calls;
  assert.equal(new Set(keys).size, 1);
  assert.match(keys[0], /^[a-f0-9]{64}$/);
  assert.equal((await h.request()).headers.get('x-cache'), 'HIT');
  assert.equal((await h.request({ category: 'cpu', keyword: '9800x3d' })).status, 200);
});

test('in-flight guard suppresses a permissive binding and releases after failed D1', { timeout: 5000 }, async () => {
  let release;
  const h = protectionWorker({ unlimited: true, blockedDB: new Promise(resolve => { release = resolve; }) });
  const pending = Array.from({ length: 6 }, () => h.request());
  while (h.logs.length < 4) await new Promise(resolve => setTimeout(resolve, 1));
  assert(h.logs.every(e => e.status === 429 && e.rate_limit_class === 'query_inflight'));
  release();
  assert.equal((await Promise.all(pending)).filter(r => r.status === 200).length, 2);
  const broken = protectionWorker({ unlimited: true });
  broken.env.DB.prepare = () => { throw new Error('failure'); };
  for (let i = 0; i < 4; i++) assert.equal((await broken.request()).status, 500);
});

test('unique normal and expensive bursts stop at independent resource budgets and recover', async () => {
  for (const [expensive, limit] of [[false, 60], [true, 20]]) {
    const h = protectionWorker();
    const responses = [];
    for (let i = 0; i < 100; i++) responses.push(await h.request({ category: expensive ? 'memory' : 'cpu', keyword: expensive ? `ddr5${'!'.repeat(i + 1)}` : `model${1000 + i}` }));
    assert.equal(responses.filter(r => r.status === 200).length, limit);
    assert.equal(h.statements.length, limit);
    assert.equal(responses.filter(r => r.status === 429).length, 100 - limit);
    h.advance(60_000);
    assert.equal((await h.request({ category: 'cpu', keyword: 'model9999' })).status, 200);
  }
});

test('per-query binding rejects repeated cold refills beyond the local concurrent lifetime', async () => {
  const h = protectionWorker();
  h.cache.match = async () => undefined;
  for (let i = 0; i < 2; i++) assert.equal((await h.request()).status, 200);
  assert.equal((await h.request()).status, 429);
  assert.equal(h.logs.at(-1).rate_limit_class, 'query_refill');
  assert.equal(h.statements.length, 2);
  assert.equal(h.env.D1_MISS_LIMITER.calls.length, 2);
  h.advance(10_000);
  assert.equal((await h.request()).status, 200);
});

test('in-flight memory remains bounded and distinct keys recover when requests finish', () => {
  const guard = createRefillGuard();
  const releases = Array.from({ length: 128 }, (_, i) => guard(String(i)));
  assert(releases.every(r => typeof r === 'function'));
  assert.equal(guard('overflow'), null);
  const second = guard('0');
  assert.equal(typeof second, 'function');
  assert.equal(guard('0'), null);
  second(); releases[0]();
  const extra = guard('overflow');
  assert.equal(typeof extra, 'function');
  extra(); releases.slice(1).forEach(release => release());
});

test('limiter missing, exception and malformed result fail closed; warmed HIT remains available', async () => {
  for (const name of protectionBindings.map(b => b.name)) for (const failure of [undefined,
    { limit() { throw new Error('secret SQL keyword token IP'); } }, { limit: async () => ({ success: 'yes' }) }]) {
    const h = protectionWorker();
    await h.request();
    h.env[name] = failure;
    const response = name === 'HEALTH_LIMITER' ? await h.fetch('/v1/health') : name === 'FACET_MISS_LIMITER' ? await facet(h)
      : name === 'BOOTSTRAP_MISS_LIMITER' ? await h.request({ category: 'cpu' }) : await h.request(broad);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'PROTECTION_UNAVAILABLE');
    assert.equal(h.logs.at(-1).d1_queries, 0);
    assert.equal(h.logs.at(-1).rate_limit_status, 'unavailable');
    assert.equal(h.statements.length, 1);
    assert.equal(h.writes, 1);
    assert.equal((await h.request()).status, 200);
    assert(!/secret|SQL|keyword|token|IP/.test(JSON.stringify(h.logs)));
  }
});

test('cache failures retain protection; health is isolated; invalid input consumes no token', async () => {
  const h = protectionWorker({ cacheFailure: 'match', limits: { EXPENSIVE_MISS_LIMITER: 0, HEALTH_LIMITER: 1 } });
  assert.equal((await h.request()).status, 429);
  assert.equal(h.logs.at(-1).search_cost_class, 'uncached');
  assert.equal((await h.fetch('/v1/health')).status, 200);
  assert.equal((await h.fetch('/v1/health')).status, 429);
  const previous = calls(h);
  for (const path of ['/v1/search?category=cpu&q=x&debug=true', '/v1/health?x=1']) assert.equal((await h.fetch(path)).status, 400);
  assert.equal((await h.fetch('/v1/categories')).status, 200);
  assert.equal((await h.fetch('/v1/search', { method: 'OPTIONS' })).status, 204);
  assert.deepEqual(calls(h), previous);
  assert.equal(h.statements.length, 1);
});

test('classifier is general and does not narrow valid queries or mutate input', async () => {
  for (const [category, keyword] of [['memory', 'ddr4'], ['storage', 'nvme 2tb'], ['memory', 'corsair'],
    ['cpu', 'ryzen 7'], ['motherboard', 'b650e wifi'], ['cpu', 'a']]) {
    const input = Object.freeze({ category, keyword });
    assert.equal(classifySearchCost(input), 'expensive');
  }
  for (const keyword of ['14900k', 'intel 14900k', 'rtx 5080']) assert.equal(classifySearchCost({ category: 'cpu', keyword }), 'normal');
  assert.equal((await protectionWorker().request({ category: 'cpu', keyword: 'a' })).status, 200);
});

test('predeploy strictly validates all production/local bindings and unique namespaces', async () => {
  const config = JSON.parse(await readFile('wrangler.json', 'utf8'));
  validateProtectionConfig(config);
  for (const mutate of [c => delete c.ratelimits, c => c.ratelimits.pop(), c => c.ratelimits[0].namespace_id = c.ratelimits[1].namespace_id,
    c => c.ratelimits[0].simple.period = 30, c => c.ratelimits[1].simple.limit = 600, c => delete c.vars.CATALOG_CACHE_EPOCH]) {
    const copy = structuredClone(config); mutate(copy); assert.throws(() => validateProtectionConfig(copy));
  }
  for (const environment of ['production', 'local']) for (const binding of [...protectionBindings, yahooOfferBinding]) {
    for (const mutate of [c => c.ratelimits = c.ratelimits.filter(b => b.name !== binding.name),
      c => c.ratelimits.find(b => b.name === binding.name).namespace_id = '99999999',
      c => c.ratelimits.find(b => b.name === binding.name).namespace_id = c.ratelimits.find(b => b.name !== binding.name).namespace_id,
      c => c.ratelimits.find(b => b.name === binding.name).simple.limit++,
      c => c.ratelimits.find(b => b.name === binding.name).simple.period = 30,
      c => c.ratelimits.push(structuredClone(c.ratelimits.find(b => b.name === binding.name)))]) {
      const copy = structuredClone(config);
      mutate(environment === 'production' ? copy : copy.env.local);
      assert.throws(() => validateProtectionConfig(copy), `${environment} ${binding.name}`);
    }
  }
  const shared = structuredClone(config);
  shared.env.local.ratelimits.at(-1).namespace_id = shared.ratelimits.at(-1).namespace_id;
  assert.throws(() => validateProtectionConfig(shared));
  const missingLocal = structuredClone(config); delete missingLocal.env.local.ratelimits;
  assert.throws(() => validateProtectionConfig(missingLocal));
  assert.equal(config.ratelimits.length, 7);
  assert.equal(config.env.local.ratelimits.length, 7);
  assert.deepEqual(config.env.local.ratelimits.map(({ name, simple }) => ({ name, simple })), [...protectionBindings, yahooOfferBinding].map(({ name, simple }) => ({ name, simple })));
  assert.equal(config.env.local.ratelimits.find(b => b.name === 'FACET_MISS_LIMITER').namespace_id, '29599105');
  assert.equal(config.env.local.ratelimits.find(b => b.name === 'BOOTSTRAP_MISS_LIMITER').namespace_id, '29599106');
  assert.deepEqual(config.ratelimits.find(b => b.name === 'BOOTSTRAP_MISS_LIMITER'), {
    name: 'BOOTSTRAP_MISS_LIMITER', namespace_id: '29599006', simple: { limit: 40, period: 60 },
  });
  assert.equal(new Set([...config.ratelimits, ...config.env.local.ratelimits].map(b => b.namespace_id)).size, 14);
});
