import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { broadQueries, exactQueries } from './lib/broad-workload.js';
import { startTail, measure, summarize, distribution } from './lib/cache-measurement.js';
import { openDatabase } from '../src/database.js';
import { catalogState, assertCatalogState } from '../src/quality/catalog.js';

const { values: args } = parseArgs({ options: { phase: { type: 'string' }, compare: { type: 'string' }, output: { type: 'string' } } });
assert(['before', 'after'].includes(args.phase));
const output = args.output ?? `.cache/broad-worker-${args.phase}.json`;
const origin = 'https://pc-parts-catalog.kikuuuty.workers.dev';
const cases = [...broadQueries.filter(q => ['ddr5', 'ddr5 6000', 'ryzen 7', 'rtx 5080', 'b650e', '850w gold', '360mm aio'].includes(q.keyword)), ...exactQueries];
const before = args.compare ? JSON.parse(await readFile(args.compare, 'utf8')) : null;
const report = { generated_at: new Date().toISOString(), phase: args.phase, samples: [] };
const db = await openDatabase(true);
let tail;
try {
  report.sync = await catalogState(db);
  tail = await startTail();
  await tail.ready(origin);
  for (let round = 0; round < 2; round++) for (const item of cases) {
    // Existing POST no-store contract exposes SQL cost without modifying cache/epoch/rate settings.
    await delay(3500);
    const s = await measure(origin, tail, '/v1/search', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: item.category, keyword: item.keyword, limit: 20, offset: 0 }) });
    report.samples.push({ id: item.id, round, ...s });
    assert.equal(s.status, 200);
    assert.equal(s.headers['x-cache'], 'BYPASS');
    assert.equal(s.event.d1_queries, 1);
    assert.equal(s.event.rows_written, 0);
    if (before) assert.deepEqual(s.body, before.samples.find(r => r.id === item.id && r.round === round).body);
  }
  await assertCatalogState(db, report.sync);
  report.summary = { ...summarize(report.samples), cpu_ms: distribution(report.samples.map(s => s.event.cpu_ms)),
    sql_ms: distribution(report.samples.map(s => s.event.sql_duration_ms)) };
  console.log(JSON.stringify({ output, summary: report.summary }, null, 2));
} finally {
  try { await writeFile(output, JSON.stringify(report, null, 2) + '\n'); }
  finally { await tail?.stop(); await db.close(); }
}
