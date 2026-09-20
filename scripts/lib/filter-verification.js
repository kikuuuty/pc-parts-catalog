import assert from 'node:assert/strict';
import { categories, models } from '../../src/model.js';
import { filterRegistry, filterType, validateFilterRegistry } from '../../src/filter-schema.js';
import { loadFilterMetadata, MAX_FILTER_OPTIONS, FilterOptionLimitError } from '../../src/filter-metadata.js';
import { hasCatalogFullScan, searchQuery } from '../../src/queries.js';
import { catalogState, assertCatalogState } from '../../src/quality/catalog.js';
import { saveValidationReport } from './validation-report.js';

const compare = (a, b) => typeof a === 'string' ? (a < b ? -1 : a > b ? 1 : 0) : a - b;
const valid = (value, type) => type === 'TEXT' ? typeof value === 'string' && value.trim().length > 0 && value.length <= 200
  : typeof value === 'number' && Number.isFinite(value) && (type !== 'INTEGER' || Number.isInteger(value));

export function assertFilterContract(body, category, definitions = filterRegistry[category]) {
  assert.equal(body.category, category, 'Filter category differs');
  assert(Array.isArray(body.filters), 'Missing filters array');
  assert.deepEqual(body.filters.map(f => f.id), definitions.map(d => d.id), 'Filter IDs/order differ');
  for (const [i, f] of body.filters.entries()) {
    const d = definitions[i], type = filterType(category, d);
    assert.deepEqual([f.label, f.control, f.target, f.value_type, f.unit],
      [d.label, d.control, d.target, { TEXT: 'string', INTEGER: 'integer', REAL: 'number' }[type], d.unit], `Filter definition differs: ${category}.${d.id}`);
    if (d.control === 'range') {
      assert(!Object.hasOwn(f, 'options'), 'Range must not advertise options');
      if (f.range === null) continue;
      assert(f.range && valid(f.range.min, type) && valid(f.range.max, type) && f.range.min <= f.range.max, 'Invalid finite range');
      assert(Number.isFinite(f.range.step) && f.range.step > 0 && f.range.step === d.step, 'Invalid range step');
      // Step is a UI increment. Endpoints need not be divisible by it.
      searchQuery(category, { ranges: { [d.id]: { min: f.range.min } } });
    } else {
      assert(!Object.hasOwn(f, 'range'), 'Selection must not advertise range');
      assert(Array.isArray(f.options) && f.options.length <= MAX_FILTER_OPTIONS, 'Invalid options/limit');
      for (const [j, o] of f.options.entries()) {
        assert(valid(o.value, type), 'Invalid option JSON type/value');
        assert.equal(o.label, d.optionLabels?.[o.value] ?? String(o.value), 'Invalid option label');
        if (j) assert(compare(f.options[j - 1].value, o.value) < 0, 'Options must be unique and deterministic');
        searchQuery(category, { [d.target]: { [d.id]: [o.value] } });
      }
    }
  }
}

// Independent source oracle: never executes metadata SQL or reads raw DB JSON.
// The caller validates the snapshot and source integrity before release use.
export function assertFilterSource(body, records) {
  const model = models[body.category];
  for (const f of body.filters) {
    try {
      const type = filterType(body.category, f);
      const values = records.flatMap(r => f.target === 'facets' ? r.facets.filter(v => v.attribute === f.id).map(v => v.value)
        : [Object.hasOwn(model.fields, f.id) ? r.spec[f.id] : r.product[f.id]]).filter(v => valid(v, type));
      if (f.control === 'range') {
        const sorted = values.sort(compare);
        assert.deepEqual(f.range && [f.range.min, f.range.max], sorted.length ? [sorted[0], sorted.at(-1)] : null, `Source range differs: ${body.category}.${f.id}`);
      } else assert.deepEqual(f.options.map(o => o.value), [...new Set(values)].sort(compare), `Source options differ: ${body.category}.${f.id}`);
    } catch (error) { error.filterField = f.id; throw error; }
  }
}

// Read-only, caller-owned adapter (including releaseOwner). Never opens/closes DB.
export async function verifyFilterMetadata(db, { snapshot, output, measurement = 'caller D1 query adapter' } = {}) {
  const report = { schema_version: 1, status: 'running', pass: false, snapshot_commit: snapshot?.commit ?? null,
    sync: null, measurement, categories: [], sql_statements: 0, adapter_operations: 0, plan_statements: 0,
    rows_read: 0, rows_written: 0, worker_binding_operations: null };
  try {
    validateFilterRegistry();
    report.sync = await catalogState(db);
    assert(snapshot && snapshot.commit === report.sync?.source_commit, 'Filter evaluation snapshot differs');
    const byCategory = new Map(categories.map(c => [c, []]));
    for (const r of snapshot.records) byCategory.get(r.product.category).push(r);
    for (const category of categories) {
      const records = byCategory.get(category);
      const item = { category, status: 'running', active: records.length, sql_statements: 0, adapter_operations: 0, rows_read: 0, rows_written: 0, statements: [] };
      report.categories.push(item);
      try {
        const body = await loadFilterMetadata(async queries => {
          const results = [];
          for (const q of queries) {
            report.plan_statements++;
            const plan = (await db.query(`EXPLAIN QUERY PLAN ${q.sql}`, q.params)).results.map(r => r.detail);
            item.statements.push({ plan });
            assert(!hasCatalogFullScan(plan) && !plan.some(d => /^SCAN f\b/.test(d)), 'Filter full scan');
            item.sql_statements++; item.adapter_operations++; report.sql_statements++; report.adapter_operations++;
            const result = await db.query(q.sql, q.params), meta = result.meta ?? {};
            item.statements.at(-1).meta = Object.fromEntries(['rows_read', 'rows_written', 'duration', 'served_by'].map(k => [k, meta[k] ?? null]));
            for (const key of ['rows_read', 'rows_written']) {
              if (!Number.isFinite(meta[key]) || meta[key] < 0) { item[key] = report[key] = null; throw new Error('Missing filter cost metadata'); }
              item[key] += meta[key]; report[key] += meta[key];
            }
            results.push(result.results);
          }
          return results;
        }, category);
        assertFilterContract(body, category);
        assertFilterSource(body, records);
        const facetRows = body.filters.some(f => f.target === 'facets') ? records.reduce((n, r) => n + r.facets.length, 0) : 0;
        item.read_budget = records.length * 4 + facetRows * 2 + 100;
        assert(item.rows_read <= item.read_budget, 'Filter metadata read budget exceeded');
        assert.equal(item.rows_written, 0, 'Filter metadata must be read-only');
        item.filters = body.filters.map(f => ({ id: f.id, target: f.target, option_count: f.options?.length, range: f.range }));
        item.status = 'passed';
      } catch (error) {
        item.status = 'failed';
        if (item.statements.some(s => !s.meta) && item.sql_statements > 0) {
          item.rows_read = report.rows_read = null; item.rows_written = report.rows_written = null;
        }
        item.failure = error instanceof FilterOptionLimitError ? { kind: 'option_limit', category: error.category, field: error.field, count: error.option_count, limit: error.limit }
          : { kind: 'contract_source_plan_or_cost', field: error.filterField ?? null, message: 'Filter metadata validation failed; inspect category and statement metrics' };
        throw error;
      }
    }
    await assertCatalogState(db, report.sync);
    report.status = 'passed'; report.pass = true;
    if (output) await saveValidationReport(output, report);
    return report;
  } catch (error) {
    report.status = 'failed'; report.pass = false;
    if (output) await saveValidationReport(output, report, error);
    error.filterMetadataReport = report;
    throw error;
  }
}
