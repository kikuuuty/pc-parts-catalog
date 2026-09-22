import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { openDatabase } from '../src/database.js';
import { filterRegistry } from '../src/filter-schema.js';
import { loadDynamicFacets } from '../src/dynamic-facets.js';
import { hasCatalogFullScan } from '../src/queries.js';
import { saveValidationReport } from './lib/validation-report.js';

const { values: args } = parseArgs({ options: {
  output: { type: 'string', default: '.cache/facet-benchmark.json' },
} });
// Deliberately local/read-only. Diagnostic setup and EXPLAIN statements are
// accounted separately from the UI request's SQL/reads/duration.
const db = await openDatabase();
const report = { status: 'running', measurement: 'local D1/workerd, sequential query adapter; production uses one batch',
  measured_at: new Date().toISOString(), rows_read_note: 'Local D1 meta.rows_read; not a measurement of production Cloudflare D1. Node fixture results.length is NOT used as a cost estimate.',
  diagnostic_statements: 0, cases: [] };
const diagnostic = async (sql, params = []) => { report.diagnostic_statements++; return (await db.query(sql, params)).results; };
try {
  report.catalog = await diagnostic('SELECT category,count(*) AS active FROM products WHERE active=1 GROUP BY category');
  report.sync = await diagnostic("SELECT source_commit FROM sync_runs WHERE status='complete' ORDER BY finished_at DESC LIMIT 1");
  const cpu = (await diagnostic("SELECT s.socket FROM cpu s CROSS JOIN products p ON p.id=s.product_id WHERE p.active=1 AND p.category='cpu' AND s.manufacturer=? AND s.socket IS NOT NULL GROUP BY s.socket ORDER BY count(*) DESC,s.socket LIMIT 1", ['Intel']))[0];
  const motherboard = (await diagnostic("SELECT s.socket FROM motherboard s CROSS JOIN products p ON p.id=s.product_id WHERE p.active=1 AND p.category='motherboard' AND s.socket IS NOT NULL GROUP BY s.socket ORDER BY count(*) DESC,s.socket LIMIT 1"))[0];
  const gpu = (await diagnostic("SELECT s.chip_vendor FROM gpu s CROSS JOIN products p ON p.id=s.product_id WHERE p.active=1 AND p.category='gpu' AND s.chip_vendor IS NOT NULL GROUP BY s.chip_vendor ORDER BY count(*) DESC,s.chip_vendor LIMIT 1"))[0];
  assert(cpu && motherboard && gpu, 'Benchmark needs populated CPU, motherboard and GPU categories');
  const cases = [
    { name: 'cpu-empty', category: 'cpu', input: {} },
    { name: 'cpu-manufacturer', category: 'cpu', input: { filters: { manufacturer: ['Intel'] } } },
    { name: 'cpu-manufacturer-socket', category: 'cpu', input: { filters: { manufacturer: ['Intel'], socket: [cpu.socket] } } },
    { name: 'motherboard-socket', category: 'motherboard', input: { filters: { socket: [motherboard.socket] } } },
    { name: 'gpu-chip-vendor', category: 'gpu', input: { filters: { chip_vendor: [gpu.chip_vendor] } } },
    { name: 'keyboard-empty-multivalue', category: 'keyboard', input: {} },
  ];
  const metric = (metas, key) => metas.every(m => Number.isFinite(m[key]) && m[key] >= 0) ? metas.reduce((sum, m) => sum + m[key], 0) : null;
  for (const c of cases) {
    const item = { ...c, statements: [], sql_queries: 0, production_binding_operations: 1 };
    report.cases.push(item);
    const body = await loadDynamicFacets(async queries => {
      const rows = [];
      for (const q of queries) {
        const plan = (await diagnostic(`EXPLAIN QUERY PLAN ${q.sql}`, q.params)).map(r => r.detail);
        assert(!hasCatalogFullScan(plan) && !plan.some(d => /^SCAN f\b/.test(d)), 'Unbounded catalog/facet scan');
        const start = performance.now();
        const result = await db.query(q.sql, q.params);
        item.sql_queries++;
        item.statements.push({ plan, meta: result.meta ?? {}, adapter_wall_ms: performance.now() - start, returned_groups: result.results.length });
        rows.push(result.results);
      }
      return rows;
    }, c.category, c.input);
    const metas = item.statements.map(s => s.meta);
    item.rows_read = metric(metas, 'rows_read'); item.rows_written = metric(metas, 'rows_written'); item.sql_duration_ms = metric(metas, 'duration');
    item.adapter_wall_ms = item.statements.reduce((n, s) => n + s.adapter_wall_ms, 0);
    item.options = Object.fromEntries(Object.entries(body.facets).map(([id, f]) => [id, f.options.length]));
    item.returned_options = Object.values(item.options).reduce((n, v) => n + v, 0);
    const fieldCount = filterRegistry[c.category].filter(d => d.control === 'multi_select').length;
    assert(item.sql_queries <= Math.min(fieldCount, 1 + Object.keys(c.input.filters ?? {}).length), 'Unexpected per-field query amplification');
    assert.equal(item.rows_written, 0, 'Facets must be read-only');
    assert.notEqual(item.rows_read, null, 'Missing D1 read measurement');
    // Category-sized guard, including JSON unpivot rows and mixed multivalue
    // candidate materialization. Diagnostic queries are excluded.
    const active = report.catalog.find(r => r.category === c.category).active;
    item.read_budget = active * (fieldCount + 12) * item.sql_queries + 100;
    assert(item.rows_read <= item.read_budget, 'Facet read budget exceeded');
  }
  report.status = 'passed';
  await saveValidationReport(args.output, report);
  console.log(JSON.stringify({ output: args.output, status: report.status, cases: report.cases.map(({ statements, ...c }) => c) }, null, 2));
} catch (error) {
  report.status = 'failed';
  await saveValidationReport(args.output, report, error);
  throw error;
} finally { await db.close(); }
