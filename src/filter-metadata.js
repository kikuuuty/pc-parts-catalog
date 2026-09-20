import { models } from './model.js';
import { filterRegistry, filterType } from './filter-schema.js';
import { scalarField } from './search-fields.js';

export const FILTER_API_VERSION = 'v1';
export const MAX_FILTER_OPTIONS = 512;
export class FilterOptionLimitError extends Error {
  constructor(category, field, count) {
    super(`Filter option limit exceeded: ${category}.${field} (${count})`);
    Object.assign(this, { category, field, option_count: count, limit: MAX_FILTER_OPTIONS });
  }
}
const types = { TEXT: 'string', INTEGER: 'integer', REAL: 'number' };
const numeric = (column, type) => `CASE WHEN typeof(${column}) IN ('integer','real') AND ${column} BETWEEN -1.7976931348623157e308 AND 1.7976931348623157e308${type === 'INTEGER' ? ` AND ${column}=cast(${column} AS INTEGER)` : ''} THEN ${column} END`;

export function filterMetadataQueries(category) {
  if (!Object.hasOwn(filterRegistry, category)) throw new Error('Unknown category');
  const model = models[category], definitions = filterRegistry[category];
  const scalars = definitions.filter(d => d.target !== 'facets');
  const facets = definitions.filter(d => d.target === 'facets');
  const queries = [];
  if (scalars.length) {
    const projection = scalars.flatMap(d => {
      const { type, column } = scalarField(model, d.id);
      const value = type === 'TEXT' ? `CASE WHEN typeof(${column})='text' AND length(trim(${column}))>0 THEN ${column} END` : numeric(column, type);
      return d.control === 'range' ? [`min(${value}) AS ${d.id}_min`, `max(${value}) AS ${d.id}_max`]
        : [`json_group_array(DISTINCT ${value}) AS ${d.id}`];
    });
    // One category index walk for ALL scalar aggregates, not one scan per field.
    // CROSS JOIN fixes the bounded category-first traversal; specs are PK probes.
    const join = scalars.some(d => scalarField(model, d.id).column.startsWith('s.')) ? ` CROSS JOIN ${model.table} s ON s.product_id=p.id` : '';
    queries.push({ sql: `SELECT ${projection.join(',')} FROM products p INDEXED BY products_category_manufacturer_series${join} WHERE p.active=1 AND p.category=?`, params: [category] });
  }
  if (facets.length) queries.push({
    // Unary + keeps the product_id lookup, then tests its small facet set once.
    // An attribute IN seek otherwise repeats empty PK probes per product × field.
    sql: `SELECT f.attribute,json_group_array(DISTINCT f.value) AS options FROM products p INDEXED BY products_category_manufacturer_series CROSS JOIN product_facets f ON f.product_id=p.id WHERE p.active=1 AND p.category=? AND +f.attribute IN (${facets.map(() => '?').join(',')}) AND typeof(f.value)='text' AND length(trim(f.value))>0 GROUP BY f.attribute`,
    params: [category, ...facets.map(d => d.id)],
  });
  return queries;
}

export async function loadFilterMetadata(executeBatch, category) {
  const definitions = filterRegistry[category];
  const queries = filterMetadataQueries(category);
  const results = queries.length ? await executeBatch(queries) : [];
  const hasScalars = definitions.some(d => d.target !== 'facets');
  const scalar = hasScalars ? results[0][0] : {};
  const facets = new Map((results[hasScalars ? 1 : 0] ?? []).map(r => [r.attribute, r.options]));
  const filters = definitions.map(d => {
    const type = filterType(category, d);
    const result = { id: d.id, label: d.label, control: d.control, target: d.target, value_type: types[type], unit: d.unit };
    if (d.control === 'range') {
      const min = scalar[`${d.id}_min`], max = scalar[`${d.id}_max`];
      result.range = Number.isFinite(min) && Number.isFinite(max) && min <= max ? { min, max, step: d.step } : null;
    } else {
      const values = JSON.parse(d.target === 'facets' ? facets.get(d.id) ?? '[]' : scalar[d.id] ?? '[]')
        .filter(v => type === 'TEXT' ? typeof v === 'string' && v.trim().length > 0 && v.length <= 200
          : Number.isFinite(v) && (type !== 'INTEGER' || Number.isInteger(v)))
        .sort((a, b) => type === 'TEXT' ? (a < b ? -1 : a > b ? 1 : 0) : a - b);
      // Never silently truncate and advertise an incomplete selection list.
      if (values.length > MAX_FILTER_OPTIONS) throw new FilterOptionLimitError(category, d.id, values.length);
      result.options = values.map(value => ({ value, label: d.optionLabels?.[value] ?? String(value) }));
    }
    return result;
  });
  return { category, filters };
}

export function filterMetadataCache(url, category, env) {
  const epoch = env.CATALOG_CACHE_EPOCH;
  if (typeof epoch !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(epoch)) return null;
  const ttl = 600;
  const key = new URL(`/__catalog_cache/filters/${FILTER_API_VERSION}/${category}`, url.origin);
  key.searchParams.set('epoch', epoch);
  return { ttl, key: new Request(key, { method: 'GET' }) };
}
