import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { openDatabase } from '../src/database.js';
import { categories } from '../src/model.js';
import { filterMetadataQueries, loadFilterMetadata } from '../src/filter-metadata.js';
import { filterRegistry } from '../src/filter-schema.js';
import { hasCatalogFullScan } from '../src/queries.js';

// Read-only local D1 cost/plan gate. Optional real Worker HTTP comparison.
const { values: args } = parseArgs({ options: { url: { type: 'string' }, output: { type: 'string', default: '.cache/filter-verification.json' } } });
if (args.url) assert(['http://127.0.0.1:8787', 'http://localhost:8787'].includes(args.url), 'Use the local Worker (comparison DB is local)');
const db = await openDatabase();
const report = [];
try {
  for (const category of categories) {
    const statements = [];
    const metadata = await loadFilterMetadata(async queries => {
      const results = [];
      for (const query of queries) {
        const plan = (await db.query(`EXPLAIN QUERY PLAN ${query.sql}`, query.params)).results.map(r => r.detail);
        assert(!hasCatalogFullScan(plan), plan.join('\n'));
        assert(!plan.some(d => /^SCAN f\b/.test(d)), plan.join('\n'));
        const result = await db.query(query.sql, query.params);
        statements.push({ plan, meta: result.meta });
        results.push(result.results);
      }
      return results;
    }, category);
    const active = (await db.query('SELECT count(*) AS n FROM products WHERE category=? AND active=1', [category])).results[0].n;
    const facetIds = filterRegistry[category].filter(d => d.target === 'facets').map(d => d.id);
    const facetRows = facetIds.length ? (await db.query(`SELECT count(*) AS n FROM products p CROSS JOIN product_facets f ON f.product_id=p.id WHERE p.category=? AND p.active=1 AND f.attribute IN (${facetIds.map(() => '?').join(',')})`, [category, ...facetIds])).results[0].n : 0;
    const rowsRead = statements.reduce((sum, s) => sum + s.meta.rows_read, 0);
    assert(Number.isFinite(rowsRead));
    // Single category traversal plus PK/facet probes; never fields × catalog.
    assert(rowsRead <= active * 4 + facetRows * 2 + 100, `Metadata read budget exceeded: ${category} (${rowsRead}/${active}/${facetRows})`);
    assert.equal(statements.reduce((sum, s) => sum + s.meta.rows_written, 0), 0);
    let http;
    if (args.url) {
      await delay(3400); // Share the existing expensive-MISS protection budget.
      const url = `${args.url}/v1/categories/${category}/filters`;
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      assert.equal(response.status, 200, category);
      assert.deepEqual(await response.json(), metadata);
      const repeat = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      assert.equal(repeat.status, 200);
      assert.equal(repeat.headers.get('X-Cache'), 'HIT');
      assert.equal(repeat.headers.get('Server-Timing'), null);
      assert.deepEqual(await repeat.json(), metadata);
      http = { status: response.status, cache: response.headers.get('X-Cache'), repeat_cache: repeat.headers.get('X-Cache') };
    }
    report.push({ category, active, facet_rows: facetRows, queries: filterMetadataQueries(category).length, rows_read: rowsRead, statements, http,
      filters: metadata.filters.map(f => ({ id: f.id, target: f.target, options: f.options?.length, range: f.range })) });
  }
  await writeFile(args.output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output: args.output, categories: report.length, rows_read: report.reduce((sum, r) => sum + r.rows_read, 0),
    samples: report.map(({ category, active, queries, rows_read, http }) => ({ category, active, queries, rows_read, http })) }, null, 2));
} finally { await db.close(); }
