import { readFile, writeFile } from 'node:fs/promises';
import { classifySearchCost } from '../src/search-protection.js';
import { loadSearchFixture } from '../src/quality/fixtures.js';
import { distribution } from './lib/cache-measurement.js';

const baseline = JSON.parse(await readFile('.cache/rate-before.json', 'utf8'));
const saved = JSON.parse(await readFile('.cache/search-fts-remote-after.json', 'utf8'));
const { fixture, hash } = await loadSearchFixture();
if (saved.fixture_sha256 !== hash) throw new Error('Baseline fixture differs');
const samples = baseline.baseline.map(s => ({ id: s.name, source: 'Worker LIMIT21 + OFFSET',
  predicted: classifySearchCost(s.input, { method: s.method, cacheEligible: s.headers['x-cache'] === 'MISS' }), rows_read: s.event.rows_read }));
for (const item of fixture) {
  const actual = saved.results.find(r => r.id === item.id);
  // Saved Golden metadata includes its own benchmark scan/limit, not Worker CPU.
  samples.push({ id: item.id, source: 'saved remote Golden benchmark',
    predicted: classifySearchCost({ ...item.search, category: item.category, keyword: item.query }, { method: item.search ? 'POST' : 'GET' }),
    rows_read: actual.rows_read });
}
if (!samples.every(s => Number.isFinite(s.rows_read))) throw new Error('Missing actual cost');
const report = { generated_at: new Date().toISOString(), expensive_boundary_rows: 5000,
  samples, classes: Object.fromEntries(['normal', 'expensive', 'uncached'].map(c => [c, distribution(samples.filter(s => s.predicted === c).map(s => s.rows_read))])),
  false_negatives: samples.filter(s => s.rows_read >= 5000 && s.predicted === 'normal'),
  conservative: samples.filter(s => s.rows_read < 5000 && s.predicted !== 'normal').length };
await writeFile('.cache/rate-classifier.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, samples: undefined }, null, 2));
