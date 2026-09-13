import { createHash } from 'node:crypto';
import { models } from '../../src/model.js';
import { searchQuery } from '../../src/queries.js';
import { loadSearchFixture } from '../../src/quality/fixtures.js';
import { catalogState, assertCatalogState } from '../../src/quality/catalog.js';

const protectedTables = ['products', ...Object.values(models).map(m => m.table), 'upstream_identifiers',
  'local_identifiers', 'local_enrichments', 'upstream_raw', 'product_facets', 'sources', 'categories', 'sync_runs', 'sync_lock'];
const digest = rows => {
  const hash = createHash('sha256');
  for (const row of rows) hash.update(JSON.stringify(row)).update('\n');
  return hash.digest('hex');
};

// Diagnostic only: read-only, bounded pages, no snapshot is written to the DB.
// Source fingerprints deliberately include timestamps and raw JSON for exact
// before/after invariance within the same database.
export async function captureProjection(db, { search = false } = {}) {
  const sync = await catalogState(db);
  const tables = {};
  for (const table of protectedTables) {
    const columns = (await db.query(`PRAGMA table_info(${table})`)).results.map(r => r.name);
    const hash = createHash('sha256');
    hash.update(JSON.stringify(columns)).update('\n');
    let cursor = 0, count = 0;
    while (true) {
      const rows = (await db.query(`SELECT rowid AS _cursor,* FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT 500`, [cursor])).results;
      if (!rows.length) break;
      for (const row of rows) hash.update(JSON.stringify(columns.map(c => row[c]))).update('\n');
      count += rows.length; cursor = rows.at(-1)._cursor;
    }
    tables[table] = { count, sha256: hash.digest('hex'), columns };
  }
  const fields = (await db.query('PRAGMA table_info(product_fts)')).results.map(r => r.name);
  if (JSON.stringify(fields) !== JSON.stringify(['text', 'name', 'manufacturer', 'series', 'variant', 'family'])) throw new Error('FTS schema changed; review fingerprint format');
  const rows = [];
  let cursor = 0;
  while (true) {
    const page = (await db.query(`SELECT f.rowid AS id,p.category,p.upstream_key,${fields.map(c => `f.${c}`).join(',')}
      FROM product_fts f LEFT JOIN products p ON p.id=f.rowid WHERE f.rowid>? ORDER BY f.rowid LIMIT 500`, [cursor])).results;
    if (!page.length) break;
    for (const row of page) rows.push([row.id, row.category, row.upstream_key, ...fields.map(c => row[c])]);
    cursor = page.at(-1).id;
  }
  const categories = {};
  for (const category of Object.keys(models)) {
    const subset = rows.filter(r => r[1] === category);
    categories[category] = { count: subset.length, sha256: digest(subset) };
  }
  const counts = await db.query('SELECT category,active,count(*) AS count FROM products GROUP BY category,active ORDER BY category,active');
  const foreignKeyErrors = (await db.query('PRAGMA foreign_key_check')).results;
  const ranking = [];
  let fixtureHash = null;
  if (search) {
    const input = await loadSearchFixture(); fixtureHash = input.hash;
    for (const item of input.fixture) {
      const query = searchQuery(item.category, { ...item.search, keyword: item.query, limit: 20, debug: true });
      const start = performance.now();
      const result = await db.query(query.sql, query.params);
      ranking.push({ id: item.id, category: item.category, query: item.query, elapsed_ms: performance.now() - start, meta: result.meta,
        top20: result.results.map(p => ({ upstream_key: p.upstream_key, name: p.name, search_score: p.search_score,
          search_fts_relevance: p.search_fts_relevance, search_match: p.search_match })) });
    }
  }
  await assertCatalogState(db, sync);
  return { schema_version: 1, generated_at: new Date().toISOString(), sync, tables, counts: counts.results,
    size_bytes: counts.meta?.size_after ?? null, foreign_key_errors: foreignKeyErrors,
    fts: { columns: ['rowid', 'category', 'upstream_key', ...fields], count: rows.length, sha256: digest(rows), categories, rows },
    fixture_sha256: fixtureHash, ranking };
}

export function compareProjection(a, b) {
  if (JSON.stringify(a.fts.columns) !== JSON.stringify(b.fts.columns)) throw new Error('Incompatible FTS fingerprint columns');
  const left = new Map(a.fts.rows.map(r => [r[2] ?? `orphan:${r[0]}`, r]));
  const right = new Map(b.fts.rows.map(r => [r[2] ?? `orphan:${r[0]}`, r]));
  if (left.size !== a.fts.count || right.size !== b.fts.count) throw new Error('Duplicate FTS identity');
  const differences = [];
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    const x = left.get(key), y = right.get(key);
    if (JSON.stringify(x) !== JSON.stringify(y)) differences.push({ upstream_key: key,
      fields: a.fts.columns.filter((_, i) => x?.[i] !== y?.[i]), before: x ?? null, after: y ?? null });
  }
  const dataChanges = Object.keys(a.tables).filter(t => JSON.stringify(a.tables[t]) !== JSON.stringify(b.tables[t]));
  const rankingChanges = [], scoreChanges = [];
  let maxScoreDelta = 0, maxRelevanceDelta = 0, numericRowsDiffering = 0;
  if (a.ranking.length || b.ranking.length) {
    if (a.fixture_sha256 !== b.fixture_sha256 || a.ranking.length !== b.ranking.length) throw new Error('Different ranking fixtures/scopes');
    for (const x of a.ranking) {
      const y = b.ranking.find(r => r.id === x.id);
      if (!y) throw new Error('Missing ranking case');
      const keys = r => r.top20.map(p => p.upstream_key);
      if (JSON.stringify(keys(x)) !== JSON.stringify(keys(y))) rankingChanges.push(x.id);
      const scores = r => r.top20.map(p => [p.upstream_key, p.search_score, p.search_fts_relevance, p.search_match]);
      if (JSON.stringify(scores(x)) !== JSON.stringify(scores(y))) scoreChanges.push(x.id);
      for (const p of x.top20) {
        const q = y.top20.find(r => r.upstream_key === p.upstream_key);
        if (!q) continue;
        const scoreDelta = Math.abs(p.search_score - q.search_score);
        const relevanceDelta = Math.abs(p.search_fts_relevance - q.search_fts_relevance);
        maxScoreDelta = Math.max(maxScoreDelta, scoreDelta);
        maxRelevanceDelta = Math.max(maxRelevanceDelta, relevanceDelta);
        if (scoreDelta || relevanceDelta) numericRowsDiffering++;
      }
    }
  }
  return { fts_difference_count: differences.length, fts_differences: differences, data_changed_tables: dataChanges,
    compared_queries: a.ranking.length, ranking_changes: rankingChanges, score_changes: scoreChanges,
    max_score_delta: maxScoreDelta, max_relevance_delta: maxRelevanceDelta, numeric_rows_differing: numericRowsDiffering,
    before: { count: a.fts.count, sha256: a.fts.sha256 }, after: { count: b.fts.count, sha256: b.fts.sha256 } };
}
