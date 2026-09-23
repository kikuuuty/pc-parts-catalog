import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { startTail, measure, summarize, distribution } from './lib/cache-measurement.js';

// Production Rate Limiting contract smoke: allowed/denied HTTP + telemetry
// contracts and D1 pre-admission protection, not fixed SQL costs or result counts.
// At most 24 cheap Search POSTs, paced 300ms apart; never extend to force a denial.
// Exact thresholds belong in deterministic fake-limiter tests: production is
// colo-local/eventually consistent and shares window state with other traffic.
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
    assert([200, 429].includes(s.status), 'Expected allowed (200) or rate-limited (429) Search response');
    assert.equal(s.headers['cache-control'], 'no-store');
    assert.equal(s.headers['x-cache'], 'BYPASS');
    assert(s.headers['x-request-id'], 'Missing X-Request-ID');
    assert.equal(s.event.rate_limit_class, 'expensive_miss');
    if (s.status === 429) {
      assert.equal(s.headers['retry-after'], '60');
      assert.equal(s.headers['access-control-allow-origin'], '*');
      assert((s.headers['access-control-expose-headers'] ?? '').split(',').some(h => h.trim().toLowerCase() === 'retry-after'), 'Retry-After must be exposed to CORS clients');
      assert.deepEqual(s.body, { error: { code: 'RATE_LIMITED', message: 'Too many search requests' }, request_id: s.headers['x-request-id'] });
      assert.equal(s.event.rate_limit_status, 'denied');
      assert.equal(s.event.d1_queries, 0);
      assert.equal(s.event.rows_read, 0);
      assert.equal(s.event.rows_written, 0);
    } else {
      assert.equal(s.event.rate_limit_status, 'allowed');
      assert(Number.isFinite(s.event.d1_queries) && s.event.d1_queries > 0, 'Allowed Search must execute D1');
      assert(Number.isFinite(s.event.rows_read) && s.event.rows_read >= 0, 'Allowed rows_read must be finite and non-negative');
    }
    await delay(300);
  }
  const allowed = samples.filter(s => s.status === 200), limited = samples.filter(s => s.status === 429);
  const sampleInfo = s => ({ request_id: s.headers['x-request-id'], rate_limit_class: s.event.rate_limit_class,
    d1_queries: s.event.d1_queries, rows_read: s.event.rows_read, rows_written: s.event.rows_written,
    http_ms: s.elapsed_ms, cpu_ms: s.event.cpu_ms });
  // Diagnostic measurements only; no fixed cost/latency/CPU thresholds.
  console.log(JSON.stringify({ ...summarize(samples), ok: allowed.length, limited: limited.length,
    cpu_ms: distribution(samples.map(s => s.event.cpu_ms)),
    allowed_rows_read: { min: allowed.length ? Math.min(...allowed.map(s => s.event.rows_read)) : null,
      ...distribution(allowed.map(s => s.event.rows_read)) },
    rate_limit_classes: Object.fromEntries([...new Set(samples.map(s => s.event.rate_limit_class))].map(tier => [tier, samples.filter(s => s.event.rate_limit_class === tier).length])),
    allowed_samples: allowed.map(sampleInfo), limited_samples: limited.map(sampleInfo) }, null, 2));
  assert(limited.length > 0, 'No denial observed within 24 requests; do not increase production load to force it. Consider eventual consistency and shared traffic/window state; check deployment/configuration.');
} finally {
  try { await writeFile('.cache/rate-production-429.json', JSON.stringify({ generated_at: new Date().toISOString(), samples }, null, 2) + '\n'); }
  finally { await tail.stop(); }
}
