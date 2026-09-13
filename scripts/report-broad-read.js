import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { distribution } from './lib/cache-measurement.js';

const load = async name => JSON.parse(await readFile(`.cache/${name}.json`, 'utf8'));
const before = await load('broad-read-before'), after = await load('broad-read-after');
for (const old of before.results) {
  const next = after.results.find(r => r.id === old.id);
  for (const field of ['result_sha256', 'debug_sha256', 'candidates_sha256']) assert.equal(next[field], old[field], `${old.id}: ${field}`);
}
const rb = await load('broad-read-remote-before'), ra = await load('broad-read-remote-after');
const wb = await load('broad-worker-before'), wa = await load('broad-worker-final-complete');
const quality = await load('broad-quality-after'), oldQuality = await load('search-fts-local-upgraded');
assert.deepEqual(quality.summary, oldQuality.summary);
const historicalMixed = (await load('cache-after')).mixed;
const eligible = after.results.filter(r => !r.filters && !r.ranges && !r.facets && !r.identifier && !r.orderBy && !r.offset);
const costs = new Map(eligible.map(r => [`${r.category}:${r.keyword}`, r.meta.rows_read]));
const mixed = historicalMixed.map(s => {
  const reads = costs.get(`${s.category}:${s.query}`);
  assert(Number.isFinite(reads), `Missing mixed SQL cost ${s.category}:${s.query}`);
  return { reads, cached_reads: s.headers['x-cache'] === 'HIT' ? 0 : reads };
});
const uncached = mixed.reduce((n, s) => n + s.reads, 0), cached = mixed.reduce((n, s) => n + s.cached_reads, 0);
const mean = uncached / mixed.length;
const report = { generated_at: new Date().toISOString(),
  local: { before: before.summary, after: after.summary },
  broad_reduction: 1 - after.summary.broad.rows_read / before.summary.broad.rows_read,
  golden_reduction: 1 - after.summary.golden.rows_read / before.summary.golden.rows_read,
  db_size: { local_before: before.results[0].meta.size_after, local_after: after.results[0].meta.size_after,
    remote_before: rb.results[0].meta.size_after, remote_after: ra.results[0].meta.size_after },
  remote: rb.results.filter(r => r.group === 'broad').map(r => {
    const next = ra.results.find(s => s.id === r.id);
    return { id: r.id, before_reads: r.meta.rows_read, after_reads: next.meta.rows_read, reduction: 1 - next.meta.rows_read / r.meta.rows_read,
      before_sql_ms: r.meta.duration, after_sql_ms: next.meta.duration, before_elapsed_ms: r.elapsed_ms, after_elapsed_ms: next.elapsed_ms };
  }),
  worker: { before: wb.summary, after: wa.summary, cpu_rounds: [wb, wa].map(data => ({ phase: data.phase,
    rounds: [0, 1].map(round => distribution(data.samples.filter(s => s.round === round).map(s => s.event.cpu_ms))) })),
    samples: wa.samples.map(s => ({ id: s.id, round: s.round, cpu_before: wb.samples.find(b => b.id === s.id && b.round === s.round).event.cpu_ms, cpu_after: s.event.cpu_ms })) },
  quality: quality.summary,
  free: { kind: 'new SQL measurements replayed with historical 64 HIT / 36 MISS; not a new HTTP workload', uncached_rows: uncached,
    cached_rows: cached, mean_uncached: mean, scenarios: [0, 0.5, 0.8, 0.9].map(hit_rate => ({ hit_rate, mean_reads: mean * (1 - hit_rate), searches: Math.floor(5_000_000 / (mean * (1 - hit_rate))) })),
    historical_distribution: { hit_rate: 0.64, mean_reads: cached / mixed.length, searches: Math.floor(5_000_000 / (cached / mixed.length)) } },
};
await writeFile('.cache/broad-read-summary.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ broad_reduction: report.broad_reduction, golden_reduction: report.golden_reduction,
  db_size: report.db_size, remote: report.remote, worker: report.worker, quality: report.quality, free: report.free }, null, 2));
