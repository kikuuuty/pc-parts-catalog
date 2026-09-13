import { readFile, writeFile } from 'node:fs/promises';
import { summarize, distribution } from './lib/cache-measurement.js';
const load = async name => JSON.parse(await readFile(`.cache/${name}.json`, 'utf8'));
const summary = samples => ({ ...summarize(samples), ok: samples.filter(s => s.status === 200).length,
  limited: samples.filter(s => s.status === 429).length,
  d1_queries: samples.every(s => Number.isInteger(s.event.d1_queries)) ? samples.reduce((n, s) => n + s.event.d1_queries, 0) : null,
  cpu_ms: distribution(samples.map(s => s.event.cpu_ms)),
  hit_cpu_ms: distribution(samples.filter(s => s.headers['x-cache'] === 'HIT').map(s => s.event.cpu_ms)),
  miss_cpu_ms: distribution(samples.filter(s => s.headers['x-cache'] === 'MISS').map(s => s.event.cpu_ms)),
  cost_classes: Object.fromEntries(['not_classified', 'normal', 'expensive', 'uncached'].map(c => [c, samples.filter(s => s.event.search_cost_class === c).length])),
});
const before = await load('rate-before'), after = await load('rate-after-inflight');
const oldCache = await load('cache-after'), newCache = await load('rate-cache-after');
const report = { generated_at: new Date().toISOString(),
  normal: { before: summary(oldCache.mixed), after: summary(newCache.mixed) },
  repeated: summary(newCache.repeated),
  stampede: { before: summary(before.stampede), after: summary(after.stampede) },
  baseline: { before: summary(before.baseline), after: summary(after.baseline) },
  warm: { before: summary(before.warm), after: summary(after.warm) },
  post_probe: summary((await load('rate-production-429')).samples),
  golden: (await load('api-rate-golden')).summary.golden_metrics,
  classifier: await load('rate-classifier'), offline: await load('rate-offline'),
};
await writeFile('.cache/rate-summary.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, classifier: undefined, offline: undefined }, null, 2));
