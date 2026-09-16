import { categories, models } from './model.js';
import { searchQuery } from './queries.js';
import { searchCachePolicy, searchCacheKey, readSearchCache, writeSearchCache } from './search-cache.js';
import { protectSearch, protectHealth, ProtectionError, createRefillGuard } from './search-protection.js';
import { loadProductDetail, productDetailCache } from './product-detail.js';
import { searchWindow } from './pagination.js';

const MAX_BODY = 16 * 1024;
const routes = { '/v1/health': ['GET'], '/v1/categories': ['GET'], '/v1/search': ['GET', 'POST'] };
const fields = ['category', 'keyword', 'filters', 'ranges', 'facets', 'identifier', 'orderBy', 'limit', 'offset', 'include'];
const productFields = ['id', 'upstream_id', 'upstream_key', 'category', 'manufacturer', 'name', 'series', 'variant', 'release_year', 'manufacturer_url'];
const source = {
  name: 'BuildCores OpenDB', url: 'https://github.com/buildcores/buildcores-open-db',
  license: 'ODC-By 1.0', license_url: 'https://opendatacommons.org/licenses/by/1-0/',
  attribution: 'Contains information from BuildCores OpenDB, made available under the ODC Attribution License.',
};
class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const invalid = message => { throw new HttpError(400, 'INVALID_REQUEST', message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const shortText = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
function keys(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid('Invalid object or unknown field');
}
function selections(value, max) {
  if (!object(value) || Object.keys(value).length > max) invalid('Too many selections or invalid object');
  let count = 0;
  for (const raw of Object.values(value)) {
    const values = Array.isArray(raw) ? raw : [raw];
    if (!values.length || values.length > 10 || values.some(v => !(shortText(v) || typeof v === 'number' && Number.isFinite(v)))) invalid('Invalid selection values');
    count += values.length;
  }
  return count;
}

// HTTP limits supplement searchQuery's category/column/type/FTS allowlists.
function validate(input) {
  keys(input, fields);
  if (!categories.includes(input.category)) invalid('category is required and must be a supported category');
  for (const key of ['keyword', 'orderBy']) if (input[key] !== undefined && !shortText(input[key])) invalid(`${key} must be a nonempty string of at most 200 characters`);
  const { limit = 20, offset = 0, filters = {}, ranges = {}, facets = {}, include = [] } = input;
  const maxWindow = searchWindow(input);
  if (!Array.isArray(include) || include.length > 2 || new Set(include).size !== include.length || include.some(v => !['identifiers', 'facets'].includes(v))) invalid('include accepts identifiers and facets');
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) invalid('limit must be an integer from 1 to 50');
  if (!Number.isInteger(offset) || offset < 0 || offset + limit > maxWindow) invalid(`offset must be nonnegative and offset + limit must not exceed ${maxWindow}`);
  const values = selections(filters, 8) + selections(facets, 4);
  if (!object(ranges) || Object.keys(ranges).length > 8) invalid('ranges must be an object with at most 8 fields');
  for (const range of Object.values(ranges)) {
    keys(range, ['min', 'max']);
    if (!Object.keys(range).length || Object.values(range).some(v => typeof v !== 'number' || !Number.isFinite(v))) invalid('Range bounds must be finite numbers');
  }
  if (values > 40 || Object.keys(filters).length + Object.keys(ranges).length + Object.keys(facets).length > 16) invalid('Search conditions exceed complexity limit');
  if (input.identifier !== undefined) {
    keys(input.identifier, ['type', 'value']);
    if (!shortText(input.identifier.value) || input.identifier.type !== undefined && !['mpn', 'gtin', 'ean', 'upc', 'jan'].includes(input.identifier.type)) invalid('Invalid identifier');
  }
  let query;
  try {
    // One extra row determines whether a following page exists without COUNT(*).
    query = searchQuery(input.category, { ...input, limit: limit + 1, debug: false });
  } catch {
    invalid('Invalid search conditions; check keyword tokens, filter fields, types, ranges and orderBy');
  }
  if (query.params.length >= 100) invalid('Search conditions exceed parameter limit');
  return { category: input.category, limit, offset, maxWindow, include, query: { sql: `${query.sql} OFFSET ?`, params: [...query.params, offset] } };
}

async function jsonInput(request) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
  }
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) invalid('Invalid Content-Length');
  if (Number(length) > MAX_BODY) throw new HttpError(413, 'BODY_TOO_LARGE', 'JSON body must not exceed 16384 bytes');
  if (!request.body) invalid('JSON body is required');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        // Do not wait for an untrusted sender to finish its stream.
        void reader.cancel().catch(() => {});
        throw new HttpError(413, 'BODY_TOO_LARGE', 'JSON body must not exceed 16384 bytes');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    invalid('Could not read JSON body');
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { invalid('Invalid JSON'); }
}
async function searchInput(request, url) {
  if (request.method === 'POST') {
    if (url.search) invalid('POST search conditions belong in the JSON body');
    return jsonInput(request);
  }
  const input = {};
  for (const [key, value] of url.searchParams) {
    if (!['category', 'q', 'limit', 'offset'].includes(key) || url.searchParams.getAll(key).length !== 1) invalid('Unknown or repeated query parameter');
    if (key === 'limit' || key === 'offset') {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) invalid('Invalid pagination number');
      input[key] = Number(value);
    } else input[key === 'q' ? 'keyword' : key] = value;
  }
  return input;
}
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

// No CLI, REST credentials, writes, SQL logging, or user-controlled SQL here.
export function createWorker({ log = entry => console.log(JSON.stringify(entry)), cache: injectedCache, now = Date.now } = {}) {
  const refillGuard = createRefillGuard();
  return {
    async fetch(request, env) {
      const started = performance.now();
      const requestId = crypto.randomUUID();
      const headers = new Headers({
        'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'X-Request-ID': requestId,
        // Public, read-only catalog. Credentials and management routes are not supported.
        'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'X-Request-ID, Server-Timing, X-Cache, X-Cache-TTL, Age, Retry-After',
      });
      const event = { event: 'catalog_api', request_id: requestId, route: 'unknown', method: request.method,
        cache_status: 'BYPASS', rate_limit_status: 'not_checked', rate_limit_class: 'none', search_cost_class: 'not_classified',
        d1_queries: 0, rows_read: 0, rows_written: 0, sql_duration_ms: null };
      let status = 200;
      let payload;
      let cachedBody;
      const execute = async (sql, params = []) => {
        if (!env.DB?.prepare) throw new Error('Missing binding');
        event.d1_queries++;
        const previous = { rows_read: event.rows_read, rows_written: event.rows_written, duration: event.d1_queries === 1 ? 0 : event.sql_duration_ms };
        // A failed query has unknown cost; only successful D1 metadata establishes it.
        event.rows_read = event.rows_written = null;
        let result;
        try {
          result = await env.DB.prepare(sql).bind(...params).all();
          if (result.success === false) throw new Error(result.error ?? 'D1_ERROR');
        } catch (error) {
          // Classify transient failures without returning/logging the D1 message or SQL.
          const transient = /timeout|timed out|overload|temporar|unavailable|reset|network|fetch failed|quota|limit exceeded|too many requests|D1_ERROR.*(?:busy|locked)/i.test(error.message ?? '');
          throw new HttpError(transient ? 503 : 500, transient ? 'DATABASE_UNAVAILABLE' : 'DATABASE_ERROR', transient ? 'Database temporarily unavailable' : 'Database request failed');
        }
        const meta = result.meta ?? {};
        const sum = (a, b) => a === null || finite(b) === null ? null : a + b;
        Object.assign(event, { rows_read: sum(previous.rows_read, meta.rows_read), rows_written: sum(previous.rows_written, meta.rows_written), sql_duration_ms: sum(previous.duration, meta.duration) });
        if (event.sql_duration_ms !== null) headers.set('Server-Timing', `d1;dur=${event.sql_duration_ms}`);
        return result.results;
      };
      try {
        if (request.url.length > 4096) invalid('URL is too long');
        const url = new URL(request.url);
        const detailMatch = /^\/v1\/products\/([1-9]\d*)$/.exec(url.pathname);
        const methods = detailMatch ? ['GET'] : Object.hasOwn(routes, url.pathname) ? routes[url.pathname] : null;
        if (!methods) throw new HttpError(404, 'NOT_FOUND', 'Endpoint not found');
        event.route = detailMatch ? '/v1/products/:id' : url.pathname;
        headers.set('Allow', [...methods, 'OPTIONS'].join(', '));
        if (request.method === 'OPTIONS') {
          const method = request.headers.get('access-control-request-method');
          const requested = (request.headers.get('access-control-request-headers') ?? '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
          if (method && !methods.includes(method) || requested.some(v => v !== 'content-type')) invalid('Unsupported preflight method or header');
          headers.set('Access-Control-Allow-Methods', [...methods, 'OPTIONS'].join(', '));
          headers.set('Access-Control-Allow-Headers', 'Content-Type');
          headers.set('Access-Control-Max-Age', '600');
          status = 204;
        } else {
          if (!methods.includes(request.method)) throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
          if (url.pathname !== '/v1/search' && url.search) invalid('This endpoint accepts no query parameters');
          if (detailMatch) {
            const id = Number(detailMatch[1]);
            if (!Number.isSafeInteger(id)) invalid('Invalid product ID');
            const policy = productDetailCache(url, id, env);
            const cache = injectedCache ?? globalThis.caches?.default;
            const key = cache && policy?.key;
            if (key) {
              event.cache_status = 'MISS';
              headers.set('X-Cache-TTL', String(policy.ttl));
              try {
                const hit = await readSearchCache(cache, key, policy.ttl, now());
                if (hit) { cachedBody = hit.body; event.cache_status = 'HIT'; headers.set('Age', String(hit.age)); }
              } catch { event.cache_status = 'BYPASS'; event.cache_error = 'match'; }
            }
            if (cachedBody === undefined) {
              const release = await protectSearch(env, event, {}, 'GET', key, refillGuard);
              try {
                payload = await loadProductDetail(execute, id);
                if (!payload) throw new HttpError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
                if (key) {
                  try { await writeSearchCache(cache, key, JSON.stringify(payload), policy.ttl, now()); }
                  catch { event.cache_status = 'BYPASS'; event.cache_error = 'put'; }
                }
              } finally { release(); }
            }
          } else if (url.pathname === '/v1/health') {
            await protectHealth(env, event);
            await execute('SELECT 1 AS ok');
            payload = { ok: true, database: 'available' };
          } else if (url.pathname === '/v1/categories') {
            payload = { categories };
            headers.set('Cache-Control', 'public, max-age=60, s-maxage=60');
          } else {
            const input = await searchInput(request, url);
            const { category, limit, offset, maxWindow, include, query } = validate(input);
            Object.assign(event, { category, limit, offset });
            const policy = request.method === 'GET' ? searchCachePolicy(env, input) : null;
            const cache = injectedCache ?? globalThis.caches?.default;
            const key = policy && cache ? searchCacheKey(url, input, policy) : null;
            if (key) {
              event.cache_status = 'MISS';
              headers.set('X-Cache-TTL', String(policy.ttl));
              try {
                const hit = await readSearchCache(cache, key, policy.ttl, now());
                if (hit) {
                  cachedBody = hit.body;
                  event.cache_status = 'HIT';
                  headers.set('Age', String(hit.age));
                }
              } catch { event.cache_status = 'BYPASS'; event.cache_error = 'match'; }
            }
            if (cachedBody === undefined) {
              const release = await protectSearch(env, event, input, request.method, key, refillGuard);
              try {
                const rows = await execute(query.sql, query.params);
                const hasMore = rows.length > limit;
                const nextOffset = hasMore && offset + 2 * limit <= maxWindow ? offset + limit : null;
                // Opt-in POST expansion keeps existing GET/cache and default POST
                // payloads exact. One bounded indexed query covers only this page.
                const page = rows.slice(0, limit);
                const extras = new Map(page.map(row => [row.id, Object.fromEntries(include.map(key => [key, key === 'identifiers' ? [] : {}]))]));
                if (include.length && page.length) {
                  const ids = page.map(row => row.id);
                  const binds = ids.map((_, i) => `?${i + 1}`).join(',');
                  const selections = [];
                  if (include.includes('identifiers')) selections.push(`SELECT product_id,'identifiers' AS kind,json_object('type',type,'value',value,'region',region,'origin',origin,'origin_field',origin_field) AS payload FROM identifiers WHERE product_id IN (${binds})`);
                  if (include.includes('facets')) selections.push(`SELECT product_id,'facets' AS kind,json_object('attribute',attribute,'value',value) AS payload FROM product_facets WHERE product_id IN (${binds})`);
                  for (const row of await execute(`${selections.join(' UNION ALL ')} ORDER BY product_id,kind,payload`, ids)) {
                    const value = JSON.parse(row.payload);
                    const item = extras.get(row.product_id);
                    if (row.kind === 'identifiers') item.identifiers.push(value);
                    else (item.facets[value.attribute] ??= []).push(value.value);
                  }
                }
                payload = {
                  data: page.map(row => ({
                    ...Object.fromEntries(productFields.map(key => [key, row[key] ?? null])),
                    specs: Object.fromEntries(Object.keys(models[category].fields).map(key => [key, row[key] ?? null])),
                    ...extras.get(row.id),
                  })),
                  meta: { limit, offset, returned: Math.min(rows.length, limit), has_more: hasMore, next_offset: nextOffset,
                    window_limit: maxWindow, window_exhausted: hasMore && nextOffset === null, source },
                };
                if (key) {
                  try {
                    // Await the small write so a sequential request can immediately HIT.
                    // Cache unavailability must never turn a successful search into 500.
                    await writeSearchCache(cache, key, JSON.stringify(payload), policy.ttl, now());
                  } catch { event.cache_status = 'BYPASS'; event.cache_error = 'put'; }
                }
              } finally { release(); }
            }
          }
        }
      } catch (error) {
        const known = error instanceof HttpError || error instanceof ProtectionError;
        status = known ? error.status : 500;
        const code = known ? error.code : 'INTERNAL_ERROR';
        payload = { error: { code, message: known ? error.message : 'Internal server error' }, request_id: requestId };
        event.error_code = code;
        event.cache_status = 'BYPASS';
        headers.delete('X-Cache-TTL');
        if (status === 503) headers.set('Retry-After', '30');
        if (error instanceof ProtectionError) headers.set('Retry-After', String(error.retryAfter));
      }
      Object.assign(event, { status, elapsed_ms: Math.round((performance.now() - started) * 100) / 100 });
      headers.set('X-Cache', event.cache_status);
      // Only bounded operational dimensions: never URL, keyword, filters, SQL, stack or secrets.
      try { log(event); } catch { /* Telemetry must not break the public response. */ }
      return new Response(status === 204 ? null : cachedBody ?? JSON.stringify(payload), { status, headers });
    },
  };
}

export default createWorker();
