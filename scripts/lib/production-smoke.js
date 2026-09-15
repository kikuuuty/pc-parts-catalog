import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { searchQuery } from '../../src/queries.js';
import { loadSearchFixture } from '../../src/quality/fixtures.js';
import { catalogState, assertCatalogState } from '../../src/quality/catalog.js';
import { assertCategories, assertSearchContract, assertPublicHeaders } from './api-contract.js';
import { models, initialCategories } from '../../src/model.js';

export function productionOrigin(value) {
  const url = new URL(value);
  assert(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname));
  assert(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/');
  return url.origin;
}

export function pacedRequests(origin, { fetcher = fetch, sleep = delay, interval = 3500 } = {}) {
  let last = 0;
  return async (path, init, expected = 200) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await sleep(Math.max(0, last + interval - Date.now()));
      last = Date.now();
      let response;
      try { response = await fetcher(new URL(path, origin), { ...init, signal: AbortSignal.timeout(60_000) }); }
      catch { if (attempt === 2) throw new Error('Production network verification failed'); await sleep(5000 * (attempt + 1)); continue; }
      if ([429, 502, 503, 504].includes(response.status) && attempt < 2) {
        const header = response.headers.get('retry-after');
        const retry = /^\d+$/.test(header ?? '') ? Number(header) * 1000 : Date.parse(header) - Date.now();
        assert(!Number.isFinite(retry) || retry <= 120000, 'Retry-After exceeds verification deadline');
        await response.body?.cancel();
        await sleep(Math.max(10000 * (attempt + 1), Number.isFinite(retry) ? retry : 0));
        continue;
      }
      assert.equal(response.status, expected, `Production HTTP contract (${expected})`);
      assertPublicHeaders(response);
      if (expected === 204) return { response, body: null };
      assert.match(response.headers.get('content-type') ?? '', /application\/json/i);
      return { response, body: await response.json() };
    }
  };
}

export async function verifyProduction(db, origin, { golden = true, request = pacedRequests(productionOrigin(origin)) } = {}) {
  const initial = await catalogState(db);
  assert.equal(initial?.status, 'complete');
  assert.deepEqual((await request('/v1/health')).body, { ok: true, database: 'available' });
  assertCategories((await request('/v1/categories')).body);
  const preflight = await request('/v1/search', { method: 'OPTIONS', headers: { Origin: 'https://consumer.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } }, 204);
  assert.equal(preflight.response.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
  const invalid = await request('/v1/search?category=cpu&limit=51', undefined, 400);
  assert.equal(invalid.body.error.code, 'INVALID_REQUEST');
  assert.equal((await request('/v1/search', { method: 'PUT' }, 405)).body.error.code, 'METHOD_NOT_ALLOWED');

  const search = async (input, method = 'GET') => {
    const { category, keyword, limit = 20, offset = 0, ...advanced } = input;
    const result = method === 'POST'
      ? await request('/v1/search', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
      : await request(`/v1/search?${new URLSearchParams({ category, q: keyword, limit: String(limit), offset: String(offset) })}`);
    assertSearchContract(result.body, input);
    assert.equal(result.response.headers.get('cache-control'), 'no-store');
    const q = searchQuery(category, { ...advanced, keyword, limit: limit + 1 });
    const rows = (await db.query(`${q.sql} OFFSET ?`, [...q.params, offset])).results;
    assert.deepEqual(result.body.data.map(p => p.upstream_key), rows.slice(0, limit).map(p => p.upstream_key), 'API/direct top results differ');
    for (const [i, product] of result.body.data.entries()) {
      assert.deepEqual(product.specs, Object.fromEntries(Object.keys(models[category].fields).map(field => [field, rows[i][field] ?? null])), 'API/direct specs differ');
      for (const field of ['id', 'upstream_id', 'upstream_key', 'category', 'manufacturer', 'name', 'series', 'variant', 'release_year', 'manufacturer_url']) assert.equal(product[field], rows[i][field] ?? null, `API/direct ${field} differs`);
    }
    assert.equal(result.body.meta.has_more, rows.length > limit);
    if (method === 'POST') assert.equal(result.response.headers.get('x-cache'), 'BYPASS');
    return result;
  };
  const representatives = [
    { category: 'cpu', keyword: '9800x3d' },
    { category: 'cpu', keyword: 'amd 9800x3d' },
    { category: 'memory', keyword: 'ddr5 6000 cl30 32gb' },
    { category: 'memory', keyword: 'ddr5' },
  ];
  for (const input of representatives) {
    const get = await search(input);
    assert(get.body.data.length > 0, 'Representative query empty');
    assert.deepEqual((await search(input, 'POST')).body, get.body, 'GET/POST body differs');
  }
  await search({ category: 'memory', keyword: 'ddr5', offset: 20 });
  await search({ category: 'memory', keyword: 'ddr5', limit: 50, offset: 950 }, 'POST');

  // Existing cache identity preserves INTERNAL spaces; the search parser treats
  // these as token separators. No cache-bypass parameter/header or rate bypass.
  // A prewarmed key or POP change is inconclusive; try another bounded key.
  let cache = false;
  for (let attempt = 0; attempt < 6 && !cache; attempt++) {
    const input = { category: 'memory', keyword: `ddr5${' '.repeat(randomInt(2, 150))}6000` };
    const first = await search(input);
    if (first.response.headers.get('x-cache') !== 'MISS') continue;
    assert.match(first.response.headers.get('server-timing') ?? '', /d1;dur=/, 'MISS must execute D1');
    const second = await search(input);
    const pop = r => r.response.headers.get('cf-ray')?.split('-').at(-1);
    if (pop(first) !== pop(second)) continue;
    assert.equal(second.response.headers.get('x-cache'), 'HIT', 'Sequential same-POP cache read');
    assert.equal(second.response.headers.get('server-timing'), null, 'HIT must omit D1 timing');
    assert.match(second.response.headers.get('age') ?? '', /^\d+$/);
    assert.deepEqual(second.body, first.body, 'Cached body differs');
    assert.deepEqual((await search(input, 'POST')).body, first.body, 'Cache/uncached body differs');
    cache = true;
  }
  assert(cache, 'Cache MISS/HIT verification inconclusive after bounded attempts');
  const extended = [];
  for (const category of Object.keys(models).filter(c => !initialCategories.includes(c))) {
    const samples = (await db.query(`SELECT p.upstream_key,p.name,i.type,i.value FROM products p JOIN identifiers i ON i.product_id=p.id
      WHERE p.active=1 AND p.category=? ORDER BY p.id LIMIT 100`, [category])).results;
    const sample = samples.find(p => p.name.length <= 200 && (p.name.match(/[\p{L}\p{N}]+/gu)?.length ?? 0) <= 12);
    assert(sample, `Missing API sample: ${category}`);
    const basic = await search({ category, keyword: sample.name });
    assert(basic.body.data.some(p => p.upstream_key === sample.upstream_key), `New category keyword: ${category}`);
    const exact = await search({ category, identifier: { type: sample.type, value: sample.value }, include: ['identifiers', 'facets'] }, 'POST');
    const product = exact.body.data.find(p => p.upstream_key === sample.upstream_key);
    assert(product?.identifiers.some(i => i.type === sample.type && i.value === sample.value), `New category identifier response: ${category}`);
    assert(product.facets && Object.values(product.facets).every(Array.isArray));
    extended.push({ category, keyword: 'pass', identifier: 'pass', response: 'pass' });
  }
  let matched = 0;
  if (golden) {
    const { fixture } = await loadSearchFixture();
    for (const item of fixture) {
      await search({ ...item.search, category: item.category, keyword: item.query }, item.search ? 'POST' : 'GET');
      matched++;
    }
    assert.equal(matched, 120);
  }
  await assertCatalogState(db, initial);
  return { contract: 'pass', cache: 'MISS -> HIT; POST body equal', golden_api_matched: matched, extended_categories: extended };
}
