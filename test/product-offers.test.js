import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { database } from '../test-support/database.js';
import { fakeLimiters } from '../test-support/rate-limiter.js';
import { yahooHit, yahooBody, JAN, OTHER_JAN } from '../test-support/yahoo.js';
import { normalize } from '../src/normalize.js';
import { syncSnapshot } from '../src/sync.js';
import { addLocalIdentifier } from '../src/enrichment.js';
import { createWorker } from '../src/worker.js';
import { productionConfig } from '../scripts/lib/release-gates.js';
import { offerCachePolicy } from '../src/offers/cache.js';
import { writeSearchCache } from '../src/search-cache.js';

async function setup(t, options = {}) {
  const db = database(); t.after(() => db.sqlite.close());
  await syncSnapshot(db, { commit: 'a'.repeat(40), records: Array.from({ length: 3 }, (_, i) => normalize('cpu', {
    opendb_id: randomUUID(), metadata: { name: `Private product ${i}` },
  }, 'a'.repeat(40))) });
  for (const productId of [1, 2]) await addLocalIdentifier(db, { productId, type: 'jan', value: ` ${JAN} `, evidence: 'test' });
  let clock = 1000000, fetches = 0;
  const entries = new Map(), logs = [];
  const cache = { async match(key) { return entries.get(key.url)?.clone(); }, async put(key, response) { entries.set(key.url, response.clone()); } };
  const env = { ...fakeLimiters({ unlimited: true }), CATALOG_CACHE_EPOCH: 'offers-test', YAHOO_SHOPPING_APP_ID: 'test-only-secret',
    DB: { prepare: sql => ({ bind: (...params) => ({ all: () => db.query(sql, params) }) }) } };
  const worker = createWorker({ cache, now: () => clock, log: e => logs.push(e), offerTimeoutMs: options.timeoutMs ?? 5000,
    offerFetch: async (...args) => { fetches++; return options.fetch ? options.fetch(...args) : Response.json(yahooBody([yahooHit()])); } });
  const request = (path = '/v1/products/1/offers', init) => worker.fetch(new Request(`https://catalog.example${path}`, init), env);
  return { db, env, entries, cache, logs, request, advance: ms => clock += ms, fetches: () => fetches };
}

test('offers contract, CORS, request IDs, MISS -> HIT and same JAN shared across products', async t => {
  const h = await setup(t);
  const response = await h.request();
  assert.equal(response.status, 200); assert.equal(response.headers.get('X-Cache'), 'MISS');
  assert.equal(response.headers.get('X-Cache-TTL'), '1800');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  const body = await response.json();
  assert.deepEqual(body.product, { id: 1, name: 'Private product 0' });
  assert.equal(body.provider, 'yahoo');
  assert.deepEqual(body.lookup, { status: 'complete', strategy: 'jan', reason: null });
  assert.equal(body.offers[0].jan_code, JAN);
  const previousD1 = h.env.D1_MISS_LIMITER.calls.length;
  h.advance(5000);
  const hit = await h.request(); assert.equal(hit.headers.get('X-Cache'), 'HIT');
  assert.equal(hit.headers.get('Age'), '5'); assert.deepEqual(await hit.json(), body);
  assert.notEqual(hit.headers.get('X-Request-ID'), response.headers.get('X-Request-ID'));
  assert.equal(h.logs.at(-1).d1_queries, 0); assert.equal(h.env.D1_MISS_LIMITER.calls.length, previousD1);
  delete h.env.YAHOO_OFFER_MISS_LIMITER;
  const shared = await h.request('/v1/products/2/offers');
  assert.equal(shared.headers.get('X-Cache'), 'HIT');
  assert.equal((await shared.json()).product.id, 2); assert.equal(h.fetches(), 1);
  assert(!JSON.stringify([...h.entries.keys()]).includes(h.env.YAHOO_SHOPPING_APP_ID));
  const log = JSON.stringify(h.logs);
  for (const privateValue of [JAN, 'Private product', 'test-only-secret', 'https://', 'seller']) assert(!log.includes(privateValue));
  assert(h.logs.every(e => e.route === '/v1/products/:id/offers'));
});

test('no supported JAN returns 200 unsupported without secret, limiter or upstream lookup', async t => {
  const h = await setup(t); delete h.env.YAHOO_SHOPPING_APP_ID;
  await addLocalIdentifier(h.db, { productId: 3, type: 'ean', value: JAN, evidence: 'test' });
  await addLocalIdentifier(h.db, { productId: 3, type: 'jan', value: 'bad code', evidence: 'test' });
  const response = await h.request('/v1/products/3/offers'); assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { product: { id: 3, name: 'Private product 2' }, provider: 'yahoo',
    lookup: { status: 'unsupported', strategy: null, reason: 'no_supported_identifier' }, offers: [] });
  assert.equal(h.fetches(), 0); assert.equal(h.env.YAHOO_OFFER_MISS_LIMITER.calls.length, 0);
});

test('image metadata is cached with Offers, old cache generation is ignored and image URLs are never fetched or logged', async t => {
  const h = await setup(t, { fetch: async input => {
    const url = new URL(input);
    assert.equal(url.hostname, 'shopping.yahooapis.jp', 'only ItemSearch may be fetched');
    assert.equal(url.searchParams.get('image_size'), '300');
    return Response.json(yahooBody([yahooHit()]));
  } });
  const policy = offerCachePolicy(new URL('https://catalog.example'), JAN, h.env);
  assert.equal(new URL(policy.key.url).pathname, '/__catalog_cache/offers/yahoo/v2');
  const legacyKey = new Request(policy.key.url.replace('/yahoo/v2?', '/yahoo/v1?'));
  await writeSearchCache(h.cache, legacyKey, JSON.stringify([{ price: 1 }]), policy.ttl, 1000000);
  const response = await h.request(); assert.equal(response.headers.get('X-Cache'), 'MISS');
  const body = await response.json(), offer = body.offers[0];
  assert.equal(offer.image.id, 'example-product-image');
  assert.deepEqual(offer.image.preferred, { url: yahooHit().exImage.url, width: 300, height: 300 });
  assert.deepEqual(offer.seller.image, { id: 'example-seller-image', url: null });
  assert.deepEqual(await h.entries.get(policy.key.url).clone().json(), body.offers);
  h.advance(1000);
  const hit = await h.request(); assert.equal(hit.headers.get('X-Cache'), 'HIT');
  assert.deepEqual(await hit.json(), body); assert.equal(h.fetches(), 1);
  assert(!JSON.stringify(body).includes(h.env.YAHOO_SHOPPING_APP_ID));
  const logs = JSON.stringify(h.logs);
  for (const privateValue of [h.env.YAHOO_SHOPPING_APP_ID, offer.image.id, offer.seller.image.id, yahooHit().image.small, yahooHit().exImage.url, 'appid=']) {
    assert(!logs.includes(privateValue));
  }
});

test('offers routing follows Detail ID, method, query, inactive and nonexistent contracts', async t => {
  const h = await setup(t);
  for (const id of ['0', '-1', '01', 'abc', '999']) assert.equal((await h.request(`/v1/products/${id}/offers`)).status, 404);
  assert.equal((await h.request('/v1/products/9007199254740992/offers')).status, 400);
  assert.equal((await h.request('/v1/products/1/offers?q=test')).status, 400);
  assert.equal((await h.request(undefined, { method: 'POST' })).status, 405);
  const preflight = await h.request(undefined, { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'GET' } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('Allow'), 'GET, OPTIONS');
  h.db.sqlite.exec('UPDATE products SET active=0 WHERE id=1');
  const response = await h.request(); assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'PRODUCT_NOT_FOUND');
  assert.equal(h.fetches(), 0); assert.equal(h.entries.size, 0);
});

test('offer TTL boundary, catalog epoch and identifier changes invalidate without stale fallback', async t => {
  const h = await setup(t);
  h.env.YAHOO_OFFERS_CACHE_TTL_SECONDS = '60';
  assert.equal((await h.request()).status, 200);
  h.advance(59999); assert.equal((await h.request()).headers.get('X-Cache'), 'HIT');
  h.advance(1); assert.equal((await h.request()).headers.get('X-Cache'), 'MISS'); assert.equal(h.fetches(), 2);
  h.advance(1000); h.env.CATALOG_CACHE_EPOCH = 'new-release';
  assert.equal((await h.request()).headers.get('X-Cache'), 'MISS'); assert.equal(h.fetches(), 3);
  h.advance(1000); h.env.CATALOG_CACHE_EPOCH = 'changed-identifiers';
  h.db.sqlite.exec('DELETE FROM local_identifiers WHERE product_id=1');
  await addLocalIdentifier(h.db, { productId: 1, type: 'jan', value: OTHER_JAN, evidence: 'test' });
  const changed = await h.request(); assert.equal(changed.status, 200); assert.equal(h.fetches(), 4);
  assert.deepEqual((await changed.json()).offers, [], 'upstream old JAN must be excluded');
  h.advance(60000); delete h.env.YAHOO_SHOPPING_APP_ID;
  assert.equal((await h.request()).status, 503, 'expired cache must not mask provider unavailability');
});

test('cache failures remain protected, never return errors as cached prices, and recover', async t => {
  for (const failure of ['match', 'put']) {
    const h = await setup(t), original = h.cache[failure];
    h.cache[failure] = async () => { throw Error('private cache error'); };
    const response = await h.request(); assert.equal(response.status, 200);
    assert.equal(response.headers.get('X-Cache'), 'BYPASS');
    assert.equal(h.env.YAHOO_OFFER_MISS_LIMITER.calls.length, 1);
    assert.equal(h.logs.at(-1).offer_cache_error, failure);
    h.advance(1000); h.cache[failure] = original;
    assert.equal((await h.request()).status, 200);
    assert.equal(h.fetches(), failure === 'match' ? 1 : 2);
  }
});

test('parallel MISS shares one Yahoo request and one limiter token, including failures', async t => {
  for (const fail of [false, true]) {
    let release, entered;
    const started = new Promise(resolve => entered = resolve);
    const h = await setup(t, { fetch: async () => { entered(); await new Promise(resolve => release = resolve);
      return fail ? new Response('private', { status: 500 }) : Response.json(yahooBody([yahooHit()])); } });
    // Warm only catalog Detail, so its independent D1 refill guard is not under test here.
    await h.request('/v1/products/1'); await h.request('/v1/products/2');
    const first = h.request(); await started;
    const parallel = Array.from({ length: 10 }, (_, i) => h.request(`/v1/products/${i % 2 + 1}/offers`));
    await new Promise(resolve => setImmediate(resolve)); release();
    const responses = await Promise.all([first, ...parallel]);
    assert(responses.every(r => r.status === (fail ? 503 : 200)));
    assert.equal(h.fetches(), 1); assert.equal(h.env.YAHOO_OFFER_MISS_LIMITER.calls.length, 1);
    assert(h.logs.some(e => e.offer_coalesced));
  }
});

test('dedicated MISS limiter fails closed and isolate pacing prevents sequential uncached bursts', async t => {
  for (const mode of ['deny', 'missing', 'throw', 'malformed']) {
    const h = await setup(t);
    if (mode === 'missing') delete h.env.YAHOO_OFFER_MISS_LIMITER;
    else h.env.YAHOO_OFFER_MISS_LIMITER.limit = async () => {
      if (mode === 'throw') throw Error('private limiter');
      return mode === 'malformed' ? {} : { success: false };
    };
    const response = await h.request(); assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, mode === 'deny' ? 'OFFER_PROVIDER_RATE_LIMITED' : 'OFFER_PROVIDER_UNAVAILABLE');
    assert.equal(h.logs.at(-1).rate_limit_class, 'yahoo_offer_miss'); assert.equal(h.fetches(), 0);
  }
  const h = await setup(t);
  h.cache.put = async () => { throw Error('no cache'); };
  assert.equal((await h.request()).status, 200);
  const denied = await h.request(); assert.equal(denied.status, 503); assert.equal(denied.headers.get('Retry-After'), '1');
  assert.equal(h.fetches(), 1); assert.equal(h.env.YAHOO_OFFER_MISS_LIMITER.calls.length, 1);
  h.advance(1000); assert.equal((await h.request()).status, 200); assert.equal(h.fetches(), 2);
});

test('public provider failures have stable errors and fresh request IDs, never secret/body/URL/stack', async t => {
  const cases = [
    ['missing_app_id', null, 503, 'OFFER_PROVIDER_UNAVAILABLE'],
    ['timeout', () => new Promise(() => {}), 503, 'OFFER_PROVIDER_UNAVAILABLE'],
    ['upstream_429', async () => new Response('private upstream', { status: 429, headers: { 'Retry-After': '120' } }), 503, 'OFFER_PROVIDER_RATE_LIMITED'],
    ['upstream_5xx', async () => new Response('private upstream', { status: 500 }), 503, 'OFFER_PROVIDER_UNAVAILABLE'],
    ['upstream_4xx', async () => new Response('private upstream', { status: 403 }), 502, 'OFFER_PROVIDER_ERROR'],
    ['invalid_json', async () => new Response('private upstream'), 502, 'OFFER_PROVIDER_ERROR'],
    ['malformed_response', async () => Response.json({}), 502, 'OFFER_PROVIDER_ERROR'],
  ];
  for (const [reason, fetch, status, code] of cases) {
    const h = await setup(t, { fetch, timeoutMs: 20 });
    if (!fetch) delete h.env.YAHOO_SHOPPING_APP_ID;
    const response = await h.request(); assert.equal(response.status, status, reason);
    const body = await response.json(); assert.equal(body.error.code, code);
    assert.equal(body.request_id, response.headers.get('X-Request-ID'));
    assert.equal(response.headers.get('X-Cache'), 'BYPASS');
    assert.equal(response.headers.get('X-Cache-TTL'), null);
    assert.equal(h.logs.at(-1).provider_error_reason, reason);
    assert.equal([...h.entries.keys()].filter(k => k.includes('/offers/')).length, 0);
    const output = JSON.stringify(body) + JSON.stringify(h.logs);
    assert(!/test-only-secret|private upstream|https:|stack|0012345678905/.test(output));
    if (reason === 'upstream_429') assert.equal(response.headers.get('Retry-After'), '120');
  }
});

test('Yahoo budget permits 30 misses per minute, HIT consumes nothing, and rejection recovers', async t => {
  const h = await setup(t);
  let clock = 0;
  h.env.YAHOO_OFFER_MISS_LIMITER = fakeLimiters({ now: () => clock }).YAHOO_OFFER_MISS_LIMITER;
  for (let i = 0; i < 30; i++) {
    for (const key of h.entries.keys()) if (key.includes('/offers/')) h.entries.delete(key);
    assert.equal((await h.request()).status, 200);
    assert.equal((await h.request()).headers.get('X-Cache'), 'HIT');
    h.advance(1000); clock += 1000;
  }
  for (const key of h.entries.keys()) if (key.includes('/offers/')) h.entries.delete(key);
  const denied = await h.request(); assert.equal(denied.status, 503);
  assert.equal(denied.headers.get('Retry-After'), '60'); assert.equal(h.fetches(), 30);
  assert.equal(h.env.YAHOO_OFFER_MISS_LIMITER.calls.length, 31);
  clock = 60000; h.advance(30000);
  assert.equal((await h.request()).status, 200); assert.equal(h.fetches(), 31);
});

test('cold Detail plus Offer parallel misses do not amplify upstream, missing epoch bypasses safely', async t => {
  const h = await setup(t);
  const responses = await Promise.all([h.request(), h.request()]);
  assert(responses.every(r => r.status === 200)); assert.equal(h.fetches(), 1);
  delete h.env.CATALOG_CACHE_EPOCH; h.advance(1000);
  assert.equal((await h.request()).headers.get('X-Cache'), 'BYPASS'); assert.equal(h.fetches(), 2);
  h.advance(1000); h.env.YAHOO_OFFERS_CACHE_TTL_SECONDS = '500000';
  const invalid = await h.request(); assert.equal(invalid.status, 503); assert.equal(h.fetches(), 2);
});

test('release validates Yahoo namespace, safe TTL and secret-only configuration without real credentials', async () => {
  const config = JSON.parse(await readFile('wrangler.json', 'utf8'));
  productionConfig(config, {});
  for (const scope of ['production', 'local']) {
    for (const change of ['ttl', 'secret', 'limiter']) {
      const copy = structuredClone(config), target = scope === 'production' ? copy : copy.env.local;
      if (change === 'ttl') target.vars.YAHOO_OFFERS_CACHE_TTL_SECONDS = '999999';
      if (change === 'secret') target.vars.YAHOO_SHOPPING_APP_ID = 'test-only';
      if (change === 'limiter') target.ratelimits.find(b => b.name === 'YAHOO_OFFER_MISS_LIMITER').simple.limit = 31;
      assert.throws(() => productionConfig(copy, {}));
    }
  }
});
