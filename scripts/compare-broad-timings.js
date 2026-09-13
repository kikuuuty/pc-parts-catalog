import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/database.js';
import { distribution } from './lib/cache-measurement.js';

const before = JSON.parse(await readFile('.cache/broad-read-before.json', 'utf8'));
const after = JSON.parse(await readFile('.cache/broad-read-after.json', 'utf8'));
const db = await openDatabase();
const samples = [];
try {
  for (const id of ['broad:memory:ddr5', 'broad:memory:ddr5 6000', 'broad:case:atx', 'exact:14900k']) {
    for (let round = 0; round < 3; round++) for (const [phase, data] of round % 2 ? [['after', after], ['before', before]] : [['before', before], ['after', after]]) {
      const query = data.results.find(r => r.id === id);
      const started = performance.now();
      const result = await db.query(query.sql, query.params);
      assert.deepEqual(result.results, query.rows);
      samples.push({ id, phase, round, elapsed_ms: performance.now() - started, meta: result.meta });
    }
  }
  const summary = Object.fromEntries([...new Set(samples.map(s => s.id))].map(id => [id,
    Object.fromEntries(['before', 'after'].map(phase => [phase, distribution(samples.filter(s => s.id === id && s.phase === phase).map(s => s.meta.duration))]))]));
  await writeFile('.cache/broad-timings.json', JSON.stringify({ samples, summary }, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
} finally { await db.close(); }
