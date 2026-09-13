import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { startTail, measure, summarize, distribution } from './lib/cache-measurement.js';

const before = JSON.parse(await readFile('.cache/broad-worker-before.json', 'utf8'));
const costs = JSON.parse(await readFile('.cache/broad-read-remote-after.json', 'utf8'));
const origin = 'https://pc-parts-catalog.kikuuuty.workers.dev';
const samples = [];
// Keep this small GET check separate from preceding uncached measurement budgets.
await delay(65_000);
const tail = await startTail();
try {
  await tail.ready(origin);
  for (const item of costs.results.filter(r => r.group === 'broad')) {
    const path = `/v1/search?${new URLSearchParams({ category: item.category, q: item.keyword })}`;
    for (let repeat = 0; repeat < 2; repeat++) {
      const sample = await measure(origin, tail, path);
      samples.push({ id: item.id, repeat, ...sample });
      assert.equal(sample.status, 200);
      assert.equal(sample.headers['x-cache'], repeat ? 'HIT' : 'MISS', 'Need expired/cold entries; do not add a cache-buster');
      assert.equal(sample.event.d1_queries, repeat ? 0 : 1);
      assert.equal(sample.event.rows_read, repeat ? 0 : item.meta.rows_read);
      assert.equal(sample.headers['cache-control'], 'no-store');
      assert.deepEqual(sample.body, before.samples.find(s => s.id === item.id).body);
      if (repeat) assert.equal(sample.event.rate_limit_status, 'not_checked');
    }
  }
  console.log(JSON.stringify({ ...summarize(samples), cpu_ms: distribution(samples.map(s => s.event.cpu_ms)),
    hit_cpu_ms: distribution(samples.filter(s => s.repeat).map(s => s.event.cpu_ms)) }, null, 2));
} finally {
  try { await writeFile('.cache/broad-cache-production.json', JSON.stringify({ generated_at: new Date().toISOString(), samples }, null, 2) + '\n'); }
  finally { await tail.stop(); }
}
