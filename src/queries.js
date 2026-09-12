import { models } from './model.js';
import { identifierKey } from './normalize.js';

const common = { manufacturer: 'TEXT', series: 'TEXT', variant: 'TEXT', release_year: 'INTEGER' };
export function keywordExpression(value) {
  if (typeof value !== 'string' || value.length > 200) throw new Error('Keyword must be at most 200 characters');
  const tokens = value.normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!tokens.length || tokens.length > 12) throw new Error('Keyword needs 1–12 letter/number tokens');
  return tokens.map(t => `"${t}"*`).join(' AND ');
}
export function searchQuery(category, { keyword, filters = {}, ranges = {}, facets = {}, identifier, limit = 20, orderBy } = {}) {
  if (typeof category !== 'string' || !Object.hasOwn(models, category)) throw new Error(`Unknown category: ${category}`);
  const model = models[category];
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be 1–100');
  const fields = { ...common, ...model.fields };
  const column = key => {
    if (!Object.hasOwn(fields, key)) throw new Error(`Unknown ${category} filter: ${key}`);
    return `${Object.hasOwn(model.fields, key) ? 's' : 'p'}.${key}`;
  };
  const where = ['p.active=1', 'p.category=?'];
  const params = [category];
  for (const [key, raw] of Object.entries(filters)) {
    const col = column(key);
    const values = Array.isArray(raw) ? raw : [raw];
    if (!values.length || values.length > 20) throw new Error('Each selection needs 1–20 values');
    for (const value of values) {
      if (fields[key] === 'TEXT' ? typeof value !== 'string' || !value.length : typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid value for ${key}`);
    }
    where.push(`${col} IN (${values.map(() => '?').join(',')})`);
    params.push(...values);
  }
  for (const [key, range] of Object.entries(ranges)) {
    const col = column(key);
    if (fields[key] === 'TEXT' || !range || typeof range !== 'object' || Array.isArray(range) || Object.keys(range).some(k => !['min','max'].includes(k))) throw new Error(`Invalid range: ${key}`);
    if (range.min === undefined && range.max === undefined) throw new Error(`Empty range: ${key}`);
    if (range.min !== undefined && range.max !== undefined && range.min > range.max) throw new Error(`min > max: ${key}`);
    for (const [bound, op] of [['min', '>='], ['max', '<=']]) {
      if (range[bound] === undefined) continue;
      if (typeof range[bound] !== 'number' || !Number.isFinite(range[bound])) throw new Error(`Invalid range value: ${key}`);
      where.push(`${col}${op}?`);
      params.push(range[bound]);
    }
  }
  for (const [attribute, raw] of Object.entries(facets)) {
    if (!['memory_type','socket','motherboard_form_factor','psu_form_factor'].includes(attribute)) throw new Error('Unknown facet');
    const values = Array.isArray(raw) ? raw : [raw];
    if (!values.length || values.length > 20 || values.some(v => typeof v !== 'string' || !v.length)) throw new Error('Invalid facet values');
    // With selective typed filters, probe a candidate product's small facet set.
    // With facets alone, allow the reverse facet index to supply candidate IDs.
    const hasTypedFilters = Object.keys(filters).length || Object.keys(ranges).length;
    where.push(hasTypedFilters
      ? `EXISTS (SELECT 1 FROM product_facets f WHERE f.product_id=p.id AND f.attribute=? AND f.value IN (${values.map(() => '?').join(',')}))`
      : `p.id IN (SELECT product_id FROM product_facets WHERE attribute=? AND value IN (${values.map(() => '?').join(',')}))`);
    params.push(attribute, ...values);
  }
  if (identifier) {
    if (typeof identifier.value !== 'string' || !identifier.value.trim() || (identifier.type && !['mpn','gtin','ean','upc','jan'].includes(identifier.type))) throw new Error('Invalid identifier');
    where.push(`p.id IN (SELECT product_id FROM identifiers WHERE value_key=?${identifier.type ? ' AND type=?' : ''})`);
    params.push(identifierKey(identifier.value));
    if (identifier.type) params.push(identifier.type);
  }
  if (keyword !== undefined) {
    const expression = keywordExpression(keyword);
    where.push(`p.id IN (
      SELECT rowid FROM product_fts WHERE product_fts MATCH ?
      UNION SELECT i.product_id FROM local_identifier_fts JOIN local_identifiers i ON i.id=local_identifier_fts.rowid WHERE local_identifier_fts MATCH ?
    )`);
    params.push(expression, expression);
  }
  const order = orderBy ? `${column(orderBy)},s.product_id` : 'p.id';
  params.push(limit);
  if (params.length > 100) throw new Error('D1 supports at most 100 bound parameters');
  return {
    sql: `SELECT p.id,p.upstream_id,p.upstream_key,p.category,p.manufacturer,p.name,p.series,p.variant,p.release_year,p.manufacturer_url,s.* FROM products p JOIN ${model.table} s ON s.product_id=p.id WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`,
    params,
  };
}

export const representativeQueries = [
  { name: '1 CPU Intel Core i7', category: 'cpu', options: { filters: { manufacturer: 'Intel', family: 'Core i7' }, orderBy: 'core_count' }, indexes: ['cpu_family_cores'] },
  { name: '2 CPU AMD Ryzen 7 cores >=8', category: 'cpu', options: { filters: { manufacturer: 'AMD', family: 'Ryzen 7' }, ranges: { core_count: { min: 8 } }, orderBy: 'core_count' }, indexes: ['cpu_family_cores'] },
  { name: '3 GPU NVIDIA VRAM >=16 length <=320', category: 'gpu', options: { filters: { chip_vendor: 'NVIDIA' }, ranges: { vram_gb: { min: 16 }, length_mm: { max: 320 } }, orderBy: 'vram_gb' }, indexes: ['gpu_vendor_vram'] },
  { name: '4 RAM DDR5 capacity >=32 speed >=6000', category: 'memory', options: { filters: { ram_type: 'DDR5' }, ranges: { capacity_gb: { min: 32 }, speed: { min: 6000 } }, orderBy: 'speed' }, indexes: ['memory_type_speed'] },
  { name: '5 PSU ATX >=850W', category: 'psu', options: { filters: { form_factor: 'ATX' }, ranges: { wattage: { min: 850 } }, orderBy: 'wattage' }, indexes: ['psu_form_wattage'] },
  { name: '6 Case GPU clearance >=350', category: 'case', options: { ranges: { max_gpu_length_mm: { min: 350 } }, orderBy: 'max_gpu_length_mm' }, indexes: ['case_gpu_clearance'] },
  { name: '7 MPN exact', category: 'cpu', options: { identifier: { type: 'mpn', value: 'BX80768285K' } }, indexes: ['upstream_identifier_exact','local_identifier_exact'] },
  { name: '8 Keyword RTX 5080 + GPU filters', category: 'gpu', options: { keyword: 'RTX 5080', filters: { chip_vendor: 'NVIDIA' }, ranges: { length_mm: { min: 250, max: 320 } } }, indexes: ['VIRTUAL TABLE INDEX'] },
  { name: '9 Storage capacity + PCIe gen', category: 'storage', options: { filters: { storage_type: 'SSD' }, ranges: { capacity_gb: { min: 1000 }, pcie_generation: { min: 4 } }, orderBy: 'capacity_gb' }, indexes: ['storage_type_capacity'] },
  { name: '10 Fan size + airflow + noise', category: 'case_fan', options: { filters: { size_mm: 120 }, ranges: { airflow_max_cfm: { min: 60 }, noise_max_db: { max: 25 } }, orderBy: 'airflow_max_cfm' }, indexes: ['fan_size_airflow'] },
  { name: '11 Cooler air + height + socket', category: 'cpu_cooler', options: { filters: { water_cooled: 0 }, ranges: { height_mm: { max: 160 } }, facets: { socket: 'AM5' }, orderBy: 'height_mm' }, indexes: ['cooler_type_height'] },
  { name: '12 Cooler socket facet', category: 'cpu_cooler', options: { facets: { socket: 'AM5' } }, indexes: ['facets_value'] },
];

export async function verifyPlans(db) {
  const reports = [];
  for (const q of representativeQueries) {
    const { sql, params } = searchQuery(q.category, q.options);
    const plan = await db.query(`EXPLAIN QUERY PLAN ${sql}`, params);
    const details = plan.results.map(r => r.detail);
    const rows = await db.query(sql, params);
    const used = q.indexes.every(index => details.some(d => d.includes(index)));
    reports.push({ name: q.name, sql, params, plan: details, index_check: used, returned: rows.results.length, meta: rows.meta });
  }
  return reports;
}
