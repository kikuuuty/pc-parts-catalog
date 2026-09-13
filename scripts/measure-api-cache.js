import { parseArgs } from 'node:util';
import { writeFile, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { loadSearchFixture } from '../src/quality/fixtures.js';
import { openDatabase } from '../src/database.js';
import { catalogState, assertCatalogState } from '../src/quality/catalog.js';
import { startTail, measure, summarize, popular } from './lib/cache-measurement.js';

const { values: args } = parseArgs({ options: {
  url: { type: 'string', default: 'https://pc-parts-catalog.kikuuuty.workers.dev' },
  baseline: { type: 'boolean', default: false }, output: { type: 'string' },
  compare: { type: 'string' }, 'expiry-seconds': { type: 'string', default: '305' },
} });
const output = args.output ?? `.cache/cache-${args.baseline ? 'before' : 'after'}.json`;
const { fixture } = await loadSearchFixture();
const unique = fixture.filter(item => !item.search && !popular.some(([c, q]) => c === item.category && q === item.query))
  .filter((item, i, all) => all.findIndex(other => other.category === item.category && other.query === item.query) === i).slice(0, 30);
assert.equal(unique.length, 30);
const workload = popular.flatMap(([category, query, n]) => Array.from({ length: n }, () => ({ category, query })))
  .concat(unique.map(({ category, query }) => ({ category, query })));
// Deterministic interleaving, identical before/after (no random cache-busting query parameters).
const ordered = Array.from({ length: 100 }, (_, i) => workload[(i * 37) % 100]);
const report = { generated_at: new Date().toISOString(), origin: args.url, baseline: args.baseline, repeated: [], mixed: [] };
const before = args.compare ? JSON.parse(await readFile(args.compare, 'utf8')) : null;
const db = await openDatabase(true);
const tail = await startTail();
try {
  const initial = await catalogState(db);
  assert.equal(initial.status, 'complete');
  report.sync = initial;
  await tail.ready(args.url);
  const get = async (category, query) => {
    const sample = await measure(args.url, tail, `/v1/search?${new URLSearchParams({ category, q: query })}`);
    assert.equal(sample.status, 200);
    assert.equal(sample.event.rows_written, 0);
    if (!args.baseline) {
      assert(['HIT', 'MISS'].includes(sample.headers['x-cache']));
      if (sample.headers['x-cache'] === 'HIT') {
        assert.equal(sample.event.d1_queries, 0);
        assert.equal(sample.event.rows_read, 0);
        assert.equal(sample.headers['server-timing'], undefined);
      } else assert.equal(sample.event.d1_queries, 1);
    }
    return { category, query, ...sample };
  };
  for (const [category, query] of popular.slice(0, 5)) {
    const n = query === 'ddr5' ? 10 : 3;
    for (let i = 0; i < n; i++) {
      const sample = await get(category, query);
      const first = report.repeated.find(s => s.category === category && s.query === query);
      if (first) assert.deepEqual(sample.body, first.body);
      if (!args.baseline) assert.equal(sample.headers['x-cache'], i === 0 ? 'MISS' : 'HIT');
      if (before) assert.deepEqual(sample.body, before.repeated.find(s => s.category === category && s.query === query).body);
      report.repeated.push(sample);
    }
  }
  if (!args.baseline) {
    console.log(`Repeated MISS/HIT verified. Waiting ${args['expiry-seconds']}s to verify real edge expiration and start a cold mixed workload.`);
    await delay(Number(args['expiry-seconds']) * 1000);
  }
  for (let i = 0; i < ordered.length; i++) {
    const { category, query } = ordered[i];
    const sample = await get(category, query);
    if (before) assert.deepEqual(sample.body, before.mixed[i].body);
    report.mixed.push(sample);
  }
  if (!args.baseline) {
    const firstDdr = report.mixed.find(s => s.query === 'ddr5');
    assert.equal(firstDdr.headers['x-cache'], 'MISS', 'Expired entry must execute D1');
  }
  await assertCatalogState(db, initial);
  report.summary = { repeated: summarize(report.repeated), mixed: summarize(report.mixed),
    per_query: Object.fromEntries(popular.slice(0, 5).map(([, q]) => [q, summarize(report.repeated.filter(s => s.query === q))])) };
  console.log(JSON.stringify({ output, ...report.summary }, null, 2));
} finally {
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  await tail.stop();
  await db.close();
}
