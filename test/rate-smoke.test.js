import test from 'node:test';
import assert from 'node:assert/strict';
import { runRateSmoke } from '../scripts/lib/rate-smoke.js';
import { protectionWorker } from '../test-support/protection-worker.js';

function workerProbe(options) {
  const h = protectionWorker(options), samples = [], sleeps = [];
  let requests = 0;
  return { h, samples, sleeps, get requests() { return requests; }, run: () => runRateSmoke({ samples,
    sleep: async ms => { sleeps.push(ms); }, request: async () => {
      requests++;
      const response = await h.request({ category: 'cpu', keyword: '14900k' }, 'POST');
      return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.json(),
        event: { ...h.logs.at(-1), cpu_ms: 1 }, elapsed_ms: 2 };
    },
  }) };
}

function sample(status = 200, tier = 'expensive_miss') {
  const request_id = 'smoke-test-id';
  return { status, headers: { 'cache-control': 'no-store', 'x-cache': 'BYPASS', 'x-request-id': request_id,
    'retry-after': '60', 'access-control-allow-origin': '*', 'access-control-expose-headers': 'X-Request-ID, Retry-After' },
    body: status === 429 ? { error: { code: 'RATE_LIMITED', message: 'Too many search requests' }, request_id } : {},
    event: { status, request_id, rate_limit_class: tier, rate_limit_status: status === 429 ? 'denied' : 'allowed',
      d1_queries: status === 429 ? 0 : 3, rows_read: status === 429 ? 0 : 987, rows_written: 0, elapsed_ms: 1, cpu_ms: 1 }, elapsed_ms: 2 };
}

test('rate smoke requires expensive denial, preserves the 24-request cap and 300ms pacing', async () => {
  const p = workerProbe();
  const report = await p.run();
  assert.equal(report.contract, 'pass');
  assert.equal(report.exit_code, 0);
  assert.equal(report.stop_reason, 'request_limit');
  assert.equal(p.requests, 24);
  assert.deepEqual(p.sleeps, Array(23).fill(300));
  assert.deepEqual(report.limited_by_class, { expensive_miss: 4, d1_miss: 0 });
  assert.deepEqual(report.coverage, { allowed: 'observed', expensive_miss_denied: 'observed', d1_miss_denied: 'not_observed' });
  assert.equal(report.allowed_samples.length, 20);
  assert.equal(report.limited_samples.length, 4);
  assert(report.limited_samples.every(s => s.d1_queries === 0 && s.rows_read === 0 && s.rows_written === 0));
});

test('global-only denial is inconclusive and stops before any extra request or sleep', async () => {
  for (const allowed of [0, 2]) {
    const p = workerProbe({ limits: { D1_MISS_LIMITER: allowed } });
    const report = await p.run();
    assert.equal(report.contract, 'inconclusive');
    assert.equal(report.exit_code, 1);
    assert.equal(report.stop_reason, 'global_d1_limit');
    assert.match(report.message, /global D1 protection verified, but no expensive_miss 429/);
    assert.equal(p.requests, allowed + 1);
    assert.deepEqual(p.sleeps, Array(allowed).fill(300));
    assert.equal(p.h.statements.length, allowed);
    assert.equal(p.h.env.EXPENSIVE_MISS_LIMITER.calls.length, allowed + 1);
    assert.equal(p.h.env.D1_MISS_LIMITER.calls.length, allowed + 1);
    assert.deepEqual(report.limited_by_class, { expensive_miss: 0, d1_miss: 1 });
    assert.deepEqual(report.coverage, { allowed: allowed ? 'observed' : 'not_observed', expensive_miss_denied: 'not_observed', d1_miss_denied: 'observed' });
    assert.equal(report.limited_samples[0].d1_queries, 0);
    assert.equal(report.limited_samples[0].rows_read, 0);
    assert.equal(report.limited_samples[0].rows_written, 0);
    if (!allowed) assert.equal(report.allowed_rows_read.min, null);
  }
});

test('expensive denial followed by global denial passes with both paths observed and stops', async () => {
  // Different production window/colo state can produce both denial classes.
  const sequence = [sample(), sample(429), sample(429, 'd1_miss')], sleeps = [];
  let requests = 0;
  const report = await runRateSmoke({ request: async () => {
    assert(requests < sequence.length, 'Must not send after global denial');
    return sequence[requests++];
  }, sleep: async ms => { sleeps.push(ms); } });
  assert.equal(report.contract, 'pass');
  assert.equal(report.exit_code, 0);
  assert.equal(report.stop_reason, 'global_d1_limit');
  assert.equal(requests, 3);
  assert.deepEqual(sleeps, [300, 300]);
  assert.deepEqual(report.coverage, { allowed: 'observed', expensive_miss_denied: 'observed', d1_miss_denied: 'observed' });
  assert.deepEqual(report.limited_by_class, { expensive_miss: 1, d1_miss: 1 });
});

test('allowed samples alone never satisfy expensive denial coverage or trigger extra attempts', async () => {
  const p = workerProbe({ unlimited: true });
  const report = await p.run();
  assert.equal(report.contract, 'inconclusive');
  assert.equal(report.exit_code, 1);
  assert.equal(report.stop_reason, 'request_limit');
  assert.equal(p.requests, 24);
  assert.deepEqual(p.sleeps, Array(23).fill(300));
  assert.equal(report.limited, 0);
  assert.deepEqual(report.coverage, { allowed: 'observed', expensive_miss_denied: 'not_observed', d1_miss_denied: 'not_observed' });
  assert.match(report.message, /do not increase production load/);
});

test('invalid denial contracts fail before global early-stop classification and retain the sample', async () => {
  const mutations = [s => s.event.d1_queries = 1, s => s.event.rows_read = 1, s => s.event.rows_written = 1,
    s => s.event.rate_limit_status = 'allowed', s => s.event.rate_limit_class = 'facet_miss',
    s => s.event.rate_limit_class = 'query_refill', s => s.headers['cache-control'] = 'public',
    s => s.headers['x-cache'] = 'HIT', s => s.headers['retry-after'] = '10',
    s => delete s.headers['access-control-allow-origin'], s => s.headers['access-control-expose-headers'] = 'X-Request-ID',
    s => s.body.error.code = 'OTHER', s => s.body.error.message = 'Other message', s => s.body.request_id = 'wrong',
    s => delete s.headers['x-request-id'], s => s.event.request_id = 'wrong', s => s.event.status = 200];
  for (const tier of ['expensive_miss', 'd1_miss']) for (const mutate of mutations) {
    const s = sample(429, tier), samples = [];
    mutate(s);
    let requests = 0;
    await assert.rejects(runRateSmoke({ samples, request: async () => { requests++; return s; },
      sleep: async () => assert.fail('Must stop on contract failure'),
    }), assert.AssertionError);
    assert.equal(requests, 1);
    assert.deepEqual(samples, [s]);
  }
});

test('allowed contract still rejects d1_miss and invalid metadata; unexpected HTTP status fails', async () => {
  for (const mutate of [s => s.event.rate_limit_class = 'd1_miss', s => s.event.rate_limit_status = 'denied',
    s => s.event.d1_queries = 0, s => s.event.d1_queries = Infinity, s => s.event.rows_read = null,
    s => s.event.rows_read = -1, s => s.event.rows_read = Infinity, s => s.status = s.event.status = 503]) {
    const s = sample(); mutate(s);
    await assert.rejects(runRateSmoke({ request: async () => s, sleep: async () => assert.fail('Must stop on contract failure') }), assert.AssertionError);
  }
});

test('missing measurement aborts without retries and retains earlier samples', async () => {
  const samples = [];
  let requests = 0;
  await assert.rejects(runRateSmoke({ samples, request: async () => {
    if (++requests === 2) throw new Error('Missing tail event');
    return sample();
  }, sleep: async () => {} }), /Missing tail event/);
  assert.equal(requests, 2);
  assert.equal(samples.length, 1);
});
