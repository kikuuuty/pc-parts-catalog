import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { distribution } from './lib/cache-measurement.js';

const read = async name => JSON.parse(await readFile(`.cache/${name}.json`, 'utf8'));
const before = await read('cache-before-complete');
const after = await read('cache-after');
const golden = await read('api-cache-golden');
const all = [...after.repeated, ...after.mixed];
const mean = before.summary.mixed.rows_read_per_request;
const counts = (items, field) => items.reduce((out, item) => { out[item[field]] = (out[item[field]] ?? 0) + 1; return out; }, {});
assert.equal(before.mixed.length, after.mixed.length);
for (let i = 0; i < before.mixed.length; i++) {
  assert.equal(before.mixed[i].path, after.mixed[i].path);
  assert.deepEqual(before.mixed[i].body, after.mixed[i].body);
}
const report = {
  generated_at: new Date().toISOString(),
  before: before.summary, after: after.summary,
  reduction: 1 - after.summary.mixed.rows_read / before.summary.mixed.rows_read,
  baseline_headers: { cf_cache_status: [...new Set(before.mixed.map(s => s.headers['cf-cache-status'] ?? null))],
    age: [...new Set(before.mixed.map(s => s.headers.age ?? null))] },
  colos: [...new Set([...before.mixed, ...all].map(s => s.headers['cf-ray'].split('-').at(-1)))],
  first_and_hits: Object.fromEntries(Object.keys(after.summary.per_query).map(query => {
    const samples = after.repeated.filter(s => s.query === query);
    return [query, samples.map(s => ({ status: s.headers['x-cache'], request_id: s.headers['x-request-id'],
      http_ms: s.elapsed_ms, rows_read: s.event.rows_read, d1_queries: s.event.d1_queries,
      age: s.headers.age ?? null, ttl: s.headers['x-cache-ttl'], worker_ms: s.event.elapsed_ms, cpu_ms: s.event.cpu_ms }))];
  })),
  cpu: { before: distribution(before.mixed.map(s => s.event.cpu_ms)), overall: distribution(after.mixed.map(s => s.event.cpu_ms)),
    hit: distribution(after.mixed.filter(s => s.headers['x-cache'] === 'HIT').map(s => s.event.cpu_ms)),
    miss: distribution(after.mixed.filter(s => s.headers['x-cache'] === 'MISS').map(s => s.event.cpu_ms)),
    over_free_10ms: after.mixed.filter(s => s.event.cpu_ms > 10).length },
  slowest: after.mixed.reduce((a, b) => a.elapsed_ms > b.elapsed_ms ? a : b),
  golden: { count: golden.golden.length, first: counts(golden.golden, 'cache_status'), repeat: counts(golden.golden, 'repeat_cache_status'), metrics: golden.summary.golden_metrics },
  free: [0, 0.5, 0.8, 0.9].map(hit_rate => ({ hit_rate, rows_read_per_request: mean * (1 - hit_rate),
    http_searches_per_day: Math.floor(5_000_000 / (mean * (1 - hit_rate))) })),
  observed_free_searches_per_day: Math.floor(5_000_000 / after.summary.mixed.rows_read_per_request),
  ttl: await Promise.all([60, 300, 600].map(async ttl => {
    const run = await read(`cache-ttl-${ttl}`);
    return { ttl, ...run.summary, second_wave_hit_age_seconds: distribution(run.samples
      .filter(s => s.wave === 1 && s.headers['x-cache'] === 'HIT').map(s => Number(s.headers.age))) };
  })),
};
// Keep the outlier's body out of the compact summary; the full sample is in cache-after.json.
report.slowest = { query: report.slowest.query, http_ms: report.slowest.elapsed_ms, event: report.slowest.event };
await writeFile('.cache/cache-summary.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output: '.cache/cache-summary.json', reduction: report.reduction,
  golden: report.golden, cpu: report.cpu, free: report.free,
  observed_free_searches_per_day: report.observed_free_searches_per_day,
  ttl: report.ttl.map(({ ttl, hits, misses, rows_read, second_wave_hit_age_seconds }) => ({ ttl, hits, misses, rows_read, second_wave_hit_age_seconds })),
}, null, 2));
