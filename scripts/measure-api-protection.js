import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { startTail, measure, summarize, distribution } from './lib/cache-measurement.js';
import { openDatabase } from '../src/database.js';
import { catalogState, assertCatalogState } from '../src/quality/catalog.js';

const { values: args } = parseArgs({ options: {
  phase: { type: 'string' }, url: { type: 'string', default: 'https://pc-parts-catalog.kikuuuty.workers.dev' },
  compare: { type: 'string' },
  output: { type: 'string' },
  'cold-wait-seconds': { type: 'string', default: '0' },
} });
assert(['before', 'after'].includes(args.phase), 'Use --phase before|after; at most 27 search requests per run');
const post = input => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
const cases = [
  ['exact model', { category: 'cpu', keyword: '14900k' }],
  ['manufacturer + model', { category: 'cpu', keyword: 'intel 14900k' }],
  ['family', { category: 'cpu', keyword: 'ryzen 7' }],
  ['model + spec', { category: 'storage', keyword: '990 pro 2tb' }],
  ['spec-only combined', { category: 'memory', keyword: 'ddr5 6000 cl30 32gb' }],
  ['spec-only broad', { category: 'memory', keyword: 'ddr5' }],
  ['single generic token', { category: 'memory', keyword: 'corsair' }],
  ['category listing', { category: 'memory' }],
  ['POST advanced', { category: 'gpu', keyword: 'rtx 5080', filters: { chip_vendor: 'NVIDIA' }, ranges: { vram_gb: { min: 16 } } }, true],
  ['deep pagination', { category: 'memory', keyword: 'ddr5', offset: 120 }],
  ['nonstandard limit', { category: 'memory', keyword: 'ddr5', limit: 10 }],
];
const report = { generated_at: new Date().toISOString(), phase: args.phase, baseline: [], stampede: [] };
const output = args.output ?? `.cache/rate-${args.phase}.json`;
const before = args.compare ? JSON.parse(await readFile(args.compare, 'utf8')) : null;
const wait = Number(args['cold-wait-seconds']);
assert(Number.isInteger(wait) && wait >= 0 && wait <= 600);
if (wait) await delay(wait * 1000);
const db = await openDatabase(true);
let tail;
const summary = samples => ({ ...summarize(samples), ok: samples.filter(s => s.status === 200).length,
  limited: samples.filter(s => s.status === 429).length, d1_queries: samples.reduce((n, s) => n + s.event.d1_queries, 0),
  cpu_ms: distribution(samples.map(s => s.event.cpu_ms)) });
try {
  tail = await startTail();
  report.sync = await catalogState(db);
  assert.equal(report.sync.status, 'complete');
  await tail.ready(args.url);
  for (const [name, input, advanced] of cases) {
    // Valid independent standard page for a cold cost sample; no cache buster or purge.
    const params = { category: input.category, ...(input.keyword === undefined ? {} : { q: input.keyword }),
      limit: String(input.limit ?? 20), offset: String(input.offset ?? 60) };
    const sample = await measure(args.url, tail, advanced ? '/v1/search' : `/v1/search?${new URLSearchParams(params)}`, advanced ? post(input) : undefined);
    report.baseline.push({ name, input: advanced ? input : { ...input, offset: Number(params.offset) }, method: advanced ? 'POST' : 'GET', ...sample });
    assert.equal(sample.status, 200);
    assert.equal(sample.event.d1_queries, 1, 'Baseline entry must be cold; wait TTL before running');
    if (before) assert.deepEqual(sample.body, before.baseline.find(s => s.name === name).body);
  }
  // Only six concurrent cold requests, on a cheap model (49 reads per execution).
  const path = '/v1/search?category=cpu&q=14900k&offset=100';
  report.stampede = await Promise.all(Array.from({ length: 6 }, () => measure(args.url, tail, path)));
  assert(report.stampede.every(s => [200, 429].includes(s.status)));
  const success = report.stampede.find(s => s.status === 200);
  assert(success);
  for (const s of report.stampede) {
    if (s.status === 200) assert.deepEqual(s.body, success.body);
    else {
      assert.equal(s.event.d1_queries, 0);
      assert.equal(s.headers['cache-control'], 'no-store');
      assert.equal(s.body.error.code, 'RATE_LIMITED');
      assert.equal(s.headers['retry-after'], '10');
    }
  }
  report.warm = [];
  for (let i = 0; i < 10; i++) {
    const s = await measure(args.url, tail, path);
    report.warm.push(s);
    assert.equal(s.status, 200);
    assert.equal(s.headers['x-cache'], 'HIT');
    assert.equal(s.event.d1_queries, 0);
    if (args.phase === 'after') assert.equal(s.event.rate_limit_status, 'not_checked');
  }
  await assertCatalogState(db, report.sync);
  report.summary = Object.fromEntries(['baseline', 'stampede', 'warm'].map(k => [k, summary(report[k])]));
  console.log(JSON.stringify({ output, ...report.summary,
    costs: report.baseline.map(s => ({ name: s.name, reads: s.event.rows_read, sql_ms: s.event.sql_duration_ms, cpu_ms: s.event.cpu_ms, http_ms: s.elapsed_ms })) }, null, 2));
} finally {
  try { await writeFile(output, JSON.stringify(report, null, 2) + '\n'); }
  finally { await tail?.stop(); await db.close(); }
}
