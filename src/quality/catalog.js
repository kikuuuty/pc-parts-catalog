import { createHash } from 'node:crypto';
import { categories, models } from '../model.js';
import { identifierKey, manufacturer, text } from '../normalize.js';

export const isMissing = value => value == null || (typeof value === 'string' && !value.trim());
export const nameKey = value => text(value?.normalize('NFKC'))?.toLowerCase() ?? null;
export const manufacturerKey = value => nameKey(manufacturer(value));
export const quoteColumn = value => `"${value.replaceAll('"', '""')}"`;
export const productSummary = p => ({
  id: p.id, upstream_id: p.upstream_id, upstream_key: p.upstream_key, source: p.source ?? null,
  category: p.category, manufacturer: p.manufacturer, name: p.name, active: p.active ?? null,
});

// Reflect the existing constraint (including unpopulated JAN/GTIN) and observed types.
// Do not introduce another identifier enum in the audit tool.
export function declaredIdentifierTypes(sql) {
  const list = sql?.match(/\btype\s+IN\s*\(([^)]+)\)/i)?.[1] ?? '';
  return [...list.matchAll(/'((?:[^']|'')*)'/g)].map(m => m[1].replaceAll("''", "'"));
}

export async function catalogState(db) {
  // Administrative release gates may hold the same writer-exclusion lease.
  const running = (await db.query('SELECT owner FROM sync_lock WHERE expires_at>unixepoch()')).results.filter(r => r.owner !== db.releaseOwner);
  if (running.length) throw new Error('Catalog is being synchronized. Run quality measurements after sync finishes.');
  return (await db.query('SELECT id,source_commit,normalization_version,status,started_at,finished_at FROM sync_runs ORDER BY started_at DESC,id DESC LIMIT 1')).results[0] ?? null;
}
export async function assertCatalogState(db, initial) {
  if (JSON.stringify(await catalogState(db)) !== JSON.stringify(initial)) throw new Error('Catalog changed during measurement; rerun on an idle database.');
}

export async function loadQualityCatalog(db) {
  const sync = await catalogState(db);
  const schema = (await db.query('PRAGMA table_info(products)')).results;
  const internal = new Set(['id','source','upstream_id','upstream_key','category','active','content_hash','source_commit','normalization_version','created_at','updated_at','identity_version']);
  const productFields = schema.filter(c => !internal.has(c.name)).map(c => ({ name: c.name, type: c.type }));
  if (!schema.length) throw new Error('Catalog schema missing; run npm run db:migrate first.');
  const products = [];
  const byId = new Map();
  let servedBy = null;
  let cursor = 0;
  while (true) {
    const page = await db.query('SELECT * FROM products WHERE id>? ORDER BY id LIMIT 500', [cursor]);
    servedBy ??= page.meta?.served_by ?? null;
    const rows = page.results;
    if (!rows.length) break;
    for (const row of rows) {
      if (!categories.includes(row.category)) throw new Error(`Category not present in models: ${row.category}`);
      const p = { ...row, spec: null, identifiers: [], facets: [] };
      products.push(p);
      byId.set(p.id, p);
    }
    // Indexed product_id intervals avoid OFFSET scans and the 100-bind D1 ceiling.
    const ids = (await db.query('SELECT * FROM identifiers WHERE product_id>? AND product_id<=? ORDER BY product_id,type,value,region,origin,origin_field', [cursor, rows.at(-1).id])).results;
    for (const i of ids) byId.get(i.product_id)?.identifiers.push(i);
    const facets = (await db.query('SELECT * FROM product_facets WHERE product_id>? AND product_id<=? ORDER BY product_id,attribute,value', [cursor, rows.at(-1).id])).results;
    for (const f of facets) byId.get(f.product_id)?.facets.push(f);
    cursor = rows.at(-1).id;
  }
  for (const model of Object.values(models)) {
    let id = 0;
    while (true) {
      const rows = (await db.query(`SELECT ${['product_id', ...Object.keys(model.fields)].map(quoteColumn).join(',')} FROM ${quoteColumn(model.table)} WHERE product_id>? ORDER BY product_id LIMIT 500`, [id])).results;
      if (!rows.length) break;
      for (const spec of rows) {
        const p = byId.get(spec.product_id);
        if (p && models[p.category].table === model.table) p.spec = spec;
      }
      id = rows.at(-1).product_id;
    }
  }
  const identifierSchema = (await db.query("SELECT sql FROM sqlite_schema WHERE name='local_identifiers'")).results[0]?.sql;
  const identifierTypes = [...new Set([...declaredIdentifierTypes(identifierSchema), ...products.flatMap(p => p.identifiers.map(i => i.type))])].sort();
  const fingerprint = createHash('sha256');
  for (const p of products) fingerprint.update(JSON.stringify(p)).update('\n');
  const sources = (await db.query('SELECT * FROM sources ORDER BY id')).results;
  await assertCatalogState(db, sync);
  return {
    products, productFields, identifierTypes,
    metadata: {
      catalog_sha256: fingerprint.digest('hex'), product_count: products.length,
      active_product_count: products.filter(p => p.active === 1).length,
      served_by: servedBy, node_version: process.version, last_sync: sync, sources,
    },
  };
}

export function auditScope(options = {}) {
  const scope = {
    category: options.category ?? null, manufacturer: options.manufacturer ?? null,
    year_from: options.yearFrom ?? null, year_to: options.yearTo ?? null,
    unknown_year: options.unknownYear ?? false, include_inactive: options.includeInactive ?? false,
  };
  if (scope.category !== null && !categories.includes(scope.category)) throw new Error(`Unknown category: ${scope.category}`);
  if (scope.manufacturer !== null && (typeof scope.manufacturer !== 'string' || isMissing(scope.manufacturer))) throw new Error('manufacturer must be nonempty');
  for (const year of [scope.year_from, scope.year_to]) if (year !== null && (!Number.isInteger(year) || year < 1 || year > 9999)) throw new Error('Year must be an integer from 1 to 9999');
  if (scope.year_from !== null && scope.year_to !== null && scope.year_from > scope.year_to) throw new Error('year-from must be <= year-to');
  if (scope.unknown_year && (scope.year_from !== null || scope.year_to !== null)) throw new Error('unknown-year cannot be combined with year-from/year-to');
  return scope;
}
export function inScope(p, scope, activeFilter = true) {
  if (scope.category && p.category !== scope.category) return false;
  if (scope.manufacturer && manufacturerKey(p.manufacturer) !== manufacturerKey(scope.manufacturer)) return false;
  if (activeFilter && !scope.include_inactive && p.active !== 1) return false;
  if (scope.unknown_year && !isMissing(p.release_year)) return false;
  if (scope.year_from !== null || scope.year_to !== null) {
    if (!Number.isInteger(p.release_year)) return false;
    if (scope.year_from !== null && p.release_year < scope.year_from) return false;
    if (scope.year_to !== null && p.release_year > scope.year_to) return false;
  }
  return true;
}

export const validIdentifiers = p => p.identifiers.filter(i => !isMissing(i.type) && !isMissing(i.value));
export const normalizedIdentifier = i => identifierKey(i.value);
export const envelope = (kind, catalog, scope) => ({
  schema_version: 1, kind, generated_at: new Date().toISOString(), catalog: catalog.metadata, scope,
});
