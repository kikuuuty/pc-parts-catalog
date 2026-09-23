import { offerCacheTtl, OFFER_CACHE_GENERATION } from './cache.js';
import { unavailable } from './errors.js';
import { MAX_YAHOO_LOOKUP_CANDIDATES } from './identifiers.js';

export const MAX_OFFER_SUMMARY_PRODUCTS = 20;
// Bump for summary semantics or lookup-policy changes. Epoch covers catalog changes.
export const OFFER_SUMMARY_GENERATION = `v1-${OFFER_CACHE_GENERATION}-candidates${MAX_YAHOO_LOOKUP_CANDIDATES}`;

export function summaryPolicy(env) {
  const ttl = offerCacheTtl(env.YAHOO_OFFERS_CACHE_TTL_SECONDS);
  if (ttl === null) throw unavailable('configuration');
  const epoch = env.CATALOG_CACHE_EPOCH;
  return { ttl, epoch: typeof epoch === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(epoch) ? epoch : null,
    generation: OFFER_SUMMARY_GENERATION };
}

export function validateSummaryInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => k !== 'product_ids') ||
      !Array.isArray(input.product_ids) || input.product_ids.length < 1 || input.product_ids.length > MAX_OFFER_SUMMARY_PRODUCTS) {
    throw Error('product_ids must contain 1–20 product IDs');
  }
  if (input.product_ids.some(id => !Number.isSafeInteger(id) || id < 1)) throw Error('Invalid product ID');
  return input.product_ids;
}

// Only normalized final-candidate Offers enter this function; never merge candidates.
// Reject corruption rather than presenting a partial count or inventing an empty result.
export function summarizeOffers(offers) {
  if (!Array.isArray(offers) || offers.length > 50 ||
      offers.some(o => !Number.isSafeInteger(o?.price) || o.price <= 0)) throw Error('Invalid normalized Offers');
  return { status: offers.length ? 'complete' : 'empty',
    lowest_price: offers.length ? Math.min(...offers.map(o => o.price)) : null, offer_count: offers.length };
}

export function summaryRecord(product, resolution, policy) {
  const unsupported = resolution.unsupported === true;
  const summary = unsupported ? { status: 'unsupported', lowest_price: null, offer_count: 0 } : summarizeOffers(resolution.offers);
  const observedAt = resolution.observedAt;
  const expiresAt = unsupported ? observedAt + policy.ttl * 1000 : resolution.expiresAt;
  if (!Number.isSafeInteger(observedAt) || !Number.isSafeInteger(expiresAt) || expiresAt <= observedAt ||
      !unsupported && (!Number.isSafeInteger(resolution.fetchedAt) || resolution.fetchedAt < observedAt)) throw Error('Invalid summary freshness');
  return { product_id: product.id, provider: 'yahoo', source: product.source, upstream_key: product.upstream_key,
    catalog_epoch: policy.epoch, generation: policy.generation, ttl_seconds: policy.ttl, ...summary,
    lookup_strategy: unsupported ? null : resolution.lookupStrategy,
    fetched_at: unsupported ? null : new Date(resolution.fetchedAt).toISOString(), observed_at: observedAt, expires_at: expiresAt };
}

export function summaryUpsertQuery(row) {
  const fields = Object.keys(row);
  // Check durable identity/active state atomically: a cached Detail must not attach
  // a price to a different product after a rebuild, or recreate a deleted product.
  return { sql: `INSERT INTO product_offer_summary (${fields.join(',')})
    SELECT ${fields.map(() => '?').join(',')} FROM products
    WHERE id=? AND source=? AND upstream_key=? AND active=1
    ON CONFLICT(product_id,provider) DO UPDATE SET ${fields.filter(k => !['product_id', 'provider'].includes(k)).map(k => `${k}=excluded.${k}`).join(',')}
    WHERE excluded.observed_at > product_offer_summary.observed_at
      OR (excluded.observed_at = product_offer_summary.observed_at AND (
        excluded.fetched_at > product_offer_summary.fetched_at
        OR excluded.catalog_epoch <> product_offer_summary.catalog_epoch OR excluded.generation <> product_offer_summary.generation
        OR excluded.ttl_seconds <> product_offer_summary.ttl_seconds OR excluded.expires_at > product_offer_summary.expires_at))
    RETURNING product_id`, params: [...Object.values(row), row.product_id, row.source, row.upstream_key] };
}

// One bounded indexed query; duplicates are read once and re-expanded in JS.
// No dependency on the Provider, candidate discovery, Offer cache or external fetch.
export function summaryLookupQuery(ids, policy, now) {
  const unique = [...new Set(ids)];
  return { sql: `SELECT CAST(j.value AS INTEGER) AS id,p.active,s.status,s.lowest_price,s.offer_count,s.fetched_at
    FROM json_each(?) j LEFT JOIN products p ON p.id=CAST(j.value AS INTEGER)
    LEFT JOIN product_offer_summary s ON s.product_id=p.id AND s.provider='yahoo'
      AND s.source=p.source AND s.upstream_key=p.upstream_key
      AND s.catalog_epoch=? AND s.generation=? AND s.ttl_seconds=? AND s.observed_at<=? AND s.expires_at>?`,
    params: [JSON.stringify(unique), policy.epoch, policy.generation, policy.ttl, now, now] };
}

export async function loadOfferSummaries(execute, ids, policy, now) {
  const query = summaryLookupQuery(ids, policy, now);
  const rows = new Map((await execute(query.sql, query.params)).map(row => [row.id, row]));
  return { products: ids.map(id => {
    const row = rows.get(id);
    if (!row || row.active !== 1) return { id, status: 'missing', lowest_price: null, offer_count: null, fetched_at: null };
    return { id, status: row.status ?? 'pending', lowest_price: row.lowest_price ?? null,
      offer_count: row.offer_count ?? null, fetched_at: row.fetched_at ?? null };
  }) };
}

// Bounded per-isolate successful-write hints/coalescing avoid D1 writes on every
// repeated Offer HIT. These are only hints: D1 is the cross-request source of truth.
// A new isolate can backfill from the Offer cache without extending its freshness.
export function createSummaryWriter({ now = Date.now } = {}) {
  const saved = new Map(), inflight = new Map();
  return async ({ product, resolution, env, save }) => {
    const policy = summaryPolicy(env);
    if (!policy.epoch) return 'bypass';
    const row = summaryRecord(product, resolution, policy);
    if (row.expires_at <= now()) return 'expired';
    const key = JSON.stringify([row.product_id, row.source, row.upstream_key, row.catalog_epoch, row.generation, row.ttl_seconds,
      row.status, row.status === 'unsupported' ? null : [row.observed_at, row.fetched_at, row.expires_at]]);
    if ((saved.get(key) ?? 0) > now()) return 'unchanged';
    if (inflight.has(key)) return inflight.get(key);
    if (inflight.size >= 32) return 'busy';
    const task = (async () => {
      const query = summaryUpsertQuery(row);
      await save(query.sql, query.params);
      if (saved.size >= 128) saved.delete(saved.keys().next().value);
      saved.set(key, row.expires_at);
      return 'stored';
    })();
    inflight.set(key, task);
    try { return await task; }
    finally { if (inflight.get(key) === task) inflight.delete(key); }
  };
}
