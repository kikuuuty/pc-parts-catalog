import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const [beforeFile, afterFile, output = '.cache/search-production-comparison.json'] = process.argv.slice(2);
if (!beforeFile || !afterFile) throw new Error('Usage: node scripts/compare-search-runs.js <local-baseline.json> <remote-benchmark.json> [output.json]');
const [before, after] = await Promise.all([beforeFile, afterFile].map(file => readFile(file, 'utf8').then(JSON.parse)));
assert.equal(before.fixture_sha256, after.fixture_sha256, 'Different Golden Query fixtures');
assert.equal(before.search_implementation_sha256, after.search_implementation_sha256, 'Different search implementations');
assert.deepEqual(before.results.map(r => r.id).sort(), after.results.map(r => r.id).sort(), 'Different benchmark scopes');
const distribution = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const p = n => sorted.length ? sorted[Math.ceil(sorted.length * n) - 1] : null;
  return { p50: p(0.5), p95: p(0.95), max: p(1) };
};
const summarize = run => ({
  ...run.summary, catalog_sha256: run.catalog.catalog_sha256, active_products: run.catalog.active_product_count,
  sync: run.catalog.last_sync, size_bytes: run.results.find(r => r.size_bytes)?.size_bytes ?? null,
  rows_read: run.results.reduce((n, r) => n + r.rows_read, 0),
  elapsed_total_ms: run.results.reduce((n, r) => n + r.elapsed_ms, 0),
  sql_duration_total_ms: run.results.reduce((n, r) => n + r.sql_duration_ms, 0),
  elapsed_ms: distribution(run.results.map(r => r.elapsed_ms)),
  sql_duration_ms: distribution(run.results.map(r => r.sql_duration_ms)),
});
const comparable = before.catalog.last_sync?.status === 'complete' && after.catalog.last_sync?.status === 'complete'
  && before.catalog.last_sync.source_commit === after.catalog.last_sync.source_commit
  && before.catalog.active_product_count === after.catalog.active_product_count;
const changes = [];
for (const row of after.results) {
  const old = before.results.find(r => r.id === row.id);
  // Internal product IDs and timestamps can differ across independently provisioned DBs.
  const keys = result => result.top_results.map(p => p.upstream_key);
  if (old.rank !== row.rank || JSON.stringify(keys(old)) !== JSON.stringify(keys(row))) changes.push({
    id: row.id, query: row.query, before_rank: old.rank, after_rank: row.rank, status: row.status,
    before_top_10: keys(old), after_top_10: keys(row),
  });
}
const report = {
  generated_at: new Date().toISOString(), before_file: beforeFile, after_file: afterFile,
  comparable_snapshot: comparable,
  note: comparable ? 'Also inspect local identifiers/enrichments and ID tie-breakers if rankings differ.'
    : 'Partial/different snapshot: scores and rank differences are diagnostic, not a search regression comparison.',
  before: summarize(before), after: summarize(after),
  active_product_difference: after.catalog.active_product_count - before.catalog.active_product_count,
  ranking_changes: changes,
};
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, ranking_changes: changes.map(r => ({ id: r.id, query: r.query, before_rank: r.before_rank, after_rank: r.after_rank, status: r.status })) }, null, 2));
if (comparable && changes.length) process.exitCode = 1;
