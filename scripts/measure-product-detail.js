import assert from 'node:assert/strict';
import { parseArgs, promisify } from 'node:util';
import { spawn, execFile } from 'node:child_process';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { openDatabase } from '../src/database.js';
import { loadSnapshot } from '../src/upstream.js';
import { models } from '../src/model.js';
import { catalogState, assertCatalogState } from '../src/quality/catalog.js';
import { cloudflareRelease } from './lib/cloudflare-release.js';
import { startTail, measure, distribution } from './lib/cache-measurement.js';

const { values: args } = parseArgs({ options: {
  target: { type: 'string', default: 'preview' }, phase: { type: 'string' },
  compare: { type: 'string' }, output: { type: 'string' },
} });
assert(['production', 'preview'].includes(args.target));
assert(['before', 'after'].includes(args.phase));
const output = args.output ?? `.cache/detail-${args.target}-${args.phase}.json`;
const config = JSON.parse(await readFile('wrangler.json', 'utf8'));
const before = args.compare ? JSON.parse(await readFile(args.compare, 'utf8')) : null;
const report = { target: args.target, phase: args.phase, measured_at: new Date().toISOString(), result: 'running', samples: [] };
const db = await openDatabase(true);
const api = await cloudflareRelease(config);
let tail, child, previewConfig;
const origin = args.target === 'production' ? 'https://pc-parts-catalog.kikuuuty.workers.dev' : 'http://127.0.0.1:8791';
try {
  report.worker = await api.current();
  report.sync = await catalogState(db);
  assert.equal(report.sync.status, 'complete');
  assert.equal(report.worker.bindings.find(b => b.name === 'DB').database_id, config.d1_databases[0].database_id);
  assert.equal(report.worker.bindings.find(b => b.name === 'CATALOG_CACHE_EPOCH').text, config.vars.CATALOG_CACHE_EPOCH);
  if (before) {
    assert.deepEqual(report.sync, before.sync);
    report.products = before.products;
  } else {
    const snapshot = await loadSnapshot();
    assert.equal(snapshot.commit, report.sync.source_commit);
    const records = snapshot.records;
    const selected = [
      ['cpu', records.find(r => r.product.category === 'cpu' && /9800X3D/i.test(r.product.name))],
      ['motherboard', records.find(r => r.product.category === 'motherboard' && /^MSI MAG B850 TOMAHAWK WIFI$/i.test(r.product.name))],
      ['storage', records.find(r => r.product.category === 'storage' && /Samsung 990 Pro 2TB/i.test(r.product.name))],
    ];
    for (const [label, score] of [
      ['many identifiers', r => r.identifiers.length], ['facets', r => r.facets.length],
      ['many spec fields', r => Object.keys(models[r.product.category].fields).length],
    ]) selected.push([label, records.filter(r => !selected.some(([, s]) => s === r)).sort((a, b) => score(b) - score(a))[0]]);
    report.products = [];
    for (const [label, record] of selected) {
      assert(record, `Missing sample: ${label}`);
      const { source = 'buildcores', upstream_key } = record.product;
      const [product] = (await db.query('SELECT id,source,upstream_key,name,category FROM products WHERE source=? AND upstream_key=? AND active=1', [source, upstream_key])).results;
      assert(product, label);
      report.products.push({ label, ...product });
    }
  }
  if (args.target === 'production') {
    tail = await startTail();
    await tail.ready(origin);
  } else {
    // Remote preview only: never deploy, acquire a DB lease, rotate epoch or sync.
    // All HTTP routes exercised below are SELECT-only. Distinct limiter namespaces
    // avoid consuming production's refill quotas. The preview DB is explicit.
    previewConfig = '.catalog-release-detail-preview.json';
    const preview = { ...config, name: `pc-parts-catalog-detail-${args.phase}`, ratelimits: config.env.local.ratelimits,
      d1_databases: config.d1_databases.map(b => ({ ...b, preview_database_id: b.database_id })) };
    delete preview.env;
    await writeFile(previewConfig, JSON.stringify(preview));
    const events = new Map();
    let buffer = '', logs = '';
    child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--remote', '--config', previewConfig,
      '--ip', '127.0.0.1', '--port', '8791', '--inspector-port', '0'], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
      env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
    });
    const collect = chunk => {
      logs += chunk; buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        const start = line.indexOf('{"event":"catalog_api"');
        if (start !== -1) {
          try { const event = JSON.parse(line.slice(start, line.lastIndexOf('}') + 1)); events.set(event.request_id, event); } catch { /* startup text */ }
        }
      }
    };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    tail = {
      async event(id, timeout = 30000) {
        const deadline = Date.now() + timeout;
        while (!events.has(id)) {
          if (child.exitCode !== null || Date.now() >= deadline) throw Error('Remote preview event missing; inspect preview log');
          await delay(100);
        }
        return events.get(id);
      },
      async stop() {
        if (child.pid && child.exitCode === null) {
          if (process.platform === 'win32') await promisify(execFile)('taskkill', ['/PID', String(child.pid), '/T', '/F']).catch(() => {});
          else process.kill(-child.pid, 'SIGTERM');
        }
        await writeFile(`.cache/detail-preview-${args.phase}.log`, logs);
      },
    };
    let ready = false;
    for (let n = 0; n < 60; n++) {
      await delay(2000);
      try {
        const response = await fetch(`${origin}/v1/health`, { signal: AbortSignal.timeout(2000) });
        await response.text();
        if (response.ok) { await tail.event(response.headers.get('x-request-id')); ready = true; break; }
      } catch { if (child.exitCode !== null) break; }
    }
    assert(ready, 'Remote preview readiness failed');
  }
  for (const product of report.products) {
    for (const attempt of ['cold', 'repeat']) {
      await delay(3500);
      const sample = await measure(origin, tail, `/v1/products/${product.id}`);
      report.samples.push({ label: product.label, attempt, ...sample });
      assert.equal(sample.status, 200);
      assert.equal(sample.body.source, product.source);
      assert.equal(sample.body.upstream_key, product.upstream_key);
      assert.equal(sample.event.rows_written, 0);
      assert.equal(sample.headers['x-cache'], attempt === 'cold' ? 'MISS' : 'HIT', 'Wait for the 600s TTL before repeating this phase');
      assert.equal(sample.headers['x-cache-ttl'], '600');
      assert.equal(sample.event.d1_queries, attempt === 'cold' ? 4 : 0);
      if (args.phase === 'after') assert.equal(sample.event.d1_operations, attempt === 'cold' ? 2 : 0);
      assert(Number.isFinite(sample.event.rows_read));
      if (attempt === 'cold') assert(Number.isFinite(sample.event.sql_duration_ms));
      if (before) assert.deepEqual(sample.body, before.samples.find(s => s.label === product.label).body);
      if (attempt === 'repeat') assert.deepEqual(sample.body, report.samples.at(-2).body);
    }
  }
  await assertCatalogState(db, report.sync);
  assert.deepEqual(await api.current(), report.worker, 'Production deployment changed during measurement');
  const summarize = samples => ({ count: samples.length,
    http_ms: distribution(samples.map(s => s.elapsed_ms)),
    sql_duration_ms: distribution(samples.map(s => s.event.sql_duration_ms)),
    rows_read: distribution(samples.map(s => s.event.rows_read)),
    sql_statements: distribution(samples.map(s => s.event.d1_queries)),
    // Baseline Worker used one .all() per statement; inferred only for that code.
    d1_operations: distribution(samples.map(s => s.event.d1_operations ?? (args.phase === 'before' ? s.event.d1_queries : null))),
  });
  report.summary = {
    cold: summarize(report.samples.filter(s => s.headers['x-cache'] === 'MISS')),
    warm: summarize(report.samples.filter(s => s.headers['x-cache'] === 'HIT')),
    bypass: summarize(report.samples.filter(s => s.headers['x-cache'] === 'BYPASS')),
  };
  report.result = 'pass';
  console.log(JSON.stringify({ output, products: report.products, summary: report.summary }, null, 2));
} finally {
  await tail?.stop();
  if (previewConfig) await unlink(previewConfig);
  await db.close();
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
}
