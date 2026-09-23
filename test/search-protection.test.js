import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { classifySearchCost, protectionBindings, validateProtectionConfig, createRefillGuard } from '../src/search-protection.js';
import { protectionWorker } from '../test-support/protection-worker.js';

const broad = { category: 'memory', keyword: 'ddr5' };
const calls = h => Object.fromEntries(protectionBindings.map(b => [b.name, h.env[b.name].calls.length]));
const facet = h => h.fetch('/v1/categories/cpu/facets', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
});

test('cache MISS admission fills; HIT never invokes bindings, even missing bindings', async () => {
  const h = protectionWorker();
  const miss = await h.request();
  assert.equal(miss.status, 200);
  assert.equal(miss.headers.get('x-cache'), 'MISS');
  assert.deepEqual(calls(h), { QUERY_REFILL_LIMITER: 1, D1_MISS_LIMITER: 1, EXPENSIVE_MISS_LIMITER: 0, HEALTH_LIMITER: 0, FACET_MISS_LIMITER: 0 });
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
    assert.equal(h.logs.at(-1).search_cost_class, 'uncached');
  }
});

test('expensive GET MISS uses expensive and D1 tiers; its HIT uses no tokens', async () => {
  const h = protectionWorker({ limits: { FACET_MISS_LIMITER: 0 } });
  assert.equal((await h.request(broad)).status, 200);
  assert.deepEqual(calls(h), { QUERY_REFILL_LIMITER: 1, D1_MISS_LIMITER: 1, EXPENSIVE_MISS_LIMITER: 1, HEALTH_LIMITER: 0, FACET_MISS_LIMITER: 0 });
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
  assert.deepEqual(calls(h), { QUERY_REFILL_LIMITER: 0, D1_MISS_LIMITER: 30, EXPENSIVE_MISS_LIMITER: 0, HEALTH_LIMITER: 0, FACET_MISS_LIMITER: 30 });
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
  assert.deepEqual(calls(h), { QUERY_REFILL_LIMITER: 0, D1_MISS_LIMITER: 40, EXPENSIVE_MISS_LIMITER: 20, HEALTH_LIMITER: 0, FACET_MISS_LIMITER: 20 });
  assert.equal((await search()).status, 429);
  assert.equal(h.logs.at(-1).rate_limit_class, 'expensive_miss');
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
    const response = name === 'HEALTH_LIMITER' ? await h.fetch('/v1/health') : name === 'FACET_MISS_LIMITER' ? await facet(h) : await h.request(broad);
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
    ['cpu', 'ryzen 7'], ['motherboard', 'b650e wifi'], ['cpu', 'a'], ['memory', undefined]]) {
    const input = Object.freeze({ category, keyword });
    assert.equal(classifySearchCost(input), 'expensive');
  }
  for (const keyword of ['14900k', 'intel 14900k', 'rtx 5080']) assert.equal(classifySearchCost({ category: 'cpu', keyword }), 'normal');
  assert.equal((await protectionWorker().request({ category: 'cpu', keyword: 'a' })).status, 200);
});

test('predeploy validates production and rejects missing/shared/wrong thresholds and invalid epoch', async () => {
  const config = JSON.parse(await readFile('wrangler.json', 'utf8'));
  validateProtectionConfig(config);
  for (const mutate of [c => delete c.ratelimits, c => c.ratelimits.pop(), c => c.ratelimits[0].namespace_id = c.ratelimits[1].namespace_id,
    c => c.ratelimits[0].simple.period = 30, c => c.ratelimits[1].simple.limit = 600, c => delete c.vars.CATALOG_CACHE_EPOCH]) {
    const copy = structuredClone(config); mutate(copy); assert.throws(() => validateProtectionConfig(copy));
  }
  for (const binding of protectionBindings) {
    for (const mutate of [c => c.ratelimits = c.ratelimits.filter(b => b.name !== binding.name),
      c => c.ratelimits.find(b => b.name === binding.name).namespace_id = '99999999',
      c => c.ratelimits.find(b => b.name === binding.name).simple.limit++,
      c => c.ratelimits.find(b => b.name === binding.name).simple.period = 30,
      c => c.ratelimits.push(structuredClone(c.ratelimits.find(b => b.name === binding.name)))]) {
      const copy = structuredClone(config); mutate(copy); assert.throws(() => validateProtectionConfig(copy), binding.name);
    }
  }
  assert.equal(config.ratelimits.length, 5);
  assert.equal(config.env.local.ratelimits.length, 5);
  assert.deepEqual(config.env.local.ratelimits.map(({ name, simple }) => ({ name, simple })), protectionBindings.map(({ name, simple }) => ({ name, simple })));
  assert.equal(config.env.local.ratelimits.find(b => b.name === 'FACET_MISS_LIMITER').namespace_id, '29599105');
  assert.equal(new Set([...config.ratelimits, ...config.env.local.ratelimits].map(b => b.namespace_id)).size, 10);
});
