// Cache policy only. Call after the HTTP and searchQuery validation, never before.
// Bump this namespace for response/search implementation changes, independently of catalog sync.
export const CACHE_SCHEMA_GENERATION = 'v3';
const STORED_AT = 'X-Catalog-Cached-At';

export function searchCachePolicy(env, input) {
  if (input.cursor !== undefined) return null;
  const ttl = Number(env.SEARCH_CACHE_TTL_SECONDS ?? 300);
  const epoch = env.CATALOG_CACHE_EPOCH;
  if (![60, 300, 600].includes(ttl) || typeof epoch !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(epoch)) return null;
  const { limit = 20, offset = 0 } = input;
  // Six standard pages per query; other valid pagination still executes normally.
  if (limit !== 20 || offset > 100 || offset % 20 !== 0) return null;
  return { ttl, epoch };
}

export function searchCacheKey(url, input, { ttl, epoch }) {
  const key = new URL(`/__catalog_cache/search/${CACHE_SCHEMA_GENERATION}`, url.origin);
  key.searchParams.set('epoch', epoch);
  key.searchParams.set('ttl', String(ttl));
  key.searchParams.set('category', input.category);
  // Only surrounding whitespace is redundant to this search contract. Do not
  // lowercase/NFKC/compact/collapse internal whitespace or merge model spellings.
  if (input.keyword !== undefined) key.searchParams.set('q', input.keyword.trim());
  key.searchParams.set('limit', String(input.limit ?? 20));
  key.searchParams.set('offset', String(input.offset ?? 0));
  // Fresh request: Range/conditional/cookie/auth headers cannot affect Cache API match.
  return new Request(key, { method: 'GET' });
}

export async function readSearchCache(cache, key, ttl, now) {
  const response = await cache.match(key);
  if (!response) return null;
  const storedAt = Number(response.headers.get(STORED_AT));
  const age = now - storedAt;
  if (response.status !== 200 || !response.headers.has(STORED_AT) || !Number.isFinite(age) || age < 0 || age >= ttl * 1000) {
    // A cloned/tee'd cache stream can wait for its sibling on cancellation.
    // Discard asynchronously; expiry must never block the database fallback.
    void response.body?.cancel().catch(() => {});
    return null;
  }
  return { body: await response.text(), age: Math.floor(age / 1000) };
}

export async function writeSearchCache(cache, key, body, ttl, now) {
  // Only the successful JSON representation is persisted, never request IDs,
  // D1 timings, error responses or the browser-facing cache policy.
  await cache.put(key, new Response(body, { status: 200, headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': `public, max-age=${ttl}`,
    [STORED_AT]: String(now),
  } }));
}
