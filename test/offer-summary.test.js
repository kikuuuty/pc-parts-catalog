import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { database } from '../test-support/database.js';
import { fakeLimiters } from '../test-support/rate-limiter.js';
import { JAN, OTHER_JAN, RYZEN_EAN, A3_FIRST_EAN, A3_YAHOO_EAN, a3WhiteWoodMesh, yahooBody, yahooHit } from '../test-support/yahoo.js';
import { normalize } from '../src/normalize.js';
import { syncSnapshot } from '../src/sync.js';
import { createWorker } from '../src/worker.js';
import { summarizeOffers, summaryPolicy, summaryRecord, summaryUpsertQuery, summaryLookupQuery,
  loadOfferSummaries, createSummaryWriter } from '../src/offers/summary.js';

const endpoint = '/v1/products/offers/summary';
const blank = (id, status = 'pending') => ({ id, status, lowest_price: null, offer_count: null, fetched_at: null });

async function setup(t, options = {}) {
  const db = database(); t.after(() => db.sqlite.close());
  await syncSnapshot(db, { commit: 'a'.repeat(40), records: Array.from({ length: 25 }, (_, i) =>
    normalize(i === 3 ? 'case' : 'cpu', i === 3 ? a3WhiteWoodMesh : {
      opendb_id: randomUUID(), metadata: { name: `Summary private product ${i + 1}` },
      identifiers: { version: 1, identifiers: i === 2 ? [] : [{ type: 'jan', value: i === 0 ? JAN : OTHER_JAN, region: 'jp' }] },
    }, 'a'.repeat(40))) });
  const products = (await db.query('SELECT * FROM products ORDER BY id')).results;
  let clock = 1000000, fetches = 0;
  const entries = new Map(), logs = [], statements = [];
  const cache = { async match(key) { return entries.get(key.url)?.clone(); }, async put(key, value) { entries.set(key.url, value.clone()); } };
  const env = { ...fakeLimiters({ unlimited: true }), CATALOG_CACHE_EPOCH: 'summary-test', YAHOO_SHOPPING_APP_ID: 'test-only-secret',
    DB: { prepare: sql => ({ bind: (...params) => ({ all: async () => {
      statements.push({ sql, params });
      if (options.execute) return options.execute(db, sql, params);
      return db.query(sql, params);
    } }) }) } };
  const newWorker = () => createWorker({ cache, now: () => clock, log: e => logs.push(e), offerSleep: async ms => { clock += ms; },
    offerFetch: async input => { fetches++; return options.fetch ? options.fetch(input) : Response.json(yahooBody([yahooHit()])); } });
  let worker = newWorker();
  const request = (path, init) => worker.fetch(new Request(`https://catalog.example${path}`, init), env);
  const bulk = ids => request(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ product_ids: ids }) });
  const execute = async (sql, params) => (await db.query(sql, params)).results;
  const store = async (id, resolution, policy = summaryPolicy(env)) => {
    const row = summaryRecord(products[id - 1], resolution, policy), q = summaryUpsertQuery(row);
    await execute(q.sql, q.params); return row;
  };
  const resolution = (prices, changes = {}) => ({ offers: prices.map(price => ({ price })), lookupStrategy: 'jan',
    fetchedAt: clock, observedAt: clock, expiresAt: clock + 1800000, ...changes });
  return { db, products, env, cache, entries, logs, statements, request, bulk, execute, store, resolution,
    now: () => clock, advance: ms => clock += ms, fetches: () => fetches, restart: () => { worker = newWorker(); } };
}

test('summary generation computes an explicit positive-integer minimum/count for one, many and empty Offers', () => {
  assert.deepEqual(summarizeOffers([{ price: 99 }]), { status: 'complete', lowest_price: 99, offer_count: 1 });
  const offers = [{ price: 500 }, { price: 80 }, { price: 200 }, { price: 80 }], before = structuredClone(offers);
  assert.deepEqual(summarizeOffers(offers), { status: 'complete', lowest_price: 80, offer_count: 4 });
  assert.deepEqual(offers, before);
  assert.deepEqual(summarizeOffers([]), { status: 'empty', lowest_price: null, offer_count: 0 });
  for (const price of [0, -1, 1.5, '20', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, undefined]) {
    assert.throws(() => summarizeOffers([{ price: 1 }, { price }]));
  }
  assert.throws(() => summarizeOffers(null));
  assert.throws(() => summarizeOffers(Array.from({ length: 51 }, () => ({ price: 1 }))));
});

test('storage persists complete, empty and unsupported with no barcode, history, seller or raw Offers', async t => {
  const h = await setup(t);
  await h.store(1, h.resolution([90, 70]));
  await h.store(2, h.resolution([]));
  await h.store(3, { unsupported: true, observedAt: h.now() });
  const rows = (await h.db.query('SELECT * FROM product_offer_summary ORDER BY product_id')).results;
  assert.deepEqual(rows.map(r => [r.status, r.lowest_price, r.offer_count]), [['complete', 70, 2], ['empty', null, 0], ['unsupported', null, 0]]);
  assert.equal(rows[2].fetched_at, null); assert.equal(rows[2].lookup_strategy, null);
  assert.equal(rows[0].fetched_at, new Date(h.now()).toISOString());
  assert(rows.every(r => r.expires_at === h.now() + 1800000));
  assert(!JSON.stringify(rows).includes(JAN));
  const columns = (await h.db.query('PRAGMA table_info(product_offer_summary)')).results.map(r => r.name);
  assert(!columns.some(c => /identifier|seller|offers|url/.test(c)));
});

test('current-row upsert replaces the same product/provider, rejects older results and cascades hard deletes', async t => {
  const h = await setup(t);
  const old = await h.store(1, h.resolution([90]));
  h.advance(1000); await h.store(1, h.resolution([80, 100]));
  const q = summaryUpsertQuery(old); await h.execute(q.sql, q.params);
  const rows = await h.execute('SELECT * FROM product_offer_summary');
  assert.equal(rows.length, 1); assert.equal(rows[0].lowest_price, 80); assert.equal(rows[0].offer_count, 2);
  h.db.sqlite.exec('DELETE FROM products WHERE id=1');
  assert.equal((await h.execute('SELECT * FROM product_offer_summary')).length, 0);
});

test('a refreshed winning candidate updates the price even when an earlier empty candidate keeps the same expiry', async t => {
  const h = await setup(t), observedAt = h.now(), expiresAt = h.now() + 1800000;
  h.advance(1000);
  const old = await h.store(1, h.resolution([90], { observedAt, expiresAt }));
  h.advance(1000); await h.store(1, h.resolution([70, 80], { observedAt, expiresAt }));
  const oldQuery = summaryUpsertQuery(old); await h.execute(oldQuery.sql, oldQuery.params);
  const rows = await h.execute('SELECT * FROM product_offer_summary');
  assert.equal(rows.length, 1); assert.equal(rows[0].lowest_price, 70); assert.equal(rows[0].offer_count, 2);
  assert.equal(rows[0].expires_at, expiresAt); assert.equal(rows[0].fetched_at, new Date(h.now()).toISOString());
});

test('expired, future, wrong epoch/generation/TTL and missing epoch summaries never expose stale prices', async t => {
  const h = await setup(t), policy = summaryPolicy(h.env);
  await h.store(1, h.resolution([50]));
  for (const changed of [{ ...policy, epoch: 'next-release' }, { ...policy, generation: 'next-generation' },
    { ...policy, ttl: 60 }, { ...policy, epoch: null }]) {
    assert.deepEqual((await loadOfferSummaries(h.execute, [1], changed, h.now())).products, [blank(1)]);
  }
  assert.deepEqual((await loadOfferSummaries(h.execute, [1], policy, h.now() - 1)).products, [blank(1)]);
  h.advance(1799999); assert.equal((await (await h.bulk([1])).json()).products[0].status, 'complete');
  h.advance(1); assert.deepEqual((await (await h.bulk([1])).json()).products, [blank(1)]);
  h.env.YAHOO_OFFERS_CACHE_TTL_SECONDS = 'invalid';
  assert.equal((await h.bulk([1])).status, 503);
});

test('empty/unsupported also expire and catalog epoch changes invalidate all stored states', async t => {
  const h = await setup(t);
  await h.store(1, h.resolution([90])); await h.store(2, h.resolution([]));
  await h.store(3, { unsupported: true, observedAt: h.now() });
  h.env.CATALOG_CACHE_EPOCH = 'new-identifiers';
  assert.deepEqual((await (await h.bulk([1, 2, 3])).json()).products, [1, 2, 3].map(id => blank(id)));
  h.env.CATALOG_CACHE_EPOCH = 'summary-test'; h.advance(1800000);
  assert.deepEqual((await (await h.bulk([1, 2, 3])).json()).products, [1, 2, 3].map(id => blank(id)));
  delete h.env.CATALOG_CACHE_EPOCH;
  assert.equal((await h.request('/v1/products/3/offers')).status, 200);
  assert.equal(h.logs.at(-1).summary_write_status, 'bypass');
});

test('durable identity and inactive guards prevent cached Detail attaching prices to another or inactive product', async t => {
  const h = await setup(t);
  await h.store(1, h.resolution([50]));
  h.db.sqlite.exec("UPDATE products SET upstream_key='CPU/different' WHERE id=1; UPDATE products SET active=0 WHERE id=2");
  h.advance(1000);
  await h.store(1, h.resolution([10])); await h.store(2, h.resolution([20]));
  assert.deepEqual((await (await h.bulk([1, 2, 999])).json()).products, [blank(1), blank(2, 'missing'), blank(999, 'missing')]);
  assert.equal((await h.execute('SELECT lowest_price FROM product_offer_summary'))[0].lowest_price, 50);
  assert.equal((await h.execute('SELECT * FROM product_offer_summary')).length, 1);
});

test('bulk preserves duplicates/input order and maps complete, empty, unsupported, pending and missing independently', async t => {
  const h = await setup(t);
  await h.store(1, h.resolution([40, 30])); await h.store(2, h.resolution([]));
  await h.store(3, { unsupported: true, observedAt: h.now() });
  h.db.sqlite.exec('UPDATE products SET active=0 WHERE id=5');
  const ids = [4, 1, 999, 2, 3, 1, 5], response = await h.bulk(ids);
  assert.equal(response.status, 200); assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(response.headers.get('Cache-Control'), 'no-store'); assert.equal(response.headers.get('X-Cache'), 'BYPASS');
  const body = await response.json();
  assert.deepEqual(body.products.map(p => p.id), ids);
  assert.deepEqual(body.products.map(p => p.status), ['pending', 'complete', 'missing', 'empty', 'unsupported', 'complete', 'missing']);
  assert.deepEqual(body.products.map(p => p.offer_count), [null, 2, null, 0, 0, 2, null]);
  assert.deepEqual(body.products.map(p => p.lowest_price), [null, 30, null, null, null, 30, null]);
  assert.equal(body.products[4].fetched_at, null);
  assert.equal(h.statements.length, 1); assert.equal(h.logs.at(-1).d1_queries, 1);
});

test('20 cold products use one PK-indexed query, no Offer-cache reads, no Yahoo fetch and no Yahoo/expensive tokens', async t => {
  const h = await setup(t), ids = Array.from({ length: 20 }, (_, i) => i + 1);
  h.cache.match = async () => assert.fail('bulk must not fan out into candidate cache lookups');
  delete h.env.YAHOO_SHOPPING_APP_ID; delete h.env.YAHOO_OFFER_MISS_LIMITER;
  delete h.env.EXPENSIVE_MISS_LIMITER; delete h.env.QUERY_REFILL_LIMITER;
  const response = await h.bulk(ids);
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).products, ids.map(id => blank(id)));
  assert.equal(h.fetches(), 0); assert.equal(h.statements.length, 1);
  assert.equal(h.env.D1_MISS_LIMITER.calls.length, 1); assert.equal(h.logs.at(-1).d1_queries, 1);
  assert.equal(h.logs.at(-1).rows_written, 0);
  const query = summaryLookupQuery(ids, summaryPolicy(h.env), h.now());
  const plan = (await h.execute(`EXPLAIN QUERY PLAN ${query.sql}`, query.params)).map(r => r.detail).join('\n');
  assert.match(plan, /SEARCH p USING INTEGER PRIMARY KEY/); assert.match(plan, /SEARCH s USING PRIMARY KEY/);
  assert(!/SCAN (?:p|s)\b/.test(plan));
});

test('20 warm summaries still use one query, retain mapping and consume no Yahoo limiter token', async t => {
  const h = await setup(t), ids = Array.from({ length: 20 }, (_, i) => 20 - i);
  for (const id of ids) await h.store(id, h.resolution([id * 100]));
  const response = await h.bulk(ids), body = await response.json();
  assert.equal(response.status, 200); assert(body.products.every(p => p.status === 'complete' && p.lowest_price === p.id * 100));
  assert.equal(h.statements.length, 1); assert.equal(h.fetches(), 0); assert.equal(h.env.YAHOO_OFFER_MISS_LIMITER.calls.length, 0);
});

test('strict bulk body, ID, count, JSON, byte-limit, query, method and CORS validation precede D1 protection', async t => {
  const h = await setup(t);
  for (const input of [null, [], {}, { product_ids: [] }, { product_ids: '1' }, { product_ids: [1], extra: true },
    { product_ids: Array(21).fill(1) }, ...[0, -1, 1.5, '1', null, {}, Number.MAX_SAFE_INTEGER + 1].map(id => ({ product_ids: [id] }))]) {
    const response = await h.request(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal(response.status, 400); assert.equal((await response.json()).error.code, 'INVALID_REQUEST');
  }
  assert.equal((await h.request(endpoint, { method: 'POST', body: '{}' })).status, 415);
  for (const [body, status] of [['{', 400], ['x'.repeat(16385), 413]]) {
    assert.equal((await h.request(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, status);
  }
  assert.equal((await h.request(endpoint + '?x=1', { method: 'POST' })).status, 400);
  assert.equal((await h.request(endpoint)).status, 405);
  const preflight = await h.request(endpoint, { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Content-Type' } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS');
  assert.equal(h.statements.length, 0); assert.equal(h.env.D1_MISS_LIMITER.calls.length, 0); assert.equal(h.fetches(), 0);
});

test('bulk D1 budget fails closed with existing sanitized 429/503 contract; database failures are not pending', async t => {
  for (const mode of ['deny', 'missing', 'throw', 'malformed']) {
    const h = await setup(t);
    if (mode === 'missing') delete h.env.D1_MISS_LIMITER;
    else h.env.D1_MISS_LIMITER.limit = async () => { if (mode === 'throw') throw Error('private'); return mode === 'malformed' ? {} : { success: false }; };
    const response = await h.bulk([1]);
    assert.equal(response.status, mode === 'deny' ? 429 : 503); assert.equal(response.headers.get('Retry-After'), '60');
    assert.equal(h.statements.length, 0); assert.equal(h.fetches(), 0);
  }
  const h = await setup(t, { execute: async () => { throw Error('private SQL failure'); } });
  const response = await h.bulk([1]); assert.equal(response.status, 500);
  assert.equal((await response.json()).error.code, 'DATABASE_ERROR');
  assert(!JSON.stringify(h.logs).includes('private'));
});

test('/offers MISS awaits summary storage, then bulk returns the minimum of normalized exact Offers', async t => {
  const h = await setup(t, { fetch: async () => Response.json(yahooBody([
    yahooHit({ price: 100 }), yahooHit({ code: 'other', price: 50 }), yahooHit({ code: 'mismatch', janCode: OTHER_JAN, price: 1 }),
  ])) });
  assert.deepEqual((await (await h.bulk([1])).json()).products, [blank(1)]);
  const offers = await h.request('/v1/products/1/offers');
  assert.equal(offers.status, 200); assert.equal(h.logs.at(-1).summary_write_status, 'stored');
  const body = await offers.json(), summary = (await (await h.bulk([1])).json()).products[0];
  assert.deepEqual(summary, { id: 1, status: 'complete', lowest_price: 50, offer_count: 2, fetched_at: body.offers[0].fetched_at });
  assert.equal(h.fetches(), 1); assert.equal(h.env.YAHOO_OFFER_MISS_LIMITER.calls.length, 1);
  const before = h.statements.length, tokens = h.env.D1_MISS_LIMITER.calls.length;
  assert.equal((await h.request('/v1/products/1/offers')).status, 200);
  assert.equal(h.logs.at(-1).summary_write_status, 'unchanged'); assert.equal(h.statements.length, before);
  assert.equal(h.env.D1_MISS_LIMITER.calls.length, tokens);
});

test('/offers normal zero is empty with timestamp, unsupported is distinct with null timestamp, cold remains pending', async t => {
  const h = await setup(t, { fetch: async () => Response.json(yahooBody([])) });
  assert.equal((await h.request('/v1/products/1/offers')).status, 200);
  assert.equal((await h.request('/v1/products/3/offers')).status, 200);
  const rows = (await (await h.bulk([1, 3, 2])).json()).products;
  assert.deepEqual(rows.map(r => [r.status, r.offer_count]), [['empty', 0], ['unsupported', 0], ['pending', null]]);
  assert.equal(rows[0].fetched_at, new Date(h.now()).toISOString()); assert.equal(rows[1].fetched_at, null);
  assert.equal(h.fetches(), 1);
});

test('fallback summary uses only the winning candidate and the earliest candidate freshness boundary', async t => {
  const h = await setup(t, { fetch: async input => {
    const code = new URL(input).searchParams.get('jan_code');
    return Response.json(yahooBody(code === A3_FIRST_EAN ? [] : [yahooHit({ janCode: A3_YAHOO_EAN, price: 200 })]));
  } });
  const start = h.now();
  assert.equal((await h.request('/v1/products/4/offers')).status, 200);
  const row = (await h.execute('SELECT * FROM product_offer_summary WHERE product_id=4'))[0];
  assert.equal(row.offer_count, 1); assert.equal(row.lowest_price, 200); assert.equal(h.fetches(), 2);
  assert.equal(row.lookup_strategy, 'ean13_as_jan'); assert.equal(row.observed_at, start);
  assert.equal(row.expires_at, start + 1800000); assert.equal(row.fetched_at, new Date(start + 1000).toISOString());
  h.advance(1799000); assert.deepEqual((await (await h.bulk([4])).json()).products, [blank(4)]);
});

test('a new isolate backfills complete/empty from Offer cache without a Yahoo token or refreshing timestamps/expiry', async t => {
  for (const empty of [false, true]) {
    const h = await setup(t, { fetch: async () => Response.json(yahooBody(empty ? [] : [yahooHit()])) });
    await h.request('/v1/products/1/offers');
    const original = (await h.execute('SELECT * FROM product_offer_summary'))[0];
    h.db.sqlite.exec('DELETE FROM product_offer_summary'); h.advance(300123); h.restart();
    delete h.env.YAHOO_OFFER_MISS_LIMITER; delete h.env.YAHOO_SHOPPING_APP_ID;
    const response = await h.request('/v1/products/1/offers'); assert.equal(response.status, 200); assert.equal(response.headers.get('X-Cache'), 'HIT');
    const backfill = (await h.execute('SELECT * FROM product_offer_summary'))[0];
    assert.deepEqual(backfill, original); assert.equal(h.fetches(), 1);
    assert.equal(h.logs.at(-1).d1_queries, 1);
    h.advance(original.expires_at - h.now());
    assert.deepEqual((await (await h.bulk([1])).json()).products, [blank(1)]);
  }
});

test('provider errors never create empty summaries or replace an existing fresh success', async t => {
  const h = await setup(t, { fetch: async () => new Response('', { status: 500 }) });
  await h.store(1, h.resolution([42])); h.advance(1000);
  assert.equal((await h.request('/v1/products/1/offers')).status, 503);
  assert.equal((await (await h.bulk([1])).json()).products[0].lowest_price, 42);
  h.advance(1000); assert.equal((await h.request('/v1/products/2/offers')).status, 503);
  assert.deepEqual((await (await h.bulk([2])).json()).products, [blank(2)]);
  assert.equal((await h.execute('SELECT * FROM product_offer_summary')).length, 1);
});

test('summary write outage/denial is best effort, does not poison Offer cache and can retry on a later HIT', async t => {
  let fail = true;
  const h = await setup(t, { execute: (db, sql, params) => {
    if (fail && sql.startsWith('INSERT INTO product_offer_summary')) throw Error('private write failure');
    return db.query(sql, params);
  } });
  const first = await h.request('/v1/products/1/offers'); assert.equal(first.status, 200);
  assert.equal(h.logs.at(-1).summary_write_status, 'error');
  assert.deepEqual((await (await h.bulk([1])).json()).products, [blank(1)]);
  fail = false;
  h.env.D1_MISS_LIMITER.limit = async () => ({ success: false });
  assert.equal((await h.request('/v1/products/1/offers')).status, 200);
  assert.equal(h.logs.at(-1).summary_write_status, 'protected');
  h.env.D1_MISS_LIMITER = fakeLimiters({ unlimited: true }).D1_MISS_LIMITER;
  assert.equal((await h.request('/v1/products/1/offers')).status, 200);
  assert.equal((await (await h.bulk([1])).json()).products[0].status, 'complete');
  assert.equal(h.fetches(), 1); assert(!JSON.stringify(h.logs).includes('private write'));
});

test('summary writer coalesces simultaneous writes, keeps bounded hints and retries after failures', async t => {
  const h = await setup(t), write = createSummaryWriter({ now: h.now });
  let writes = 0, release;
  const save = async () => { writes++; await new Promise(resolve => release = resolve); };
  const args = { product: h.products[0], resolution: h.resolution([50]), env: h.env, save };
  const first = write(args), second = write(args); release();
  assert.deepEqual(await Promise.all([first, second]), ['stored', 'stored']); assert.equal(writes, 1);
  assert.equal(await write(args), 'unchanged');
  for (let id = 2; id <= 130; id++) await write({ ...args, product: { ...args.product, id }, save: async () => { writes++; } });
  await write({ ...args, save: async () => { writes++; } }); assert.equal(writes, 131, 'old hint evicted at bounded capacity');
  h.advance(1800000); assert.equal(await write(args), 'expired');
});

test('summary telemetry is bounded and omits product IDs, names, barcodes, prices, URLs and credentials', async t => {
  const h = await setup(t);
  await h.request('/v1/products/1/offers'); await h.bulk([1, 2, 3]);
  const event = h.logs.at(-1), log = JSON.stringify(h.logs);
  assert.equal(event.route, endpoint); assert.equal(event.summary_product_count, 3);
  for (const value of [JAN, OTHER_JAN, RYZEN_EAN, 'Summary private product', 'test-only-secret', 'https://', 'lowest_price', 'product_ids']) assert(!log.includes(value));
});
