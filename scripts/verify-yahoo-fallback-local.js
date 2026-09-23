import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { writeFile } from 'node:fs/promises';
import { promisify, parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { selectYahooLookupCandidates } from '../src/offers/identifiers.js';
import { A3_FIRST_EAN, A3_YAHOO_EAN, RYZEN_EAN, a3WhiteWoodMesh } from '../test-support/yahoo.js';

// Explicit live check of the real local workerd, local catalog, Yahoo and Cache API.
// Separate port and cache epoch; no catalog sync, production requests or deployment.
const { values: args } = parseArgs({ options: {
  live: { type: 'boolean', default: false },
  'a3-id': { type: 'string', default: '22309' },
  'ryzen-id': { type: 'string', default: '372' },
  output: { type: 'string', default: '.cache/offer-fallback-live-report.json' },
} });
if (!args.live) throw new Error('Real Yahoo requests require --live and a local YAHOO_SHOPPING_APP_ID secret');
for (const id of [args['a3-id'], args['ryzen-id']]) assert(/^[1-9][0-9]*$/.test(id), 'Expected positive local product IDs');

const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const worker = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--local', '--env', 'local',
  '--persist-to', '.wrangler/state', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', '0',
  '--var', `CATALOG_CACHE_EPOCH:yahoo-fallback-${randomUUID()}`], {
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
  env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
});
// Do not persist/print raw Wrangler logs, credentials, API bodies or URLs.
const events = [];
let pending = '', spawnFailed = false;
worker.stdout.on('data', chunk => {
  pending += chunk.toString();
  const lines = pending.split('\n'); pending = lines.pop();
  for (const line of lines) {
    try {
      const event = JSON.parse(line.trim());
      if (event.event === 'catalog_api') events.push(event);
    } catch { /* Wrangler progress is not telemetry. */ }
  }
});
worker.stderr.resume();
worker.once('error', () => { spawnFailed = true; });
async function stop() {
  if (!worker.pid || worker.exitCode !== null || worker.signalCode !== null) return;
  if (process.platform === 'win32') {
    await promisify(execFile)('taskkill', ['/PID', String(worker.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
  } else {
    try { process.kill(-worker.pid, 'SIGTERM'); } catch { /* Already exited. */ }
    await delay(500);
    try { process.kill(-worker.pid, 'SIGKILL'); } catch { /* Already exited. */ }
  }
}
const interrupt = () => { void stop(); };
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
async function request(path) {
  return fetch(`${origin}${path}`, { signal: AbortSignal.timeout(25000) });
}
try {
  const deadline = Date.now() + 60000;
  while (true) {
    let healthy = false;
    try {
      const response = await fetch(`${origin}/v1/health`, { signal: AbortSignal.timeout(1500) });
      healthy = response.ok && (await response.json()).database === 'available';
    } catch { /* Still starting. */ }
    if (healthy) break;
    if (spawnFailed || worker.exitCode !== null || Date.now() >= deadline) throw new Error('Local Worker readiness failed');
    await delay(500);
  }
  const results = [];
  for (const [label, id, name, expectedCodes, hitIndex] of [
    ['a3_mesh', args['a3-id'], a3WhiteWoodMesh.metadata.name, [A3_FIRST_EAN, A3_YAHOO_EAN], 2],
    ['ryzen9800x3d', args['ryzen-id'], 'AMD Ryzen 7 9800X3D', [RYZEN_EAN], 1],
  ]) {
    const detailResponse = await request(`/v1/products/${id}`);
    assert.equal(detailResponse.status, 200, `${label}: Detail status`);
    const detail = await detailResponse.json();
    assert.equal(detail.name, name, `${label}: verify the actual local catalog product`);
    const candidates = selectYahooLookupCandidates(detail.identifiers);
    assert.deepEqual(candidates.slice(0, expectedCodes.length).map(c => c.value), expectedCodes);
    const before = structuredClone(detail.identifiers);
    const first = await request(`/v1/products/${id}/offers`);
    assert.equal(first.status, 200, `${label}: Offer status`);
    assert.equal(first.headers.get('X-Cache'), 'MISS');
    const body = await first.json();
    assert.equal(body.lookup.strategy, 'ean13_as_jan');
    assert(body.offers.length > 0, `${label}: at least one live Offer`);
    assert(body.offers.every(o => o.jan_code === expectedCodes[hitIndex - 1]), `${label}: exact match`);
    assert(body.offers.every(o => o.image && o.seller.image && o.fetched_at), `${label}: normalized metadata`);
    const second = await request(`/v1/products/${id}/offers`);
    assert.equal(second.status, 200); assert.equal(second.headers.get('X-Cache'), 'HIT');
    assert.deepEqual(await second.json(), body, `${label}: HIT preserves all metadata and fetched_at`);
    const after = await request(`/v1/products/${id}`);
    assert.deepEqual((await after.json()).identifiers, before);
    const ids = [first, second].map(r => r.headers.get('X-Request-ID'));
    for (let i = 0; i < 20 && !ids.every(id => events.some(e => e.request_id === id)); i++) await delay(100);
    const [miss, hit] = ids.map(id => events.find(e => e.request_id === id));
    assert(miss && hit, `${label}: real Worker telemetry received`);
    assert.equal(miss.lookup_attempts, hitIndex); assert.equal(miss.lookup_hit_index, hitIndex);
    assert.equal(miss.lookup_candidate_count, Math.min(candidates.length, 3));
    assert.equal(miss.rate_limit_class, 'yahoo_offer_miss'); assert.equal(miss.rate_limit_status, 'allowed');
    assert.equal(hit.lookup_attempts, hitIndex); assert.equal(hit.rate_limit_status, 'not_checked');
    const logs = JSON.stringify(events);
    for (const value of [...candidates.map(c => c.value), name, 'https://', 'appid=']) assert(!logs.includes(value), 'Private lookup data in telemetry');
    results.push({ product: label, candidate_count: miss.lookup_candidate_count, attempts: miss.lookup_attempts,
      hit_index: miss.lookup_hit_index, offer_count: body.offers.length, first_cache: 'MISS', repeat_cache: 'HIT',
      repeat_budget: hit.rate_limit_status, exact_match: true, metadata_preserved: true, telemetry_private: true });
    await delay(1100);
  }
  const report = { ok: true, runtime: 'local workerd', live: true, results };
  await writeFile(args.output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await stop();
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
}
