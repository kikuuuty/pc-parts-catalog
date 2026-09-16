import assert from 'node:assert/strict';
import { categories } from '../../src/model.js';

// The registry owns the category list; consumer-visible invariants stay below.
export const PUBLIC_CATEGORIES = categories;
export function assertCategories(body) {
  assert.deepEqual([...body.categories].sort(), [...PUBLIC_CATEGORIES].sort(), 'Category contract');
}
export function assertSearchContract(body, { category, limit = 20, offset = 0 }) {
  assert(Array.isArray(body.data), 'data array required');
  const m = body.meta;
  assert.equal(m.limit, limit); assert.equal(m.offset, offset);
  assert.equal(m.returned, body.data.length);
  assert(m.returned >= 0 && m.returned <= limit);
  assert.equal(typeof m.has_more, 'boolean');
  if (m.has_more) assert.equal(m.returned, limit);
  assert([1000,100000].includes(m.window_limit));
  const next = m.has_more && offset + limit * 2 <= m.window_limit ? offset + limit : null;
  assert.equal(m.next_offset, next);
  assert.equal(m.window_exhausted, m.has_more && next === null);
  assert.equal(m.source.name, 'BuildCores OpenDB');
  assert.equal(m.source.url, 'https://github.com/buildcores/buildcores-open-db');
  assert.equal(m.source.license, 'ODC-By 1.0');
  assert.equal(m.source.license_url, 'https://opendatacommons.org/licenses/by/1-0/');
  assert.equal(m.source.attribution, 'Contains information from BuildCores OpenDB, made available under the ODC Attribution License.');
  const ids = new Set();
  for (const p of body.data) {
    assert(Number.isSafeInteger(p.id) && p.id > 0);
    assert.match(p.upstream_id, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
    assert.equal(p.upstream_key.split('/')[1], p.upstream_id);
    assert(p.upstream_key.split('/')[0].length > 0);
    assert(!ids.has(p.upstream_key)); ids.add(p.upstream_key);
    assert.equal(p.category, category);
    assert(typeof p.name === 'string' && p.name.length > 0);
    for (const field of ['manufacturer', 'series', 'variant', 'manufacturer_url']) assert(p[field] === null || typeof p[field] === 'string');
    assert(p.release_year === null || Number.isInteger(p.release_year));
    assert(p.specs && typeof p.specs === 'object' && !Array.isArray(p.specs));
    for (const field of ['search_score', 'search_match', 'search_fts_relevance', 'content_hash', 'raw_json']) assert(!Object.hasOwn(p, field));
  }
}
export function assertPublicHeaders(response) {
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
  for (const name of ['x-request-id', 'x-cache', 'retry-after']) assert(response.headers.get('access-control-expose-headers')?.toLowerCase().split(',').map(s => s.trim()).includes(name));
  assert(response.headers.get('x-request-id'));
}
