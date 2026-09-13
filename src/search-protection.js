import { parseSearchIntent } from './search-intent.js';

// Request-derived admission only; never changes the input, SQL or search results.
// "normal" is not a promise of cheap execution. The all-MISS breaker always applies.
export function classifySearchCost(input, { method = 'GET', cacheEligible = true } = {}) {
  if (method !== 'GET' || !cacheEligible) return 'uncached';
  if (!input.keyword) return 'expensive';
  const intent = parseSearchIntent(input.category, input.keyword);
  if (intent.specOnly || intent.family || intent.identity) return 'expensive';
  const tokens = intent.remaining.match(/[\p{L}\p{N}]+/gu) ?? [];
  const model = tokens.some(t => /^(?:[a-z]{0,5}\d{3,5}[a-z0-9]{0,4})$/i.test(t));
  return model ? 'normal' : 'expensive';
}

export const protectionBindings = [
  { name: 'QUERY_REFILL_LIMITER', namespace_id: '29599001', simple: { limit: 2, period: 10 } },
  { name: 'D1_MISS_LIMITER', namespace_id: '29599002', simple: { limit: 60, period: 60 } },
  { name: 'EXPENSIVE_MISS_LIMITER', namespace_id: '29599003', simple: { limit: 20, period: 60 } },
  { name: 'HEALTH_LIMITER', namespace_id: '29599004', simple: { limit: 60, period: 60 } },
];

export class ProtectionError extends Error {
  constructor(unavailable, period, health = false) {
    super(unavailable ? 'Request protection temporarily unavailable' : health ? 'Too many health requests' : 'Too many search requests');
    this.status = unavailable ? 503 : 429;
    this.code = unavailable ? 'PROTECTION_UNAVAILABLE' : 'RATE_LIMITED';
    this.retryAfter = period;
  }
}

async function check(env, event, name, key, tier) {
  const { simple: { period } } = protectionBindings.find(b => b.name === name);
  let success;
  try {
    const result = await env[name].limit({ key });
    if (typeof result?.success !== 'boolean') throw new Error('Invalid limiter response');
    success = result.success;
  } catch {
    Object.assign(event, { rate_limit_status: 'unavailable', rate_limit_class: tier });
    throw new ProtectionError(true, period);
  }
  if (!success) {
    Object.assign(event, { rate_limit_status: 'denied', rate_limit_class: tier });
    throw new ProtectionError(false, period, tier === 'health');
  }
}

// Bounded in-flight admission supplements the eventually consistent binding.
// Scoped to one Worker isolate; entries exist only until D1 + cache fill finishes.
export function createRefillGuard() {
  const active = new Map();
  return key => {
    const count = active.get(key) ?? 0;
    if (count >= 2 || count === 0 && active.size >= 128) return null;
    active.set(key, count + 1);
    return () => {
      const remaining = active.get(key) - 1;
      if (remaining) active.set(key, remaining);
      else active.delete(key);
    };
  };
}

export async function protectSearch(env, event, input, method, key, refillGuard) {
  const cost = classifySearchCost(input, { method, cacheEligible: !!key && !event.cache_error });
  event.search_cost_class = cost;
  const release = key ? refillGuard(key.url) : () => {};
  if (!release) {
    Object.assign(event, { rate_limit_status: 'denied', rate_limit_class: 'query_inflight' });
    throw new ProtectionError(false, 10);
  }
  try {
    // Refill first: duplicate cold attempts must not drain the shared resource pools.
    // SHA-256 is transient, bounded and not logged. No IP or user tracking key.
    if (key) {
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key.url));
      const digest = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
      await check(env, event, 'QUERY_REFILL_LIMITER', digest, 'query_refill');
    }
    // Restricted tier first, so rejected expensive traffic does not drain normal tokens.
    // Bindings are not a transaction: a later rejection cannot refund earlier tokens.
    if (cost !== 'normal') await check(env, event, 'EXPENSIVE_MISS_LIMITER', 'search-expensive-miss', 'expensive_miss');
    await check(env, event, 'D1_MISS_LIMITER', 'search-d1-miss', 'd1_miss');
    Object.assign(event, { rate_limit_status: 'allowed', rate_limit_class: cost === 'normal' ? 'd1_miss' : 'expensive_miss' });
    return release;
  } catch (error) { release(); throw error; }
}

export async function protectHealth(env, event) {
  await check(env, event, 'HEALTH_LIMITER', 'd1-health', 'health');
  Object.assign(event, { rate_limit_status: 'allowed', rate_limit_class: 'health' });
}

// Predeploy must reject missing, shared, or silently loosened production bindings.
export function validateProtectionConfig(config) {
  if (!Array.isArray(config.ratelimits) || config.ratelimits.length !== protectionBindings.length) throw new Error('Missing production rate limit bindings');
  for (const expected of protectionBindings) {
    const matches = config.ratelimits.filter(b => b.name === expected.name);
    const actual = matches[0];
    if (matches.length !== 1 || actual.namespace_id !== expected.namespace_id ||
        actual.simple?.limit !== expected.simple.limit || actual.simple?.period !== expected.simple.period) {
      throw new Error(`Invalid production rate limit binding: ${expected.name}`);
    }
  }
  const epoch = config.vars?.CATALOG_CACHE_EPOCH;
  if (typeof epoch !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(epoch) ||
      !['0', '60', '300', '600'].includes(config.vars?.SEARCH_CACHE_TTL_SECONDS)) throw new Error('Invalid production catalog cache configuration');
}
