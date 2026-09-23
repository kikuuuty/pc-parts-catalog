import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { database } from '../test-support/database.js';
import { fakeLimiters } from '../test-support/rate-limiter.js';
import { yahooHit, yahooBody, JAN, OTHER_JAN, RYZEN_EAN, ryzen9800, A3_FIRST_EAN, A3_YAHOO_EAN, a3WhiteWoodMesh } from '../test-support/yahoo.js';
import { normalize } from '../src/normalize.js';
import { syncSnapshot } from '../src/sync.js';
import { addLocalIdentifier } from '../src/enrichment.js';
import { createWorker } from '../src/worker.js';
import { productionConfig } from '../scripts/lib/release-gates.js';
import { offerCachePolicy } from '../src/offers/cache.js';
import { writeSearchCache } from '../src/search-cache.js';
import { canonicalIdentifiers } from '../src/product-detail.js';
import { selectYahooLookupCandidates } from '../src/offers/identifiers.js';

async function setup(t, options = {}) {
  const db = database(); t.after(() => db.sqlite.close());
  await syncSnapshot(db, { commit: 'a'.repeat(40), records: Array.from({ length: 3 }, (_, i) => normalize(i === 2 ? options.category ?? 'cpu' : 'cpu', {
    opendb_id: randomUUID(), metadata: { name: `Private product ${i}` }, ...(i === 2 ? options.product : {}),
  }, 'a'.repeat(40))) });
  for (const productId of [1, 2]) await addLocalIdentifier(db, { productId, type: 'jan', value: ` ${JAN} `, evidence: 'test' });
  let clock = 1000000, fetches = 0;
  const entries = new Map(), logs = [], starts = [], waits = [];
  const cache = { async match(key) { return entries.get(key.url)?.clone(); }, async put(key, response) { entries.set(key.url, response.clone()); } };
  const env = { ...fakeLimiters({ unlimited: true }), CATALOG_CACHE_EPOCH: 'offers-test', YAHOO_SHOPPING_APP_ID: 'test-only-secret',
    DB: { prepare: sql => ({ bind: (...params) => ({ all: () => db.query(sql, params) }) }) } };
  const worker = createWorker({ cache, now: () => clock, log: e => logs.push(e), offerTimeoutMs: options.timeoutMs ?? 5000,
    offerSleep: async ms => { waits.push(ms); if (options.sleep) await options.sleep(ms); clock += ms; },
    offerFetch: async (...args) => { fetches++; starts.push(clock); return options.fetch ? options.fetch(...args) : Response.json(yahooBody([yahooHit()])); } });
  const request = (path = '/v1/products/1/offers', init) => worker.fetch(new Request(`https://catalog.example${path}`, init), env);
  return { db, env, entries, cache, logs, starts, waits, request, advance: ms => clock += ms, fetches: () => fetches };
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

test('no supported JAN or EAN-13 returns 200 unsupported without secret, limiter or upstream lookup', async t => {
  const h = await setup(t); delete h.env.YAHOO_SHOPPING_APP_ID;
  await addLocalIdentifier(h.db, { productId: 3, type: 'ean', value: '00123457', evidence: 'test' });
  await addLocalIdentifier(h.db, { productId: 3, type: 'jan', value: 'bad code', evidence: 'test' });
  const response = await h.request('/v1/products/3/offers'); assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { product: { id: 3, name: 'Private product 2' }, provider: 'yahoo',
    lookup: { status: 'unsupported', strategy: null, reason: 'no_supported_identifier' }, offers: [] });
  assert.equal(h.fetches(), 0); assert.equal(h.env.YAHOO_OFFER_MISS_LIMITER.calls.length, 0);
});

test('9800X3D EAN fallback returns only exact Yahoo matches; cached images/fetched_at and telemetry remain safe', async t => {
  const h = await setup(t, { product: ryzen9800, fetch: async input => {
    const url = new URL(input);
    assert.equal(url.searchParams.get('jan_code'), RYZEN_EAN);
    assert.equal(url.searchParams.get('image_size'), '300');
    return Response.json(yahooBody([
      yahooHit({ janCode: RYZEN_EAN }),
      ...[OTHER_JAN, undefined, '', 730143315289, '730143315289', '0730143315288', ` ${RYZEN_EAN} `]
        .map(janCode => yahooHit({ janCode, name: ryzen9800.metadata.name, price: 1 })),
    ]));
  } });
  const before = (await h.db.query('SELECT * FROM identifiers WHERE product_id=3')).results;
  const response = await h.request('/v1/products/3/offers');
  assert.equal(response.status, 200); assert.equal(response.headers.get('X-Cache'), 'MISS');
  const body = await response.json();
  assert.equal(body.product.name, 'AMD Ryzen 7 9800X3D');
  assert.deepEqual(body.lookup, { status: 'complete', strategy: 'ean13_as_jan', reason: null });
  assert.equal(body.offers.length, 1); assert.equal(body.offers[0].jan_code, RYZEN_EAN);
  assert.equal(body.offers[0].image.preferred.width, 300);
  assert.equal(body.offers[0].seller.image.id, 'example-seller-image');
  assert(!Object.hasOwn(body.offers[0], 'ean_code'));
  assert.equal(h.env.YAHOO_OFFER_MISS_LIMITER.calls.length, 1);
  assert.equal(h.fetches(), 1);
  assert.equal(h.logs.at(-1).lookup_candidate_count, 3);
  assert.equal(h.logs.at(-1).lookup_attempts, 1);
  assert.equal(h.logs.at(-1).lookup_hit_index, 1);
  h.advance(5000);
  const hit = await h.request('/v1/products/3/offers'); assert.equal(hit.headers.get('X-Cache'), 'HIT');
  assert.deepEqual(await hit.json(), body, 'HIT must preserve fetched_at and all image/seller metadata');
  assert.equal(h.fetches(), 1); assert.equal(h.env.YAHOO_OFFER_MISS_LIMITER.calls.length, 1);
  assert(h.logs.every(e => e.lookup_strategy === 'ean13_as_jan'));
  for (const value of [RYZEN_EAN, body.product.name, 'https://', h.env.YAHOO_SHOPPING_APP_ID]) assert(!JSON.stringify(h.logs).includes(value));
  assert.deepEqual((await h.db.query('SELECT * FROM identifiers WHERE product_id=3')).results, before);
});

test('JAN overrides EAN in the endpoint; same-value EAN strategy cannot HIT a JAN cache entry', async t => {
  const product = { ...ryzen9800, identifiers: { version: 1, identifiers: [{ type: 'ean', value: JAN, region: 'all' }] } };
  const h = await setup(t, { product });
  await addLocalIdentifier(h.db, { productId: 1, type: 'ean', value: RYZEN_EAN, evidence: 'test' });
  const first = await h.request(); assert.equal((await first.json()).lookup.strategy, 'jan');
  h.advance(1000);
  const fallback = await h.request('/v1/products/3/offers');
  assert.equal(fallback.headers.get('X-Cache'), 'MISS');
  assert.equal((await fallback.json()).lookup.strategy, 'ean13_as_jan');
  assert.equal(h.fetches(), 2); assert.equal(h.env.YAHOO_OFFER_MISS_LIMITER.calls.length, 2);
});

test('EAN mismatch-only results are empty complete Offers, not name/MPN fallback', async t => {
  const h = await setup(t, { product: ryzen9800, fetch: async () => Response.json(yahooBody([
    yahooHit({ janCode: OTHER_JAN, name: 'AMD Ryzen 7 9800X3D 100-100001084WOF' }),
  ])) });
  const response = await h.request('/v1/products/3/offers'); assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.lookup, { status: 'complete', strategy: 'ean13_as_jan', reason: null });
  assert.deepEqual(body.offers, []);
});

test('image metadata is cached with Offers, old cache generation is ignored and image URLs are never fetched or logged', async t => {
  const h = await setup(t, { fetch: async input => {
    const url = new URL(input);
    assert.equal(url.hostname, 'shopping.yahooapis.jp', 'only ItemSearch may be fetched');
    assert.equal(url.searchParams.get('image_size'), '300');
    return Response.json(yahooBody([yahooHit()]));
  } });
  const policy = offerCachePolicy(new URL('https://catalog.example'), { strategy: 'jan', value: JAN }, h.env);
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
    await addLocalIdentifier(h.db, { productId: 1, type: 'jan', value: OTHER_JAN, evidence: 'test' });
    if (mode === 'missing') delete h.env.YAHOO_OFFER_MISS_LIMITER;
    else h.env.YAHOO_OFFER_MISS_LIMITER.limit = async () => {
      if (mode === 'throw') throw Error('private limiter');
      return mode === 'malformed' ? {} : { success: false };
    };
    const response = await h.request(); assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, mode === 'deny' ? 'OFFER_PROVIDER_RATE_LIMITED' : 'OFFER_PROVIDER_UNAVAILABLE');
    assert.equal(h.logs.at(-1).rate_limit_class, 'yahoo_offer_miss'); assert.equal(h.fetches(), 0);
    assert.equal(h.logs.at(-1).lookup_attempts, 1);
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
    ['network', async () => { throw Error('private upstream'); }, 503, 'OFFER_PROVIDER_UNAVAILABLE'],
    ['upstream_429', async () => new Response('private upstream', { status: 429, headers: { 'Retry-After': '120' } }), 503, 'OFFER_PROVIDER_RATE_LIMITED'],
    ['upstream_5xx', async () => new Response('private upstream', { status: 500 }), 503, 'OFFER_PROVIDER_UNAVAILABLE'],
    ['upstream_4xx', async () => new Response('private upstream', { status: 403 }), 502, 'OFFER_PROVIDER_ERROR'],
    ['invalid_json', async () => new Response('private upstream'), 502, 'OFFER_PROVIDER_ERROR'],
    ['malformed_response', async () => Response.json({}), 502, 'OFFER_PROVIDER_ERROR'],
    ['upstream_status', async () => Response.json(yahooBody([]), { status: 201 }), 502, 'OFFER_PROVIDER_ERROR'],
  ];
  for (const [reason, fetch, status, code] of cases) {
    const h = await setup(t, { fetch, timeoutMs: 20 });
    await addLocalIdentifier(h.db, { productId: 1, type: 'jan', value: OTHER_JAN, evidence: 'test' });
    if (!fetch) delete h.env.YAHOO_SHOPPING_APP_ID;
    const response = await h.request(); assert.equal(response.status, status, reason);
    const body = await response.json(); assert.equal(body.error.code, code);
    assert.equal(body.request_id, response.headers.get('X-Request-ID'));
    assert.equal(response.headers.get('X-Cache'), 'BYPASS');
    assert.equal(response.headers.get('X-Cache-TTL'), null);
    assert.equal(h.logs.at(-1).provider_error_reason, reason);
    assert.equal(h.fetches(), fetch ? 1 : 0);
    assert.equal(h.logs.at(-1).lookup_attempts, 1);
    assert.equal(h.logs.at(-1).lookup_hit_index, 0);
    assert.deepEqual(h.waits, []);
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

test('A3-mATX White Wood Mesh canonical EAN #2 hits; empty and nonempty candidate caches are reused', async t => {
  const queried = [];
  const h = await setup(t, { category: 'case', product: a3WhiteWoodMesh, fetch: async input => {
    const url = new URL(input), code = url.searchParams.get('jan_code');
    queried.push(code);
    assert.equal(url.searchParams.has('query'), false);
    return Response.json(yahooBody(code === A3_FIRST_EAN ? [] : [yahooHit({ janCode: A3_YAHOO_EAN })]));
  } });
  const before = (await h.db.query('SELECT * FROM identifiers WHERE product_id=3')).results;
  assert.deepEqual(selectYahooLookupCandidates(canonicalIdentifiers(before)).map(c => c.value), [A3_FIRST_EAN, A3_YAHOO_EAN]);
  const response = await h.request('/v1/products/3/offers'), body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.lookup, { status: 'complete', strategy: 'ean13_as_jan', reason: null });
  assert.equal(body.product.name, a3WhiteWoodMesh.metadata.name);
  assert.equal(body.offers.length, 1); assert.equal(body.offers[0].jan_code, A3_YAHOO_EAN);
  assert.equal(body.offers[0].image.preferred.width, 300);
  assert.equal(body.offers[0].seller.image.id, 'example-seller-image');
  assert.deepEqual(queried, [A3_FIRST_EAN, A3_YAHOO_EAN]);
  assert.deepEqual(h.waits, [1000]); assert.equal(h.starts[1] - h.starts[0], 1000);
  assert.equal(h.env.YAHOO_OFFER_MISS_LIMITER.calls.length, 2);
  const event = h.logs.at(-1);
  assert.equal(event.lookup_candidate_count, 2); assert.equal(event.lookup_attempts, 2); assert.equal(event.lookup_hit_index, 2);
  const emptyPolicy = offerCachePolicy(new URL('https://catalog.example'), { strategy: 'ean13_as_jan', value: A3_FIRST_EAN }, h.env);
  assert.deepEqual(await h.entries.get(emptyPolicy.key.url).clone().json(), []);
  h.advance(5000);
  // Both candidate HITs must work without credentials or a limiter binding.
  delete h.env.YAHOO_SHOPPING_APP_ID; delete h.env.YAHOO_OFFER_MISS_LIMITER;
  const cached = await h.request('/v1/products/3/offers');
  assert.equal(cached.headers.get('X-Cache'), 'HIT'); assert.equal(cached.headers.get('Age'), '5');
  assert.deepEqual(await cached.json(), body); assert.equal(h.fetches(), 2);
  assert.equal(h.logs.at(-1).lookup_attempts, 2); assert.equal(h.logs.at(-1).rate_limit_status, 'not_checked');
  for (const privateValue of [A3_FIRST_EAN, A3_YAHOO_EAN, body.product.name, 'https://', 'test-only-secret']) {
    assert(!JSON.stringify(h.logs).includes(privateValue));
  }
  assert.deepEqual((await h.db.query('SELECT * FROM identifiers WHERE product_id=3')).results, before);
});

const fallbackCodes = [JAN, RYZEN_EAN, A3_FIRST_EAN, A3_YAHOO_EAN];
const fallbackProduct = { identifiers: { version: 1, identifiers: fallbackCodes.map(value => ({ type: 'ean', value, region: 'all' })) } };

for (const hitIndex of [1, 2, 3, 4, 0]) {
  test(`bounded fallback: hit at ${hitIndex || 'none'}, at most three requests and no Offer union`, async t => {
    const queried = [];
    const h = await setup(t, { product: fallbackProduct, fetch: async input => {
      const value = new URL(input).searchParams.get('jan_code'); queried.push(value);
      const hits = value === fallbackCodes[hitIndex - 1]
        ? [yahooHit({ janCode: value }), yahooHit({ janCode: value, code: 'second-listing' })]
        : [undefined, null, Number(value), ` ${value} `, value.slice(1), OTHER_JAN].map(janCode => yahooHit({ janCode }));
      return Response.json(yahooBody(hits));
    } });
    const response = await h.request('/v1/products/3/offers'), body = await response.json();
    const attempts = hitIndex > 0 && hitIndex <= 3 ? hitIndex : 3;
    assert.equal(response.status, 200); assert.equal(body.offers.length, hitIndex > 0 && hitIndex <= 3 ? 2 : 0);
    assert(body.offers.every(o => o.jan_code === fallbackCodes[hitIndex - 1]));
    assert.deepEqual(queried, fallbackCodes.slice(0, attempts));
    assert.equal(h.env.YAHOO_OFFER_MISS_LIMITER.calls.length, attempts);
    assert.equal(h.logs.at(-1).lookup_candidate_count, 3); assert.equal(h.logs.at(-1).lookup_attempts, attempts);
    assert.equal(h.logs.at(-1).lookup_hit_index, hitIndex > 0 && hitIndex <= 3 ? hitIndex : 0);
    assert.deepEqual(h.waits, Array(attempts - 1).fill(1000));
    for (let i = 1; i < h.starts.length; i++) assert(h.starts[i] - h.starts[i - 1] >= 1000);
    const cached = await h.request('/v1/products/3/offers');
    assert.equal(cached.headers.get('X-Cache'), 'HIT'); assert.deepEqual(await cached.json(), body);
    assert.equal(h.fetches(), attempts); assert.equal(h.env.YAHOO_OFFER_MISS_LIMITER.calls.length, attempts);
  });
}

test('cached empty JAN advances to EAN MISS, uses one token, and does not queue its first external request', async t => {
  const h = await setup(t, { fetch: async input => Response.json(yahooBody([yahooHit({ janCode: new URL(input).searchParams.get('jan_code') })])) });
  await addLocalIdentifier(h.db, { productId: 1, type: 'ean', value: RYZEN_EAN, evidence: 'test' });
  const policy = offerCachePolicy(new URL('https://catalog.example'), { strategy: 'jan', value: JAN }, h.env);
  await writeSearchCache(h.cache, policy.key, '[]', policy.ttl, 1000000);
  const response = await h.request();
  assert.equal(response.status, 200); assert.equal((await response.json()).lookup.strategy, 'ean13_as_jan');
  assert.equal(h.fetches(), 1); assert.equal(h.env.YAHOO_OFFER_MISS_LIMITER.calls.length, 1); assert.deepEqual(h.waits, []);
  // Only the empty JAN is cached now; a separate request cannot wait out the interval.
  for (const key of h.entries.keys()) if (key.includes('strategy=ean13_as_jan')) h.entries.delete(key);
  const denied = await h.request();
  assert.equal(denied.status, 503); assert.equal(h.logs.at(-1).provider_error_reason, 'pacing');
  assert.equal(h.fetches(), 1); assert.deepEqual(h.waits, []);
});

test('a later candidate protection failure terminates the chain, releases admission and never tries #3', async t => {
  for (const failure of ['deny', 'missing', 'throw', 'malformed']) {
    const h = await setup(t, { product: fallbackProduct, fetch: async () => Response.json(yahooBody([])) });
    let calls = 0;
    h.env.YAHOO_OFFER_MISS_LIMITER.limit = async () => {
      if (++calls === 1) {
        if (failure === 'missing') delete h.env.YAHOO_OFFER_MISS_LIMITER;
        return { success: true };
      }
      if (failure === 'throw') throw Error('private protection');
      return failure === 'malformed' ? {} : { success: false };
    };
    const response = await h.request('/v1/products/3/offers');
    assert.equal(response.status, 503); assert.equal(h.fetches(), 1);
    assert.equal(h.logs.at(-1).lookup_attempts, 2);
    assert.equal(h.logs.at(-1).provider_error_reason, failure === 'deny' ? 'miss_budget' : 'protection');
    h.env.YAHOO_OFFER_MISS_LIMITER = fakeLimiters({ unlimited: true }).YAHOO_OFFER_MISS_LIMITER;
    assert.equal((await h.request('/v1/products/3/offers')).status, 200);
    assert.equal(h.fetches(), 3);
  }
});

test('provider failures at candidate #2 never fall through to #3 or cache the failed candidate', async t => {
  const failures = [
    ['timeout', () => new Promise(() => {})],
    ['network', async () => { throw Error('private upstream'); }],
    ['upstream_429', async () => new Response('', { status: 429 })],
    ['upstream_4xx', async () => new Response('', { status: 403 })],
    ['upstream_5xx', async () => new Response('', { status: 503 })],
    ['invalid_json', async () => new Response('invalid')],
    ['malformed_response', async () => Response.json({})],
  ];
  for (const [reason, fail] of failures) {
    let calls = 0;
    const h = await setup(t, { product: fallbackProduct, timeoutMs: 20,
      fetch: async () => ++calls === 1 ? Response.json(yahooBody([])) : fail() });
    const response = await h.request('/v1/products/3/offers');
    assert(response.status >= 500); assert.equal(h.fetches(), 2, reason);
    assert.equal(h.env.YAHOO_OFFER_MISS_LIMITER.calls.length, 2);
    assert.equal(h.logs.at(-1).lookup_attempts, 2); assert.equal(h.logs.at(-1).provider_error_reason, reason);
    assert.equal([...h.entries.keys()].filter(k => k.includes('/offers/')).length, 1);
  }
});

test('concurrent cold candidate chains coalesce both external requests without duplicating waits or tokens', async t => {
  let release, entered;
  const started = new Promise(resolve => entered = resolve);
  const h = await setup(t, { product: fallbackProduct, fetch: async input => {
    const code = new URL(input).searchParams.get('jan_code');
    if (code === JAN) { entered(); await new Promise(resolve => release = resolve); }
    return Response.json(yahooBody(code === JAN ? [] : [yahooHit({ janCode: code })]));
  } });
  await h.request('/v1/products/3');
  const first = h.request('/v1/products/3/offers'); await started;
  const followers = Array.from({ length: 5 }, () => h.request('/v1/products/3/offers'));
  await new Promise(resolve => setImmediate(resolve)); release();
  const responses = await Promise.all([first, ...followers]);
  assert(responses.every(r => r.status === 200));
  assert.equal(h.fetches(), 2); assert.equal(h.env.YAHOO_OFFER_MISS_LIMITER.calls.length, 2);
  assert.deepEqual(h.waits, [1000]);
});

test('fallback pacing reserves only its chain: unrelated MISS bursts reject while cache HIT and coalescing work', async t => {
  let release, entered;
  const waiting = new Promise(resolve => entered = resolve);
  const h = await setup(t, { product: fallbackProduct,
    sleep: async () => { entered(); await new Promise(resolve => release = resolve); },
    fetch: async input => {
      const code = new URL(input).searchParams.get('jan_code');
      return Response.json(yahooBody(code === JAN ? [] : [yahooHit({ janCode: code })]));
    },
  });
  await addLocalIdentifier(h.db, { productId: 1, type: 'ean', value: OTHER_JAN, evidence: 'test' });
  // Warm Detail separately from the Yahoo pacing being tested.
  for (const id of [1, 2, 3]) await h.request(`/v1/products/${id}`);
  const first = h.request('/v1/products/3/offers'); await waiting;
  const parallel = h.request('/v1/products/3/offers');
  const burst = await Promise.all(Array.from({ length: 10 }, () => h.request()));
  assert(burst.every(r => r.status === 503)); assert.equal(h.fetches(), 1);
  assert.equal(h.env.YAHOO_OFFER_MISS_LIMITER.calls.length, 1);
  // Different product, same cached EAN value, bypasses reserved external admission.
  const policy = offerCachePolicy(new URL('https://catalog.example'), { strategy: 'jan', value: JAN }, h.env);
  await writeSearchCache(h.cache, policy.key, '[]', policy.ttl, 1000000);
  const hit = await h.request('/v1/products/2/offers');
  assert.equal(hit.status, 200); assert.equal(hit.headers.get('X-Cache'), 'HIT');
  release();
  const responses = await Promise.all([first, parallel]);
  assert(responses.every(r => r.status === 200));
  assert.deepEqual(await responses[0].json(), await responses[1].json());
  assert.equal(h.fetches(), 2); assert.equal(h.env.YAHOO_OFFER_MISS_LIMITER.calls.length, 2);
  assert.deepEqual(h.waits, [1000]); assert(h.logs.some(e => e.offer_coalesced));
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
