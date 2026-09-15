import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { startTail, measure } from './lib/cache-measurement.js';
import { assertCategories } from './lib/api-contract.js';

const origin = process.argv[2] ?? 'https://pc-parts-catalog.kikuuuty.workers.dev';
const output = '.cache/cache-production-smoke.json';
const tail = await startTail();
const samples = [];
const post = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
try {
  await tail.ready(origin);
  const check = async (path, init, status = 200) => {
    const sample = await measure(origin, tail, path, init);
    samples.push(sample);
    assert.equal(sample.status, status);
    assert.equal(sample.headers['access-control-allow-origin'], '*');
    if (status !== 200 || init?.method === 'POST' || path === '/v1/health') {
      assert.equal(sample.headers['cache-control'], 'no-store');
      assert.equal(sample.headers['x-cache'], 'BYPASS');
    }
    assert.equal(sample.event.rows_written, 0);
    if (sample.headers['x-cache'] === 'HIT') {
      assert.equal(sample.event.d1_queries, 0);
      assert.equal(sample.event.rows_read, 0);
      assert.equal(sample.headers['server-timing'], undefined);
    }
    return sample;
  };
  assert.equal((await check('/v1/health')).body.ok, true);
  assertCategories((await check('/v1/categories')).body);
  const pages = [];
  for (const offset of [0, 20]) {
    const first = await check(`/v1/search?category=memory&q=ddr5&offset=${offset}`);
    const canonical = await check(`/v1/search?q=%20ddr5%20&limit=020&offset=0${offset}&category=memory`, {
      headers: { Origin: 'https://client.example', Range: 'bytes=0-10', 'If-None-Match': '*' },
    });
    assert.equal(canonical.headers['x-cache'], 'HIT');
    assert.deepEqual(canonical.body, first.body);
    const direct = await check('/v1/search', post({ category: 'memory', keyword: 'ddr5', offset }));
    assert.deepEqual(first.body, direct.body);
    assert.equal(first.body.meta.offset, offset);
    assert.equal(first.body.meta.next_offset, offset + 20);
    assert.equal(first.body.meta.source.license, 'ODC-By 1.0');
    pages.push(...first.body.data.map(p => p.upstream_key));
  }
  assert.equal(new Set(pages).size, 40);
  for (let i = 0; i < 2; i++) {
    const advanced = await check('/v1/search', post({ category: 'gpu', keyword: 'rtx 5080', filters: { chip_vendor: 'NVIDIA' }, ranges: { vram_gb: { min: 16 } } }));
    assert.equal(advanced.event.d1_queries, 1);
    assert(advanced.body.data.every(p => p.specs.chip_vendor === 'NVIDIA' && p.specs.vram_gb >= 16));
  }
  for (const page of ['limit=1', 'offset=1', 'limit=50&offset=950']) {
    assert.equal((await check(`/v1/search?category=memory&q=ddr5&${page}`)).headers['x-cache'], 'BYPASS');
  }
  const options = await check('/v1/search', { method: 'OPTIONS', headers: { Origin: 'https://client.example',
    'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } }, 204);
  assert.match(options.headers['access-control-allow-methods'], /POST/);
  for (let i = 0; i < 2; i++) for (const [path, init, status] of [
    ['/v1/search?category=invalid', undefined, 400], ['/v1/search?category=cpu&limit=51', undefined, 400],
    ['/v1/search?category=cpu&q=14900k&category=cpu', undefined, 400],
    ['/v1/search', { ...post({}), body: '{' }, 400],
    ['/unknown', undefined, 404], ['/v1/search', { method: 'DELETE' }, 405],
    ['/v1/search', post({ category: 'cpu', keyword: 'x'.repeat(17000) }), 413],
    ['/v1/search', { method: 'POST', body: '{}' }, 415],
  ]) {
    const error = await check(path, init, status);
    assert.equal(error.event.d1_queries, 0);
    assert(!/SELECT|SQL|stack/.test(JSON.stringify(error.body)));
    assert.equal(error.body.request_id, error.headers['x-request-id']);
  }
  console.log(JSON.stringify({ output, checks: samples.length, tail_matched: samples.length,
    cache_hits: samples.filter(s => s.headers['x-cache'] === 'HIT').length, passed: true }, null, 2));
} finally {
  await writeFile(output, JSON.stringify({ generated_at: new Date().toISOString(), origin, samples }, null, 2) + '\n');
  await tail.stop();
}
