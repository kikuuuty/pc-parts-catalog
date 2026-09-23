import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { summarize, distribution } from './cache-measurement.js';

function assertRateContract(s) {
  assert([200, 429].includes(s.status), 'Expected allowed (200) or rate-limited (429) Search response');
  assert.equal(s.headers['cache-control'], 'no-store');
  assert.equal(s.headers['x-cache'], 'BYPASS');
  assert(s.headers['x-request-id'], 'Missing X-Request-ID');
  assert.equal(s.event.request_id, s.headers['x-request-id']);
  assert.equal(s.event.status, s.status);
  if (s.status === 429) {
    assert(['expensive_miss', 'd1_miss'].includes(s.event.rate_limit_class), 'Unexpected Search denial class');
    assert.equal(s.headers['retry-after'], '60');
    assert.equal(s.headers['access-control-allow-origin'], '*');
    assert((s.headers['access-control-expose-headers'] ?? '').split(',').some(h => h.trim().toLowerCase() === 'retry-after'), 'Retry-After must be exposed to CORS clients');
    assert.deepEqual(s.body, { error: { code: 'RATE_LIMITED', message: 'Too many search requests' }, request_id: s.headers['x-request-id'] });
    assert.equal(s.event.rate_limit_status, 'denied');
    assert.equal(s.event.d1_queries, 0);
    assert.equal(s.event.rows_read, 0);
    assert.equal(s.event.rows_written, 0);
  } else {
    assert.equal(s.event.rate_limit_class, 'expensive_miss');
    assert.equal(s.event.rate_limit_status, 'allowed');
    assert(Number.isFinite(s.event.d1_queries) && s.event.d1_queries > 0, 'Allowed Search must execute D1');
    assert(Number.isFinite(s.event.rows_read) && s.event.rows_read >= 0, 'Allowed rows_read must be finite and non-negative');
  }
}

// Inject measurement and sleep so stopping/coverage can be verified offline.
// No configurable load increase, retries, or window waits in this probe.
export async function runRateSmoke({ request, sleep = delay, samples = [] }) {
  let stopReason = 'request_limit';
  for (let i = 0; i < 24; i++) {
    const s = await request();
    samples.push(s);
    assertRateContract(s);
    // Check the entire contract before treating a global denial as valid.
    // Continuing would spend expensive tokens without refund after D1 rejection.
    if (s.status === 429 && s.event.rate_limit_class === 'd1_miss') {
      stopReason = 'global_d1_limit';
      break;
    }
    if (i < 23) await sleep(300);
  }
  const allowed = samples.filter(s => s.status === 200), limited = samples.filter(s => s.status === 429);
  const limitedByClass = Object.fromEntries(['expensive_miss', 'd1_miss'].map(tier => [tier, limited.filter(s => s.event.rate_limit_class === tier).length]));
  const passed = limitedByClass.expensive_miss > 0;
  const observed = count => count > 0 ? 'observed' : 'not_observed';
  const sampleInfo = s => ({ request_id: s.headers['x-request-id'], rate_limit_class: s.event.rate_limit_class,
    d1_queries: s.event.d1_queries, rows_read: s.event.rows_read, rows_written: s.event.rows_written,
    http_ms: s.elapsed_ms, cpu_ms: s.event.cpu_ms });
  // Diagnostic measurements only; no fixed cost/latency/CPU thresholds.
  return { contract: passed ? 'pass' : 'inconclusive', exit_code: passed ? 0 : 1, stop_reason: stopReason,
    coverage: { allowed: observed(allowed.length), expensive_miss_denied: observed(limitedByClass.expensive_miss), d1_miss_denied: observed(limitedByClass.d1_miss) },
    ...(!passed ? { message: stopReason === 'global_d1_limit'
      ? 'Inconclusive: global D1 protection verified, but no expensive_miss 429 observed. Stopped without additional requests or automatic retries.'
      : 'Inconclusive: no denial observed within 24 requests; do not increase production load to force it. Consider eventual consistency and shared traffic/window state; check deployment/configuration.' } : {}),
    ...summarize(samples), ok: allowed.length, limited: limited.length, limited_by_class: limitedByClass,
    cpu_ms: distribution(samples.map(s => s.event.cpu_ms)),
    allowed_rows_read: { min: allowed.length ? Math.min(...allowed.map(s => s.event.rows_read)) : null,
      ...distribution(allowed.map(s => s.event.rows_read)) },
    rate_limit_classes: Object.fromEntries([...new Set(samples.map(s => s.event.rate_limit_class))].map(tier => [tier, samples.filter(s => s.event.rate_limit_class === tier).length])),
    allowed_samples: allowed.map(sampleInfo), limited_samples: limited.map(sampleInfo) };
}
