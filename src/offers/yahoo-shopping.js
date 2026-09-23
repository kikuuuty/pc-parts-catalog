import { OfferProviderError, unavailable, rateLimited } from './errors.js';

export const yahooShops = Object.freeze({
  'tsukumo-y': 'tsukumo', 'arkonline-store': 'ark', 'dospara-y': 'dospara',
  'pc-koubou': 'pc-koubou', goodwill: 'goodwill', 'applied-net': 'applied',
  'e-zoa': 'e-zoa', 'y-sofmap': 'sofmap', 'y-kojima': 'kojima', joshin: 'joshin',
  'etrend-y': 'etrend', murauchi: 'murauchi', 'pc-express': 'caravan-yu',
});
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = v => typeof v === 'string' && v.trim().length > 0;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function safeUrl(value) {
  if (!text(value)) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? value : null;
  } catch { return null; }
}

/** @returns {import('./model.js').ImageVariant|null} */
function imageVariant(value, width, height) {
  const url = safeUrl(value);
  if (!url) return null;
  const dimension = n => Number.isSafeInteger(n) && n > 0 ? n : null;
  return { url, width: dimension(width), height: dimension(height) };
}

/** @returns {import('./model.js').OfferImage} */
function yahooImage(hit) {
  return {
    id: text(hit.imageId) ? hit.imageId : null,
    small: imageVariant(hit.image?.small, 76, 76),
    medium: imageVariant(hit.image?.medium, 146, 146),
    // Response dimensions are authoritative; do not infer them from image_size.
    preferred: imageVariant(hit.exImage?.url, hit.exImage?.width, hit.exImage?.height),
  };
}

export function normalizeYahooOffers(body, jan, fetchedAt) {
  if (!object(body) || !Array.isArray(body.hits) || body.hits.length > 50 ||
      !Number.isSafeInteger(body.totalResultsReturned) || body.totalResultsReturned !== body.hits.length ||
      !Number.isSafeInteger(body.totalResultsAvailable) || body.totalResultsAvailable < body.hits.length) {
    throw new OfferProviderError('malformed_response');
  }
  const offers = [];
  for (const hit of body.hits) {
    if (!object(hit)) throw new OfferProviderError('malformed_response');
    // jan is the exact lookup value, regardless of its canonical catalog type.
    // Missing or altered codes are unverified; do not repair upstream values.
    if (typeof hit.janCode !== 'string' || hit.janCode !== jan) continue;
    if (hit.inStock === false || hit.condition === 'used') continue;
    if (!text(hit.code) || !text(hit.name) || !safeUrl(hit.url) ||
        !Number.isSafeInteger(hit.price) || hit.price <= 0 || hit.inStock !== true || hit.condition !== 'new' ||
        !object(hit.seller) || !text(hit.seller.sellerId) || !text(hit.seller.name)) {
      throw new OfferProviderError('malformed_response');
    }
    const seller = hit.seller;
    /** @type {import('./model.js').SellerImage} */
    const sellerImage = { id: text(seller.imageId) ? seller.imageId : null, url: null };
    offers.push({
      provider: 'yahoo', provider_item_id: hit.code, name: hit.name, jan_code: hit.janCode,
      image: yahooImage(hit),
      seller: { id: seller.sellerId, name: seller.name, url: safeUrl(seller.url),
        image: sellerImage,
        is_best_seller: typeof seller.isBestSeller === 'boolean' ? seller.isBestSeller : null,
        ...(Object.hasOwn(yahooShops, seller.sellerId) ? { shop_key: yahooShops[seller.sellerId] } : {}),
      },
      price: hit.price,
      shipping: { code: Number.isSafeInteger(hit.shipping?.code) ? hit.shipping.code : null,
        name: text(hit.shipping?.name) ? hit.shipping.name : null },
      in_stock: hit.inStock, condition: hit.condition, url: hit.url, fetched_at: fetchedAt,
    });
  }
  // Same seller + provider code + exact URL only. Distinct listings are never merged by price.
  // Sort before dedup: conflicting duplicate rows resolve to lowest price, then full tuple.
  offers.sort((a, b) => a.price - b.price || compare(a.seller.id, b.seller.id)
    || compare(a.provider_item_id, b.provider_item_id) || compare(a.url, b.url)
    || compare(JSON.stringify(a), JSON.stringify(b)));
  const seen = new Set();
  return offers.filter(offer => {
    const key = JSON.stringify([offer.seller.id, offer.provider_item_id, offer.url]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

function retryAfter(response) {
  const value = response.headers.get('Retry-After');
  // Only bounded delta-seconds, never reflect arbitrary upstream headers.
  return /^\d{1,4}$/.test(value ?? '') && Number(value) >= 1 && Number(value) <= 3600 ? Number(value) : 60;
}

export async function fetchYahooOffers({ appId, jan, fetch: fetcher = globalThis.fetch,
  now = Date.now, timeoutMs = 5000, event = {} }) {
  if (typeof appId !== 'string' || !appId.trim()) throw unavailable('missing_app_id');
  const url = new URL('https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch');
  url.search = new URLSearchParams({ appid: appId, jan_code: jan, results: '50',
    in_stock: 'true', condition: 'new', sort: '+price', image_size: '300' }).toString();
  const controller = new AbortController();
  const started = performance.now();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(unavailable('timeout')); }, timeoutMs);
  });
  try {
    return await Promise.race([timeout, (async () => {
      // workerd supports manual/follow, not error. Reject 3xx below without following
      // Location: neither credentials nor MISS budget can escape via redirects/retries.
      const response = await fetcher(url, { signal: controller.signal, redirect: 'manual' });
      event.upstream_status_class = `${Math.floor(response.status / 100)}xx`;
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        if (response.status === 429) throw rateLimited('upstream_429', retryAfter(response));
        if (response.status >= 500) throw unavailable('upstream_5xx');
        throw new OfferProviderError(response.status >= 400 ? 'upstream_4xx' : 'upstream_status');
      }
      let body;
      try { body = await response.json(); }
      catch { throw new OfferProviderError('invalid_json'); }
      return normalizeYahooOffers(body, jan, new Date(now()).toISOString());
    })()]);
  } catch (error) {
    if (controller.signal.aborted) throw unavailable('timeout');
    if (error instanceof OfferProviderError) throw error;
    throw unavailable('network');
  } finally {
    clearTimeout(timer);
    event.upstream_duration_ms = Math.round((performance.now() - started) * 100) / 100;
  }
}
