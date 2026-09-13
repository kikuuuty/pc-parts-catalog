import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { startTail, measure, summarize, distribution } from './lib/cache-measurement.js';

// Safe production 429 probe: at most 24 cheap POSTs (~1,176 reads if all pass).
// Do not run concurrently with broad-query measurements or Golden verification.
const origin = 'https://pc-parts-catalog.kikuuuty.workers.dev';
const tail = await startTail();
const samples = [];
try {
  await tail.ready(origin);
  for (let i = 0; i < 24; i++) {
    const s = await measure(origin, tail, '/v1/search', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: 'cpu', keyword: '14900k' }) });
    samples.push(s);
    assert([200, 429].includes(s.status));
    assert.equal(s.headers['cache-control'], 'no-store');
    assert.equal(s.headers['x-cache'], 'BYPASS');
    if (s.status === 429) {
      assert.equal(s.body.error.code, 'RATE_LIMITED');
      assert.equal(s.headers['retry-after'], '60');
      assert.equal(s.event.d1_queries, 0);
      assert.equal(s.event.rows_read, 0);
      assert.equal(s.event.rate_limit_class, 'expensive_miss');
    } else {
      assert.equal(s.event.rows_read, 49);
      assert.equal(s.event.d1_queries, 1);
    }
    await delay(300);
  }
  assert(samples.some(s => s.status === 429), 'No denial observed; do not increase production load to force it');
  console.log(JSON.stringify({ ...summarize(samples), ok: samples.filter(s => s.status === 200).length,
    limited: samples.filter(s => s.status === 429).length, cpu_ms: distribution(samples.map(s => s.event.cpu_ms)) }, null, 2));
} finally {
  try { await writeFile('.cache/rate-production-429.json', JSON.stringify({ generated_at: new Date().toISOString(), samples }, null, 2) + '\n'); }
  finally { await tail.stop(); }
}
