import { unavailable } from './errors.js';

// v2 includes product/seller image metadata and the image_size=300 request.
export const OFFER_CACHE_GENERATION = 'v2';
export function offerCacheTtl(value = '1800') {
  if (!/^[0-9]+$/.test(String(value))) return null;
  const ttl = Number(value);
  return Number.isSafeInteger(ttl) && ttl >= 60 && ttl <= 3600 ? ttl : null;
}

export function offerCachePolicy(url, { strategy, value }, env) {
  const ttl = offerCacheTtl(env.YAHOO_OFFERS_CACHE_TTL_SECONDS);
  if (ttl === null) throw unavailable('configuration');
  const epoch = env.CATALOG_CACHE_EPOCH;
  const eligible = typeof epoch === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(epoch);
  // Share across products only within the same lookup strategy and identifier.
  // Detail's separate epoch-keyed cache resolves ID -> identifiers first.
  const key = new URL(`/__catalog_cache/offers/yahoo/${OFFER_CACHE_GENERATION}`, url.origin);
  key.search = new URLSearchParams({ epoch: eligible ? epoch : 'unversioned', ttl: String(ttl), strategy, identifier: value }).toString();
  return { ttl, eligible, key: new Request(key) };
}
