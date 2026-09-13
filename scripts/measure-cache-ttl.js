import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { startTail, measure, summarize, popular } from './lib/cache-measurement.js';

const ttl = Number(process.argv[2]);
assert([60, 300, 600].includes(ttl), 'Provide the deployed TTL (60/300/600)');
const origin = 'https://pc-parts-catalog.kikuuuty.workers.dev';
const output = `.cache/cache-ttl-${ttl}.json`;
const tail = await startTail();
const report = { generated_at: new Date().toISOString(), ttl, interval_seconds: 65, samples: [] };
try {
  await tail.ready(origin);
  for (let wave = 0; wave < 2; wave++) {
    if (wave) await delay(65_000);
    for (const [category, query] of popular.slice(0, 5)) for (let round = 0; round < 3; round++) {
      const sample = await measure(origin, tail, `/v1/search?${new URLSearchParams({ category, q: query, offset: '80' })}`);
      report.samples.push({ category, query, wave, round, ...sample });
      assert.equal(sample.status, 200);
      assert.equal(sample.headers['x-cache-ttl'], String(ttl));
      const miss = round === 0 && (wave === 0 || ttl === 60);
      assert.equal(sample.headers['x-cache'], miss ? 'MISS' : 'HIT');
      assert.equal(sample.event.d1_queries, miss ? 1 : 0);
      if (!miss) assert.equal(sample.event.rows_read, 0);
      assert.equal(sample.event.rows_written, 0);
      const first = report.samples.find(s => s.query === query);
      assert.deepEqual(sample.body, first.body);
    }
  }
  report.summary = summarize(report.samples);
  console.log(JSON.stringify({ output, ttl, ...report.summary }, null, 2));
} finally {
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  await tail.stop();
}
