import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/database.js';
import { searchQuery } from '../src/queries.js';
import { loadUXFixture } from '../src/quality/ux.js';
import { catalogState, assertCatalogState } from '../src/quality/catalog.js';
import { categories } from '../src/model.js';
import { setTimeout as delay } from 'node:timers/promises';
import { classifySearchCost } from '../src/search-protection.js';
import { verifyProduction } from './lib/production-smoke.js';
import { safeDatabase } from './lib/release-gates.js';

const { values: args } = parseArgs({ options: {
  url: { type: 'string' }, remote: { type: 'boolean', default: false }, rounds: { type: 'string', default: '3' },
  golden: { type: 'boolean', default: false }, output: { type: 'string', default: '.cache/api-verification.json' },
  'direct-only': { type: 'boolean', default: false }, 'allow-partial': { type: 'boolean', default: false },
  'cache-repeat': { type: 'boolean', default: false }, 'golden-only': { type: 'boolean', default: false },
  paced: { type: 'boolean', default: false },
  smoke: { type: 'boolean', default: false },
} });
if (!args.url && !args['direct-only']) throw new Error('Provide --url http://127.0.0.1:8787 or the deployed HTTPS origin; use --remote to compare remote D1');
if (args['direct-only'] && (args.url || args.golden)) throw new Error('--direct-only cannot be combined with URL/Golden API comparison');
if (args['allow-partial'] && !args['direct-only']) throw new Error('--allow-partial is only for diagnostic direct-D1 measurements');
if ((args['cache-repeat'] || args['golden-only']) && !args.golden) throw new Error('Cache regression options require --golden');
const origin = args.url ? new URL(args.url) : null;
if (origin && (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' || !['http:', 'https:'].includes(origin.protocol))) throw new Error('--url must be an HTTP(S) origin without credentials');
if (origin && origin.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) throw new Error('Use HTTPS for production');
const rounds = Number(args.rounds);
if (args.smoke) {
  const db = safeDatabase(await openDatabase(args.remote));
  try {
    const report = await verifyProduction(db, args.url, { golden: args.golden });
    await writeFile(args.output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  } catch { console.error('API smoke/contract verification failed'); process.exitCode = 1; }
  finally { await db.close(); }
  process.exit(process.exitCode ?? 0);
}
if (!Number.isInteger(rounds) || rounds < 2 || rounds > 10) throw new Error('--rounds must be 2–10');
const cases = [
  ['cpu', '9800x3d'], ['cpu', '14900k'], ['gpu', 'rtx5080'], ['gpu', 'rtx 5080'], ['cpu', 'ryzen 7'],
  ['storage', '990pro'], ['storage', '990 pro 2tb'], ['memory', 'ddr5 6000 cl30 32gb'],
  ['psu', '850w gold'], ['cpu_cooler', '360mm aio'], ['memory', 'ddr5'],
].map(([category, query]) => ({ category, query }));
const distribution = values => {
  const sorted = values.filter(v => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  const p = n => sorted.length ? sorted[Math.ceil(n * sorted.length) - 1] : null;
  return { count: sorted.length, p50: p(0.5), p95: p(0.95), max: p(1) };
};
const report = { generated_at: new Date().toISOString(), origin: origin?.origin ?? null, direct: args.remote ? 'remote D1 REST' : 'local D1 binding',
  cache: 'Node fetch has no browser cache. X-Cache observes the application Cache API; D1 costs here are remote direct, not Worker metadata.', samples: [], golden: [] };
const request = async (path, init) => {
  const started = performance.now();
  const response = await fetch(new URL(path, origin), { ...init, signal: AbortSignal.timeout(60_000) });
  const text = await response.text();
  const elapsed_ms = performance.now() - started;
  assert.equal(response.status, 200, `HTTP ${response.status} at ${path.split('?')[0]}`);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/i, `Non-JSON response at ${path.split('?')[0]} (CF-Ray ${response.headers.get('cf-ray') ?? 'unknown'})`);
  const body = JSON.parse(text);
  return { body, elapsed_ms, request_id: response.headers.get('x-request-id'), cf_cache_status: response.headers.get('cf-cache-status'),
    cache_status: response.headers.get('x-cache'), age: response.headers.get('age'), server_timing: response.headers.get('server-timing') };
};
let lastSearch = 0, lastExpensive = 0;
const apiSearch = async (item, knownHit = false) => {
  const expensive = classifySearchCost({ ...item.search, category: item.category, keyword: item.query }, { method: item.search ? 'POST' : 'GET' }) !== 'normal';
  if (args.paced && !knownHit) {
    // Client-side administrative verification pacing, no public bypass or retries hiding 429.
    await delay(Math.max(0, lastSearch + 1100 - Date.now(), expensive ? lastExpensive + 3300 - Date.now() : 0));
    lastSearch = Date.now();
    if (expensive) lastExpensive = lastSearch;
  }
  return item.search ? request('/v1/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...item.search, category: item.category, ...(item.query?{keyword:item.query}:{}), limit: 20 }) })
    : request(`/v1/search?${new URLSearchParams({ category: item.category, q: item.query, limit: '20' })}`);
};
const ids = rows => rows.map(p => p.upstream_key);
const db = await openDatabase(args.remote);
try {
  const initial = await catalogState(db);
  report.sync = initial;
  report.partial_catalog = initial?.status !== 'complete';
  if (!args['allow-partial']) assert.equal(initial?.status, 'complete', 'Measure a completely synchronized catalog');
  if (origin) {
    assert.deepEqual((await request('/v1/health')).body, { ok: true, database: 'available' });
    assert.deepEqual((await request('/v1/categories')).body.categories, categories);
  }
  for (const item of args['golden-only'] ? [] : cases) {
    for (let round = 0; round < rounds; round++) {
      const query = searchQuery(item.category, { keyword: item.query, limit: 21 });
      const started = performance.now();
      const direct = await db.query(`${query.sql} OFFSET ?`, [...query.params, 0]);
      const direct_elapsed_ms = performance.now() - started;
      const api = origin ? await apiSearch(item) : null;
      if (!args['allow-partial']) assert(direct.results.length > 0, `No results for ${item.query}`);
      if (api) {
        assert.deepEqual(ids(api.body.data), ids(direct.results.slice(0, 20)), `Ranking mismatch: ${item.query}`);
        assert(!/search_score|search_match|search_fts_relevance/.test(JSON.stringify(api.body)));
      }
      report.samples.push({ ...item, round, phase: round === 0 ? 'first' : 'repeat', direct_elapsed_ms,
        direct_meta: direct.meta, returned: Math.min(direct.results.length, 20), api_elapsed_ms: api?.elapsed_ms ?? null,
        request_id: api?.request_id ?? null, cf_cache_status: api?.cf_cache_status ?? null,
        cache_status: api?.cache_status ?? null,
        age: api?.age ?? null, server_timing: api?.server_timing ?? null, top_results: (api?.body.data ?? direct.results).slice(0, 5) });
    }
  }
  // Also exercise the actual advanced POST endpoint regardless of --golden.
  if (origin) {
    const advanced = { category: 'gpu', query: 'rtx 5080', search: { filters: { chip_vendor: 'NVIDIA' }, ranges: { vram_gb: { min: 16 } } } };
    const advancedQuery = searchQuery(advanced.category, { ...advanced.search, keyword: advanced.query, limit: 20 });
    assert.deepEqual(ids((await apiSearch(advanced)).body.data), ids((await db.query(advancedQuery.sql, advancedQuery.params)).results));
  }
  if (args.golden) {
    const { fixture } = await loadUXFixture();
    for (const item of fixture) {
      const query = searchQuery(item.category, { ...item.search, ...(item.query?{keyword:item.query}:{}), limit: 20 });
      const direct = await db.query(query.sql, query.params);
      const api = await apiSearch(item);
      assert.deepEqual(ids(api.body.data), ids(direct.results), `Golden API ranking mismatch: ${item.id}`);
      let repeat;
      if (args['cache-repeat']) {
        repeat = await apiSearch(item, !item.search);
        assert.deepEqual(repeat.body, api.body, `Cache response mismatch: ${item.id}`);
        assert.equal(repeat.cache_status, item.search ? 'BYPASS' : 'HIT');
        if (!item.search) assert.equal(repeat.server_timing, null);
      }
      report.golden.push({ id: item.id, elapsed_ms: api.elapsed_ms, request_id: api.request_id,
        cache_status: api.cache_status, repeat_cache_status: repeat?.cache_status, repeat_request_id: repeat?.request_id,
        intent:item.intent, zero: api.body.data.length === 0, top_20: ids(api.body.data), matched: true });
    }
  }
  await assertCatalogState(db, initial);
  report.summary = {
    direct_elapsed_ms: distribution(report.samples.map(s => s.direct_elapsed_ms)),
    direct_sql_duration_ms: distribution(report.samples.map(s => s.direct_meta?.duration)),
    api_elapsed_ms: distribution(report.samples.map(s => s.api_elapsed_ms)),
    first_api_ms: distribution(report.samples.filter(s => s.round === 0).map(s => s.api_elapsed_ms)),
    repeat_api_ms: distribution(report.samples.filter(s => s.round > 0).map(s => s.api_elapsed_ms)),
    direct_rows_read: report.samples.reduce((n, s) => n + (s.direct_meta?.rows_read ?? 0), 0),
    direct_rows_written: report.samples.reduce((n, s) => n + (s.direct_meta?.rows_written ?? 0), 0),
    per_query: Object.fromEntries(cases.map(c => [c.query, {
      direct_ms: distribution(report.samples.filter(s => s.query === c.query).map(s => s.direct_elapsed_ms)),
      api_ms: distribution(report.samples.filter(s => s.query === c.query).map(s => s.api_elapsed_ms)),
      rows_read: distribution(report.samples.filter(s => s.query === c.query).map(s => s.direct_meta?.rows_read)),
      returned: distribution(report.samples.filter(s => s.query === c.query).map(s => s.returned)),
    }])), golden_matched: report.golden.length,
  };
  await writeFile(args.output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output: args.output, partial_catalog: report.partial_catalog, ...report.summary }, null, 2));
} finally { await db.close(); }
