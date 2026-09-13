import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/database.js';
import { searchQuery } from '../src/queries.js';
import { loadSearchFixture } from '../src/quality/fixtures.js';
import { catalogState, assertCatalogState } from '../src/quality/catalog.js';
import { broadQueries, exactQueries, offsetQueries, searchCTEs } from './lib/broad-workload.js';
import { distribution } from './lib/cache-measurement.js';
import { searchBefore } from '../test-support/search-read-before.js';

const { values: args } = parseArgs({ options: {
  remote: { type: 'boolean', default: false }, output: { type: 'string', default: '.cache/broad-read-before.json' },
  compare: { type: 'string' }, 'sample-only': { type: 'boolean', default: false },
} });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const { fixture, hash: fixtureHash } = await loadSearchFixture();
const golden = fixture.map(item => ({ id: item.id, group: 'golden', category: item.category, keyword: item.query, ...item.search }));
const cases = args['sample-only'] ? [...broadQueries.filter(q => ['ddr5', 'ddr5 6000', 'ryzen 7', 'rtx 5080', 'b650e', '850w gold', '360mm aio'].includes(q.keyword)), ...exactQueries, ...offsetQueries]
  : [...golden, ...broadQueries, ...exactQueries, ...offsetQueries];
const before = args.compare ? JSON.parse(await readFile(args.compare, 'utf8')) : null;
if (before) assert.equal(before.fixture_sha256, fixtureHash);
const report = { generated_at: new Date().toISOString(), remote: args.remote, fixture_sha256: fixtureHash,
  engine_source: await readFile('src/queries.js', 'utf8'), results: [] };
report.engine_sha256 = hash(report.engine_source);
const db = await openDatabase(args.remote);
try {
  report.sync = await catalogState(db);
  assert.equal(report.sync.status, 'complete');
  for (const item of cases) {
    const { offset = 0 } = item;
    const query = searchQuery(item.category, { ...item, limit: 21 });
    const sql = `${query.sql} OFFSET ?`, params = [...query.params, offset];
    const plan = (await db.query(`EXPLAIN QUERY PLAN ${sql}`, params)).results;
    const started = performance.now();
    const result = await db.query(sql, params);
    const elapsed_ms = performance.now() - started;
    assert.equal(result.meta.rows_written, 0);
    const debug = searchQuery(item.category, { ...item, limit: 21, debug: true });
    const debugRows = (await db.query(`${debug.sql} OFFSET ?`, [...debug.params, offset])).results;
    const ctes = searchCTEs(query.sql), cteParams = query.params.slice(0, -1);
    // Complete candidate/score sets, not just top20. Diagnostic reads are separate from main SQL metadata.
    const all = (await db.query(`${ctes}SELECT id,relevance,fallback,tier,spec_score,manufacturer_score,freshness_score,score,match_type FROM scored ORDER BY id`, cteParams)).results;
    const counts = (await db.query(`${ctes}SELECT (SELECT count(*) FROM strict_fts) AS strict_hits,
      (SELECT count(*) FROM strict) AS strict_candidates,(SELECT count(*) FROM candidates) AS candidates`, cteParams)).results[0];
    const bytecode = item.group === 'offset' || item.keyword === 'ddr5' ? (await db.query(`EXPLAIN ${sql}`, params)).results : undefined;
    const row = { ...item, sql, params, plan, bytecode, meta: result.meta, elapsed_ms, returned: result.results.length,
      top20: result.results.slice(0, 20).map(r => r.upstream_key), rows: result.results, debug_rows: debugRows,
      counts, candidates: all, candidates_sha256: hash(all), result_sha256: hash(result.results), debug_sha256: hash(debugRows) };
    if (before) {
      const old = before.results.find(r => r.id === item.id);
      assert(old, `Missing baseline ${item.id}`);
      const oracle = searchBefore(item.category, { ...item, limit: 21 });
      assert.equal(`${oracle.sql} OFFSET ?`.replace(/\s+/g, ' ').trim(), old.sql.replace(/\s+/g, ' ').trim(), `Frozen SQL oracle differs: ${item.id}`);
      assert.deepEqual([...oracle.params, offset], old.params);
      assert.deepEqual(row.rows, old.rows, `Result changed: ${item.id}`);
      assert.deepEqual(row.debug_rows, old.debug_rows, `Debug changed in same runtime: ${item.id}`);
      assert.deepEqual(row.candidates, old.candidates, `Candidate/score set changed: ${item.id}`);
      if (item.group === 'exact') assert(row.meta.rows_read <= old.meta.rows_read, `Exact cost increased: ${item.id}`);
      row.before_rows_read = old.meta.rows_read;
    }
    report.results.push(row);
  }
  await assertCatalogState(db, report.sync);
  report.summary = Object.fromEntries(['golden', 'broad', 'exact', 'offset'].map(group => {
    const selected = report.results.filter(r => r.group === group);
    return [group, { count: selected.length, rows_read: selected.reduce((n, r) => n + r.meta.rows_read, 0),
      reads: distribution(selected.map(r => r.meta.rows_read)), sql_ms: distribution(selected.map(r => r.meta.duration)),
      elapsed_ms: distribution(selected.map(r => r.elapsed_ms)),
      full_scans: selected.filter(r => r.plan.some(p => /^SCAN (?:p|s)(?:$| USING)/.test(p.detail))).map(r => r.id) }];
  }));
  console.log(JSON.stringify({ output: args.output, summary: report.summary,
    broad: report.results.filter(r => r.group !== 'golden').map(r => ({ id: r.id, reads: r.meta.rows_read, before: r.before_rows_read, candidates: r.counts.candidates, strict_hits: r.counts.strict_hits })) }, null, 2));
} finally {
  try { await writeFile(args.output, JSON.stringify(report, null, 2) + '\n'); } finally { await db.close(); }
}
