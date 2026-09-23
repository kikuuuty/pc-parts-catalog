import test from 'node:test';
import assert from 'node:assert/strict';
import { selectJan, validJan } from '../src/offers/identifiers.js';
import { canonicalIdentifiers } from '../src/product-detail.js';
import { normalizeYahooOffers, fetchYahooOffers, yahooShops } from '../src/offers/yahoo-shopping.js';
import { offerCacheTtl } from '../src/offers/cache.js';
import { yahooHit, yahooBody, JAN, OTHER_JAN } from '../test-support/yahoo.js';

test('JAN validation preserves leading zero, validates check digit and never coerces barcode types', () => {
  for (const code of [JAN, OTHER_JAN, '00123457', ` ${JAN} `]) assert(validJan(code), code);
  for (const code of [null, 1234567890128, '', '00000000', '00123456', '0012345678901',
    '０１２３４５６７', '0012-3457', '0012 3457', '123456789012', '00012345678905']) assert(!validJan(code));
  assert.equal(selectJan([{ type: 'ean', value: JAN, region: 'jp' }]), null);
  assert.equal(selectJan([{ type: 'jan', value: JAN, region: 'us' }]), null);
  assert.equal(selectJan([{ type: 'jan', value: ` ${JAN} `, region: 'all' }]), JAN);
  assert.equal(selectJan([]), null);
});

test('canonical provenance selection is deterministic: jp before all, local before upstream, lexical value', () => {
  const row = (value, region, origin) => ({ type: 'jan', value, region, origin, origin_field: 'identifiers' });
  const rows = [row(OTHER_JAN, 'jp', 'upstream'), row(JAN, 'all', 'local'), row(JAN, 'jp', 'upstream'), row(OTHER_JAN, 'jp', 'local')];
  for (const order of [rows, [...rows].reverse(), [rows[2], rows[0], rows[3], rows[1]]]) {
    assert.equal(selectJan(canonicalIdentifiers(order)), OTHER_JAN);
  }
  assert.equal(selectJan(canonicalIdentifiers([row(OTHER_JAN, 'jp', 'upstream'), row(JAN, 'jp', 'upstream')])), JAN);
});

test('Yahoo normalization keeps all shops, exact JAN, price order, shipping classifications and deterministic duplicates', () => {
  const hits = [yahooHit({ price: 300 }), yahooHit({ price: 300 }),
    yahooHit({ code: 'other', price: 200, seller: { sellerId: 'unknown', name: 'Unknown store', isBestSeller: false } }),
    yahooHit({ code: 'second', price: 200, shipping: { code: 3, name: '条件付き送料無料' } }),
    yahooHit({ code: 'wrong', price: 1, janCode: OTHER_JAN }), yahooHit({ janCode: '' }),
    yahooHit({ janCode: undefined }), yahooHit({ janCode: 1234567890128 }),
    yahooHit({ inStock: false }), yahooHit({ condition: 'used' })];
  const offers = normalizeYahooOffers(yahooBody(hits), JAN, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(offers.map(o => o.price), [200, 200, 300]);
  assert.deepEqual(offers.map(o => o.provider_item_id), ['second', 'other', 'tsukumo-y_item']);
  assert.equal(offers[0].seller.shop_key, 'tsukumo');
  assert.equal(offers[0].seller.name, 'ツクモ パソコン Yahoo!店');
  assert.equal(offers[1].seller.id, 'unknown');
  assert(!Object.hasOwn(offers[1].seller, 'shop_key'));
  assert.deepEqual(offers[0].shipping, { code: 3, name: '条件付き送料無料' });
  assert.deepEqual(offers[2].shipping, { code: 2, name: '送料無料' });
  assert.deepEqual(offers, normalizeYahooOffers(yahooBody([...hits].reverse()), JAN, '2026-01-01T00:00:00.000Z'));
  assert(!/shipping_fee|total_price|effective_price|point|description/.test(JSON.stringify(offers)));
  const separate = [yahooHit(), yahooHit({ code: 'different' }), yahooHit({ url: 'https://store.shopping.yahoo.co.jp/tsukumo-y/another.html' })];
  assert.equal(normalizeYahooOffers(yahooBody(separate), JAN, 'now').length, 3);
  assert.deepEqual(normalizeYahooOffers(yahooBody([]), JAN, 'now'), []);
  assert.equal(normalizeYahooOffers(yahooBody(Array.from({ length: 50 }, (_, i) => yahooHit({ code: `item-${i}` }))), JAN, 'now').length, 50);
  for (const [sellerId, shopKey] of Object.entries(yahooShops)) {
    const [offer] = normalizeYahooOffers(yahooBody([yahooHit({ seller: { sellerId, name: 'Shop' } })]), JAN, 'now');
    assert.equal(offer.seller.shop_key, shopKey);
  }
});

test('malformed response is not a successful empty result or an invented price', () => {
  for (const body of [null, [], {}, { hits: [] }, yahooBody([null]), { ...yahooBody([]), totalResultsReturned: 1 },
    yahooBody(Array.from({ length: 51 }, () => yahooHit())),
    ...[{ price: '100' }, { price: 0 }, { price: -1 }, { price: 1.5 }, { seller: {} }, { condition: undefined },
      { url: 'javascript:alert(1)' }, { name: '' }].map(change => yahooBody([yahooHit(change)]))]) {
    assert.throws(() => normalizeYahooOffers(body, JAN, 'now'), { reason: 'malformed_response' });
  }
});

test('Yahoo transport uses URL encoding, required filters, timeout signal, no redirects and no seller filter', async () => {
  const appId = 'test-only & + secret';
  const offers = await fetchYahooOffers({ appId, jan: JAN, now: () => 0, fetch: async (input, init) => {
    const url = new URL(input);
    assert.equal(url.origin + url.pathname, 'https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch');
    assert.deepEqual(Object.fromEntries(url.searchParams), { appid: appId, jan_code: JAN, results: '50', in_stock: 'true', condition: 'new', sort: '+price', image_size: '300' });
    assert.match(url.search, /sort=%2Bprice/);
    assert.equal(init.redirect, 'manual'); assert(init.signal instanceof AbortSignal);
    return Response.json(yahooBody([yahooHit()]));
  } });
  assert.equal(offers[0].fetched_at, '1970-01-01T00:00:00.000Z');
  assert(!JSON.stringify(offers).includes(appId));
});

test('product images preserve IDs, reference URLs and actual preferred dimensions in the common contract', () => {
  const hit = yahooHit();
  const [offer] = normalizeYahooOffers(yahooBody([hit]), JAN, 'now');
  assert.deepEqual(offer.image, {
    id: 'example-product-image',
    small: { url: hit.image.small, width: 76, height: 76 },
    medium: { url: hit.image.medium, width: 146, height: 146 },
    preferred: { url: hit.exImage.url, width: 300, height: 300 },
  });
  const url = 'https://images.example.net/original%2Fimage.jpg?height=240&width=320';
  const [actual] = normalizeYahooOffers(yahooBody([yahooHit({ exImage: { url, width: 320, height: 240 } })]), JAN, 'now');
  assert.deepEqual(actual.image.preferred, { url, width: 320, height: 240 });
  assert(!/imageId|exImage/.test(JSON.stringify(offer)), 'Yahoo field names stay in the mapper');
});

test('missing product image variants or URLs do not discard the price Offer or invent a preferred image', () => {
  const small = { url: yahooHit().image.small, width: 76, height: 76 };
  for (const [changes, expected] of [
    [{ exImage: undefined }, { id: 'example-product-image', small, medium: { url: yahooHit().image.medium, width: 146, height: 146 }, preferred: null }],
    [{ imageId: undefined, image: { small: small.url }, exImage: undefined }, { id: null, small, medium: null, preferred: null }],
    [{ image: undefined, exImage: undefined }, { id: 'example-product-image', small: null, medium: null, preferred: null }],
    [{ imageId: undefined, image: undefined, exImage: undefined }, { id: null, small: null, medium: null, preferred: null }],
  ]) {
    const offers = normalizeYahooOffers(yahooBody([yahooHit(changes)]), JAN, 'now');
    assert.equal(offers.length, 1); assert.equal(offers[0].price, 69800);
    assert.deepEqual(offers[0].image, expected);
  }
});

test('empty or invalid image URLs become null; invalid or missing dimensions remain unknown', () => {
  for (const url of ['', '  ', null, 123, 'not-a-url', 'javascript:alert(1)', 'data:image/png;base64,test', 'https://user:password@example.net/image']) {
    const [offer] = normalizeYahooOffers(yahooBody([yahooHit({ imageId: '', image: { small: url, medium: url }, exImage: { url, width: 300, height: 300 } })]), JAN, 'now');
    assert.deepEqual(offer.image, { id: null, small: null, medium: null, preferred: null });
  }
  for (const dimension of [undefined, null, 0, -1, 1.5, '300', Number.MAX_SAFE_INTEGER + 1]) {
    const url = yahooHit().exImage.url;
    const [offer] = normalizeYahooOffers(yahooBody([yahooHit({ exImage: { url, width: dimension, height: 240 } })]), JAN, 'now');
    assert.deepEqual(offer.image.preferred, { url, width: null, height: 240 });
  }
  const [unknown] = normalizeYahooOffers(yahooBody([yahooHit({ exImage: { url: yahooHit().exImage.url } })]), JAN, 'now');
  assert.deepEqual(unknown.image.preferred, { url: yahooHit().exImage.url, width: null, height: null });
});

test('seller image ID is opaque and never converted to a URL; absence is nullable', () => {
  for (const imageId of ['example-seller-image', 'https://example.net/not-a-logo-url', undefined, null, '', ' ', 123]) {
    const hit = yahooHit(); hit.seller.imageId = imageId;
    const [offer] = normalizeYahooOffers(yahooBody([hit]), JAN, 'now');
    assert.deepEqual(offer.seller.image, { id: typeof imageId === 'string' && imageId.trim() ? imageId : null, url: null });
    assert.equal(offer.price, 69800);
  }
});

test('transport classifies missing secret, HTTP failures, invalid JSON, malformed data and network failures', async () => {
  const cases = [
    [400, 'upstream_4xx', 502, 'OFFER_PROVIDER_ERROR'], [403, 'upstream_4xx', 502, 'OFFER_PROVIDER_ERROR'],
    [429, 'upstream_429', 503, 'OFFER_PROVIDER_RATE_LIMITED'], [500, 'upstream_5xx', 503, 'OFFER_PROVIDER_UNAVAILABLE'],
  ];
  for (const [upstream, reason, status, code] of cases) {
    const event = {};
    await assert.rejects(fetchYahooOffers({ appId: 'test-secret', jan: JAN, event,
      fetch: async () => new Response('private body', { status: upstream, headers: { 'Retry-After': '120' } }),
    }), error => error.reason === reason && error.status === status && error.code === code && !error.message.includes('private'));
    assert.equal(event.upstream_status_class, `${Math.floor(upstream / 100)}xx`);
    assert(event.upstream_duration_ms >= 0);
  }
  for (const value of ['private', '-5', '99999', 'Wed, 01 Jan 2025 00:00:00 GMT']) {
    await assert.rejects(fetchYahooOffers({ appId: 'test-secret', jan: JAN,
      fetch: async () => new Response('', { status: 429, headers: { 'Retry-After': value } }),
    }), { retryAfter: 60 });
  }
  await assert.rejects(fetchYahooOffers({ jan: JAN, fetch() { assert.fail('must not fetch'); } }), { reason: 'missing_app_id' });
  await assert.rejects(fetchYahooOffers({ appId: 'test', jan: JAN, fetch: async () => new Response('{') }), { reason: 'invalid_json' });
  await assert.rejects(fetchYahooOffers({ appId: 'test', jan: JAN, fetch: async () => Response.json({}) }), { reason: 'malformed_response' });
  await assert.rejects(fetchYahooOffers({ appId: 'test', jan: JAN, fetch: async () => { throw Error('secret URL'); } }), { reason: 'network' });
});

test('Yahoo redirects are rejected without following Location or exposing it, using workerd-compatible manual mode', async () => {
  let calls = 0;
  for (const status of [301, 302, 307, 308]) {
    await assert.rejects(fetchYahooOffers({ appId: 'test-only-secret', jan: JAN, fetch: async (url, init) => {
      calls++;
      assert.equal(init.redirect, 'manual');
      assert.equal(new URL(url).hostname, 'shopping.yahooapis.jp');
      return new Response('', { status, headers: { Location: 'https://untrusted.example/redirect?appid=test-only-secret' } });
    } }), error => error.reason === 'upstream_status' && error.status === 502 && !/https:|test-only-secret/.test(error.message));
  }
  assert.equal(calls, 4, 'one request per attempt; no automatic redirect/retry');
});

test('timeout covers both fetch and response body, even for a transport ignoring cancellation', async () => {
  for (const bodyStalls of [false, true]) {
    let signal;
    await assert.rejects(fetchYahooOffers({ appId: 'test', jan: JAN, timeoutMs: 10, fetch: async (_, init) => {
      signal = init.signal;
      return bodyStalls ? { ok: true, status: 200, json: () => new Promise(() => {}) } : new Promise(() => {});
    } }), { reason: 'timeout', status: 503 });
    assert(signal.aborted);
  }
});

test('offer TTL validation defaults to 30 minutes and accepts only integer seconds within 60..3600', () => {
  assert.equal(offerCacheTtl(), 1800);
  for (const value of ['60', '1800', '3600']) assert.equal(offerCacheTtl(value), Number(value));
  for (const value of ['', '0', '59', '3601', '-1', 'NaN', '1e3', '1800.1', null]) assert.equal(offerCacheTtl(value), null);
});
