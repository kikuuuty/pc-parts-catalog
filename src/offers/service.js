import { selectYahooLookupCandidates, MAX_YAHOO_LOOKUP_CANDIDATES } from './identifiers.js';
import { fetchYahooOffers } from './yahoo-shopping.js';
import { offerCachePolicy } from './cache.js';
import { readSearchCache, writeSearchCache } from '../search-cache.js';
import { protectYahooOfferMiss, ProtectionError } from '../search-protection.js';
import { unavailable, rateLimited } from './errors.js';

// Per-isolate bounded coalescing; cache reads and writes belong to the shared task too.
export function createOfferService({ fetch: fetcher, now = Date.now, timeoutMs,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const inflight = new Map();
  let nextCallAt = 0;
  let owner = null;

  async function loadCandidate({ lookup, policy, env, cache, context, metrics }) {
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
    // Only the admitted chain can wait. Other external MISSes never join a queue,
    // even while its limiter, fetch, cache write or fallback timer is pending.
    if (owner !== context) {
      if (owner || now() < nextCallAt) {
        Object.assign(metrics, { rate_limit_status: 'denied', rate_limit_class: 'yahoo_pacing' });
        throw rateLimited('pacing', 1);
      }
      owner = context;
    }
    while (now() < nextCallAt) await sleep(nextCallAt - now());
    try {
      await protectYahooOfferMiss(env, metrics);
      // Every actual external request needs its own token and start interval.
      nextCallAt = now() + 1000;
    } catch (error) {
      if (!(error instanceof ProtectionError)) throw error;
      throw error.status === 429 ? rateLimited('miss_budget', error.retryAfter) : unavailable('protection');
    }
    const offers = await fetchYahooOffers({ appId: env.YAHOO_SHOPPING_APP_ID, jan: lookup.value, fetch: fetcher, now, timeoutMs, event: metrics });
    if (useCache) {
      try { await writeSearchCache(cache, policy.key, JSON.stringify(offers), policy.ttl, now()); }
      catch { metrics.offer_cache_status = 'BYPASS'; metrics.offer_cache_error = 'put'; }
    }
    return { offers };
  }

  return async function loadOffers({ product, url, env, cache, event, headers }) {
    const candidates = selectYahooLookupCandidates(product.identifiers).slice(0, MAX_YAHOO_LOOKUP_CANDIDATES);
    Object.assign(event, { provider: 'yahoo', lookup_strategy: candidates[0]?.strategy ?? null,
      lookup_candidate_count: candidates.length, lookup_attempts: 0, lookup_hit_index: 0,
      offer_cache_status: 'BYPASS', offer_coalesced: false });
    const base = { product: { id: product.id, name: product.name }, provider: 'yahoo' };
    if (!candidates.length) {
      event.offer_count = 0;
      return { ...base, lookup: { status: 'unsupported', strategy: null, reason: 'no_supported_identifier' }, offers: [] };
    }
    const context = {};
    try {
      for (const [index, lookup] of candidates.entries()) {
        event.lookup_strategy = lookup.strategy;
        event.lookup_attempts = index + 1;
        const policy = offerCachePolicy(url, lookup, env);
        const key = policy.key.url;
        let task = inflight.get(key);
        if (task) event.offer_coalesced = true;
        else {
          if (inflight.size >= 32) throw rateLimited('inflight', 1);
          const metrics = {};
          task = { metrics, promise: loadCandidate({ lookup, policy, env, cache, context, metrics }) };
          inflight.set(key, task);
        }
        let result;
        try { result = await task.promise; }
        finally {
          Object.assign(event, task.metrics);
          if (inflight.get(key) === task) inflight.delete(key);
        }
        const { offers, age } = result;
        // Only a successful, normalized empty result (including cached []) advances.
        // Errors propagate, and the first nonempty candidate is never unioned with others.
        if (!offers.length && index + 1 < candidates.length) continue;
        if (policy.eligible && cache) headers.set('X-Cache-TTL', String(policy.ttl));
        if (age !== undefined) headers.set('Age', String(age));
        event.offer_count = offers.length;
        event.lookup_hit_index = offers.length ? index + 1 : 0;
        return { ...base, lookup: { status: 'complete', strategy: lookup.strategy, reason: null }, offers };
      }
    } finally {
      if (owner === context) owner = null;
    }
  };
}
