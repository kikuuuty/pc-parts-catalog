import assert from 'node:assert/strict';
import { categories, models } from '../../src/model.js';
import { assertFilterContract, assertFilterSource } from './filter-verification.js';

export function assertFilterCacheHeaders(response) {
  assert.equal(response.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
  assert(['MISS', 'HIT'].includes(response.headers.get('x-cache')), 'Filter cache unexpectedly bypassed');
  assert.equal(response.headers.get('x-cache-ttl'), '600');
  if (response.headers.get('x-cache') === 'HIT') {
    assert.match(response.headers.get('age') ?? '', /^\d+$/);
    assert.equal(response.headers.get('server-timing'), null, 'Cache HIT must not execute D1');
  }
}

export async function verifyFilterCache(request, first, { local = false, report = {}, now = Date.now } = {}) {
  report.status = 'running'; report.attempts = [];
  let previous = first, checkedAt = now();
  const pop = response => response.headers.get('cf-ray')?.split('-').at(-1) ?? (local ? 'local' : null);
  for (let attempt = 0; attempt < 3; attempt++) {
    const next = await request('/v1/categories/cpu/filters');
    const nextAt = now();
    assertFilterCacheHeaders(next.response);
    const a = pop(previous.response), b = pop(next.response);
    const observation = { previous_cache: previous.response.headers.get('x-cache'), cache: next.response.headers.get('x-cache'), previous_pop: a, pop: b };
    report.attempts.push(observation);
    if (a && b && a === b) {
      const previousAge = Number(previous.response.headers.get('age') ?? 0);
      const expired = previousAge + (nextAt - checkedAt) / 1000 >= 600;
      if (next.response.headers.get('x-cache') !== 'HIT' && expired) {
        observation.reason = 'previous_entry_expired'; previous = next; checkedAt = nextAt; continue;
      }
      if (next.response.headers.get('x-cache') !== 'HIT') { report.status = 'failed'; assert.fail('Same-POP filter cache did not HIT'); }
      assert.deepEqual(next.body, previous.body, 'Cached filter body differs');
      report.status = 'passed'; return report;
    }
    previous = next; checkedAt = nextAt;
  }
  report.status = 'inconclusive';
  assert.fail('Filter cache verification inconclusive after bounded POP attempts');
}

export async function verifyFilterSmoke(request, snapshot, { local = false, report = {} } = {}) {
  Object.assign(report, { status: 'running', categories: [], searches: [], cache: { status: 'not_run' }, boundaries: 'not_run' });
  const bodies = new Map();
  try {
    for (const category of categories) {
      const item = { category, status: 'running' }; report.categories.push(item);
      const result = await request(`/v1/categories/${category}/filters`);
      assertFilterContract(result.body, category);
      assertFilterSource(result.body, snapshot.records.filter(r => r.product.category === category));
      assertFilterCacheHeaders(result.response);
      item.cache = result.response.headers.get('x-cache'); item.status = 'passed';
      bodies.set(category, result.body);
    }
    // Independent single-field predicates avoid synthesizing impossible AND combinations.
    for (const [category, id, bound] of [
      ['cpu', 'socket'], ['cpu_cooler', 'water_cooled'], ['motherboard', 'chipset'], ['gpu', 'vram_gb', 'min'],
      ['storage', 'nvme'], ['monitor', 'ports'], ['keyboard', 'connectivity'], ['mouse', 'weight_g', 'max'],
    ]) {
      const f = bodies.get(category).filters.find(f => f.id === id);
      const sample = { category, field: id, target: f?.target, status: 'running' }; report.searches.push(sample);
      if (!f || f.control === 'range' && f.range === null || f.control === 'multi_select' && !f.options.length) {
        Object.assign(sample, { status: 'not_applicable', reason: 'No structured values in verified source' }); continue;
      }
      const value = f.control === 'range' ? { [bound]: f.range[bound] } : f.options.slice(0, 2).map(o => o.value);
      const input = { category, [f.target]: { [id]: value }, limit: 20 };
      const expected = new Set(snapshot.records.filter(r => {
        if (r.product.category !== category) return false;
        if (f.target === 'facets') return r.facets.some(v => v.attribute === id && value.includes(v.value));
        const v = Object.hasOwn(models[category].fields, id) ? r.spec[id] : r.product[id];
        return f.target === 'ranges' ? typeof v === 'number' && Number.isFinite(v) && (bound === 'min' ? v >= value.min : v <= value.max) : value.includes(v);
      }).map(r => r.product.upstream_key));
      const result = await request('/v1/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
      assert.equal(result.response.headers.get('x-cache'), 'BYPASS');
      assert(Array.isArray(result.body.data) && result.body.data.length > 0, 'Metadata search unexpectedly empty');
      assert(result.body.data.every(p => expected.has(p.upstream_key)), 'Metadata search violates independent source predicate');
      sample.status = 'passed'; sample.returned = result.body.data.length;
    }
    // Adjacent reads: do not compare a warmed entry to the CPU response fetched
    // several minutes earlier at the start of the 30-category traversal.
    const first = await request('/v1/categories/cpu/filters');
    assertFilterCacheHeaders(first.response);
    await verifyFilterCache(request, first, { local, report: report.cache });
    report.boundaries = 'running';
    const preflight = await request('/v1/categories/cpu/filters', { method: 'OPTIONS', headers: { Origin: 'https://consumer.example', 'Access-Control-Request-Method': 'GET' } }, 204);
    assert.equal(preflight.response.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
    for (const [url, init, status, code] of [
      ['/v1/categories/not-a-category/filters', undefined, 404, 'CATEGORY_NOT_FOUND'],
      ['/v1/categories/cpu/filters?field=name', undefined, 400, 'INVALID_REQUEST'],
      ['/v1/categories/cpu/filters', { method: 'POST' }, 405, 'METHOD_NOT_ALLOWED'],
    ]) {
      const result = await request(url, init, status); assert.equal(result.body.error.code, code);
      assert.equal(result.response.headers.get('cache-control'), 'no-store');
    }
    report.boundaries = 'passed'; report.status = 'passed'; return report;
  } catch (error) {
    report.status = 'failed';
    for (const item of [...report.categories, ...report.searches, report.cache]) if (item.status === 'running') item.status = 'failed';
    if (report.boundaries === 'running') report.boundaries = 'failed';
    throw error;
  }
}
