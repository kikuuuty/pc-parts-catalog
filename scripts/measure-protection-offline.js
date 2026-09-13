import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { protectionWorker } from '../test-support/protection-worker.js';

// Calibrated fake D1 costs, not production measurements or billing predictions.
const mixed = JSON.parse(await readFile('.cache/cache-before-complete.json', 'utf8')).mixed;
const groups = {
  unique_expensive: Array.from({ length: 100 }, (_, i) => ({ input: { category: 'memory', keyword: `ddr5${'!'.repeat(i + 1)}` } })),
  unique_normal: Array.from({ length: 100 }, (_, i) => ({ input: { category: 'cpu', keyword: `model${1000 + i}` } })),
  unique_mixed_paths: Array.from({ length: 100 }, (_, i) => ({ input: { category: ['memory', 'cpu', 'gpu', 'storage', 'motherboard'][i % 5],
    keyword: `generic${'x'.repeat(i + 1)}`, ...(i % 3 === 1 ? { offset: 120 + 20 * (i % 40) } : {}) }, method: i % 3 === 2 ? 'POST' : 'GET' })),
  post: Array.from({ length: 100 }, (_, i) => ({ input: { category: 'memory', keyword: `ddr5${'!'.repeat(i + 1)}` }, method: 'POST' })),
  pagination: Array.from({ length: 100 }, (_, i) => ({ input: { category: 'memory', keyword: `ddr5${'!'.repeat(i + 1)}`, offset: 120 + 20 * (i % 40) } })),
};
const report = { kind: 'deterministic fake binding + calibrated fake D1; not production accuracy', rows_per_execution: 35963, workloads: {} };
const totals = h => ({ attempts: h.logs.length, allowed: h.logs.filter(e => e.status === 200).length,
  limited: h.logs.filter(e => e.status === 429).length, hits: h.logs.filter(e => e.cache_status === 'HIT').length,
  expensive_attempts: h.env.EXPENSIVE_MISS_LIMITER.calls.length,
  d1_executions: h.statements.length, rows_read: h.logs.reduce((n, e) => n + e.rows_read, 0) });
for (const [name, requests] of Object.entries(groups)) {
  const result = {};
  for (const unlimited of [true, false]) {
    const h = protectionWorker({ unlimited });
    for (const r of requests) await h.request(r.input, r.method);
    result[unlimited ? 'before' : 'after'] = totals(h);
  }
  result.reduction = 1 - result.after.rows_read / result.before.rows_read;
  assert.equal(result.after.allowed, name === 'unique_normal' ? 60 : 20);
  report.workloads[name] = result;
}
// Existing normal 100-request order, all in one window. Replay exact actual costs per query.
for (const unlimited of [true, false]) {
  const h = protectionWorker({ unlimited });
  const actual = new Map(mixed.map(s => [`${s.category}:${s.query.normalize('NFKC').trim().toLowerCase()}`, s.event.rows_read]));
  const original = h.env.DB.prepare;
  h.env.DB.prepare = sql => ({ bind: (...params) => ({ all: async () => {
    const result = await original(sql).bind(...params).all();
    const name = JSON.parse(params[1]).name;
    result.meta.rows_read = actual.get(`${params[0]}:${name}`);
    assert(Number.isFinite(result.meta.rows_read));
    return result;
  } }) });
  for (const s of mixed) assert.equal((await h.request({ category: s.category, keyword: s.query })).status, 200);
  (report.normal ??= {})[unlimited ? 'before' : 'after'] = totals(h);
}
assert.deepEqual(report.normal.before, report.normal.after);
await writeFile('.cache/rate-offline.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
