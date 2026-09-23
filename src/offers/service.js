import { selectYahooLookup } from './identifiers.js';
import { fetchYahooOffers } from './yahoo-shopping.js';
import { offerCachePolicy } from './cache.js';
import { readSearchCache, writeSearchCache } from '../search-cache.js';
import { protectYahooOfferMiss, ProtectionError } from '../search-protection.js';
import { unavailable, rateLimited } from './errors.js';

// Per-isolate bounded coalescing; cache reads and writes belong to the shared task too.
export function createOfferService({ fetch: fetcher, now = Date.now, timeoutMs } = {}) {
  const inflight = new Map();
  let nextCallAt = 0;
  let admitting = false;
  return async function loadOffers({ product, url, env, cache, event, headers }) {
    const lookup = selectYahooLookup(product.identifiers);
    Object.assign(event, { provider: 'yahoo', lookup_strategy: lookup?.strategy ?? null, offer_cache_status: 'BYPASS' });
    const base = { product: { id: product.id, name: product.name }, provider: 'yahoo' };
    if (!lookup) {
      event.offer_count = 0;
      return { ...base, lookup: { status: 'unsupported', strategy: null, reason: 'no_supported_identifier' }, offers: [] };
    }
    const policy = offerCachePolicy(url, lookup, env);
    const key = policy.key.url;
    let task = inflight.get(key);
    const coalesced = !!task;
    if (!task) {
      if (inflight.size >= 32) throw rateLimited('inflight', 1);
      const metrics = {};
      task = { metrics, promise: (async () => {
        const useCache = cache && policy.eligible;
        metrics.offer_cache_status = useCache ? 'MISS' : 'BYPASS';
        if (useCache) {
          try {
            const hit = await readSearchCache(cache, policy.key, policy.ttl, now());
            if (hit) {
              const offers = JSON.parse(hit.body);
              if (!Array.isArray(offers)) throw new Error('Invalid cache');
              metrics.offer_cache_status = 'HIT';
              return { offers, age: hit.age };
            }
          } catch { metrics.offer_cache_status = 'BYPASS'; metrics.offer_cache_error = 'match'; }
        }
        if (typeof env.YAHOO_SHOPPING_APP_ID !== 'string' || !env.YAHOO_SHOPPING_APP_ID.trim()) throw unavailable('missing_app_id');
        // Reject bursts instead of creating a queue of uncached external calls.
        if (admitting || now() < nextCallAt) {
          Object.assign(metrics, { rate_limit_status: 'denied', rate_limit_class: 'yahoo_pacing' });
          throw rateLimited('pacing', 1);
        }
        admitting = true;
        try {
          await protectYahooOfferMiss(env, metrics);
          // Start the interval after asynchronous admission, immediately before fetch.
          nextCallAt = now() + 1000;
        }
        catch (error) {
          if (!(error instanceof ProtectionError)) throw error;
          throw error.status === 429 ? rateLimited('miss_budget', error.retryAfter) : unavailable('protection');
        } finally { admitting = false; }
        const offers = await fetchYahooOffers({ appId: env.YAHOO_SHOPPING_APP_ID, jan: lookup.value, fetch: fetcher, now, timeoutMs, event: metrics });
        if (useCache) {
          try { await writeSearchCache(cache, policy.key, JSON.stringify(offers), policy.ttl, now()); }
          catch { metrics.offer_cache_status = 'BYPASS'; metrics.offer_cache_error = 'put'; }
        }
        return { offers };
      })() };
      inflight.set(key, task);
    }
    try {
      const { offers, age } = await task.promise;
      if (policy.eligible && cache) headers.set('X-Cache-TTL', String(policy.ttl));
      if (age !== undefined) headers.set('Age', String(age));
      event.offer_count = offers.length;
      return { ...base, lookup: { status: 'complete', strategy: lookup.strategy, reason: null }, offers };
    } finally {
      Object.assign(event, task.metrics, { offer_coalesced: coalesced });
      if (inflight.get(key) === task) inflight.delete(key);
    }
  };
}
