import { models } from './model.js';
import { CACHE_SCHEMA_GENERATION, searchCachePolicy } from './search-cache.js';

export const detailProductQuery = { sql: `SELECT id,source,upstream_id,upstream_key,category,manufacturer,name,series,variant,release_year,manufacturer_url FROM products WHERE id=? AND active=1` };
export function detailQueries(category) {
  if (!Object.hasOwn(models, category)) throw new Error('Unknown category');
  return {
    spec: `SELECT * FROM ${models[category].table} WHERE product_id=?`,
    identifiers: 'SELECT type,value,region,origin,origin_field FROM identifiers WHERE product_id=? ORDER BY type,value,region,origin,origin_field',
    facets: 'SELECT attribute,value FROM product_facets WHERE product_id=? ORDER BY attribute,value',
  };
}

// Exact duplicates only: do not collapse regional or provider-significant spellings.
// Representative origin fields preserve the search expansion contract; origins
// records every provenance pair without selecting a preferred price lookup code.
export function canonicalIdentifiers(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.type, row.value, row.region]);
    if (!groups.has(key)) groups.set(key, { ...row, origins: [] });
    const item = groups.get(key), origin = { origin: row.origin, origin_field: row.origin_field };
    if (!item.origins.some(o => o.origin === origin.origin && o.origin_field === origin.origin_field)) item.origins.push(origin);
  }
  return [...groups.values()];
}

export function productDetailCache(url, id, env) {
  const base = searchCachePolicy(env, {});
  if (!base) return null;
  const ttl = 600;
  const key = new URL(`/__catalog_cache/product/${CACHE_SCHEMA_GENERATION}/${id}`, url.origin);
  key.searchParams.set('epoch', base.epoch);
  key.searchParams.set('ttl', String(ttl));
  return { ttl, key: new Request(key) };
}

export async function loadProductDetail(execute, id, executeBatch) {
  const [product] = await execute(detailProductQuery.sql, [id]);
  if (!product) return null;
  const queries = detailQueries(product.category);
  const statements = Object.values(queries).map(sql => ({ sql, params: [id] }));
  // Worker uses one D1 batch; CLI/read-only adapters retain their query interface.
  const [[spec], identifierRows, facets] = executeBatch
    ? await executeBatch(statements)
    : await Promise.all(statements.map(({ sql, params }) => execute(sql, params)));
  const identifiers = canonicalIdentifiers(identifierRows);
  return { ...product, identifiers,
    spec: Object.fromEntries(Object.keys(models[product.category].fields).map(k => [k, spec?.[k] ?? null])), facets };
}
