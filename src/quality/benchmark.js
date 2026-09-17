import { createHash } from 'node:crypto';
import { categories } from '../model.js';
import { identifierKey } from '../normalize.js';
import { searchQuery } from '../queries.js';
import { assertCatalogState, envelope, isMissing, manufacturerKey, nameKey, normalizedIdentifier, productSummary, validIdentifiers } from './catalog.js';
import { selectExpectedSet } from './selection.js';

export const queryClasses = ['exact_model','compact_model','family','manufacturer_model','model_spec','spec_only','identifier','broad','fallback','variant','typed_spec','facet','range'];
export const querySuites = ['regression','development','holdout','extended'];

export const failureTypes = ['MISSING_PRODUCT','NO_SEARCH_MATCH','RANKING_FAILURE','EXPECTED_DATA_INVALID'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && !isMissing(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);

function validateSelector(expected, identifierTypes) {
  if (!object(expected)) throw new Error('expected must be an object');
  const selectors = ['upstream_id','upstream_key','identifier','mpn','nameContains'];
  const allowed = new Set([...selectors,'manufacturer','source']);
  if (Object.keys(expected).some(k => !allowed.has(k))) throw new Error('Unknown expected selector field');
  if (selectors.filter(k => Object.hasOwn(expected, k)).length !== 1) throw new Error('Use exactly one selector per expected target; use anyOf for multiple targets');
  for (const k of ['manufacturer','source']) if (expected[k] !== undefined && !nonempty(expected[k])) throw new Error(`Invalid expected ${k}`);
  if (expected.upstream_id !== undefined && !uuid(expected.upstream_id)) throw new Error('Expected upstream_id must be a UUID');
  if (expected.upstream_key !== undefined && (!nonempty(expected.upstream_key) || !uuid(expected.upstream_key.split('/')[1]) || expected.upstream_key.split('/').length !== 2)) throw new Error('Invalid upstream_key');
  if (expected.mpn !== undefined && !nonempty(expected.mpn)) throw new Error('Invalid MPN');
  if (expected.nameContains !== undefined && (!Array.isArray(expected.nameContains) || !expected.nameContains.length || expected.nameContains.some(v => !nonempty(v)))) throw new Error('nameContains must be a nonempty array of nonempty strings (AND)');
  if (expected.identifier !== undefined) {
    const i = expected.identifier;
    if (!object(i) || Object.keys(i).some(k => !['type','value','region'].includes(k)) || !identifierTypes.includes(i.type) || !nonempty(i.value) || (i.region !== undefined && !nonempty(i.region))) throw new Error('Invalid expected identifier');
  }
}

export function matchesExpected(product, expected) {
  if (expected.manufacturer && manufacturerKey(product.manufacturer) !== manufacturerKey(expected.manufacturer)) return false;
  if (expected.source && product.source !== expected.source) return false;
  if (expected.upstream_id !== undefined) return product.upstream_id.toLowerCase() === expected.upstream_id.toLowerCase();
  if (expected.upstream_key !== undefined) return product.upstream_key === expected.upstream_key;
  if (expected.nameContains !== undefined) return expected.nameContains.every(term => nameKey(product.name)?.includes(nameKey(term)));
  const identifier = expected.identifier ?? { type: 'mpn', value: expected.mpn };
  return validIdentifiers(product).some(i => i.type === identifier.type && normalizedIdentifier(i) === identifierKey(identifier.value) && (identifier.region === undefined || i.region === identifier.region));
}

// Resolve independently of FTS so missing catalog data is not mistaken for search failure.
export function resolveExpected(catalog, category, expected) {
  try {
    if (object(expected) && Object.hasOwn(expected,'set')) {
      const products = selectExpectedSet(catalog,category,expected);
      return { status:products.length ? null : 'MISSING_PRODUCT', reason:products.length ? null : 'No product satisfies expected set', products, missing:[], ambiguous:[] };
    }
    let selectors;
    if (object(expected) && Object.hasOwn(expected, 'upstream_ids')) {
      if (Object.keys(expected).length !== 1 || !Array.isArray(expected.upstream_ids) || !expected.upstream_ids.length || expected.upstream_ids.length > 500) throw new Error('upstream_ids needs 1–500 explicit UUIDs');
      selectors = expected.upstream_ids.map(upstream_id => ({ upstream_id }));
    } else if (object(expected) && Object.hasOwn(expected, 'anyOf')) {
      if (Object.keys(expected).length !== 1 || !Array.isArray(expected.anyOf) || !expected.anyOf.length || expected.anyOf.length > 500) throw new Error('anyOf needs 1–500 explicit targets');
      selectors = expected.anyOf;
    } else selectors = [expected];
    const products = new Map();
    const missing = [];
    const ambiguous = [];
    for (const selector of selectors) {
      validateSelector(selector, catalog.identifierTypes);
      const matches = catalog.products.filter(p => p.category === category && matchesExpected(p, selector));
      if (!matches.length) missing.push(selector);
      else if (matches.length > 1) ambiguous.push({ selector, products: matches.map(productSummary) });
      else products.set(matches[0].id, matches[0]);
    }
    if (ambiguous.length) return { status: 'EXPECTED_DATA_INVALID', reason: 'Ambiguous expected target; use stable IDs in anyOf', products: [], missing, ambiguous };
    return { status: products.size ? null : 'MISSING_PRODUCT', reason: products.size ? null : 'No expected product exists in this category', products: [...products.values()], missing, ambiguous };
  } catch (error) {
    return { status: 'EXPECTED_DATA_INVALID', reason: error.message, products: [], missing: [], ambiguous: [] };
  }
}

export function classifyFailure({ expectedStatus, rank }) {
  if (expectedStatus) return expectedStatus;
  if (rank === null) return 'NO_SEARCH_MATCH';
  return rank > 10 ? 'RANKING_FAILURE' : 'HIT';
}

export function benchmarkMetrics(results) {
  // Invalid fixtures are visible, but are not scored as retrieval failures.
  // Missing products ARE scored as zero, measuring end-to-end catalog usefulness.
  const scored = results.filter(r => r.status !== 'EXPECTED_DATA_INVALID');
  const rate = count => scored.length ? count / scored.length : null;
  const precision = scored.filter(r => r.precision_at_5 != null);
  return {
    query_count: results.length, scored_query_count: scored.length,
    missing_expected_target_count: results.reduce((sum,r) => sum + (r.missing_targets?.length ?? 0),0),
    zero_result_count: results.filter(r => r.zero_results === true).length,
    zero_result_rate: rate(scored.filter(r => r.zero_results === true).length),
    failed_query_count: results.filter(r => r.status !== 'HIT').length,
    hit_at_1: rate(scored.filter(r => r.rank !== null && r.rank <= 1).length),
    hit_at_5: rate(scored.filter(r => r.rank !== null && r.rank <= 5).length),
    hit_at_10: rate(scored.filter(r => r.rank !== null && r.rank <= 10).length),
    mrr: scored.length ? scored.reduce((sum,r) => sum + (r.rank === null ? 0 : 1 / r.rank), 0) / scored.length : null,
    precision_query_count: precision.length,
    precision_at_5: precision.length ? precision.reduce((sum,r) => sum+r.precision_at_5,0)/precision.length : null,
    precision_at_10: precision.length ? precision.reduce((sum,r) => sum+r.precision_at_10,0)/precision.length : null,
    recall_at_10: scored.some(r => r.recall_at_10 != null) ? scored.filter(r => r.recall_at_10 != null).reduce((n,r) => n+r.recall_at_10,0)/scored.filter(r => r.recall_at_10 != null).length : null,
    failures: Object.fromEntries(failureTypes.map(type => [type, results.filter(r => r.status === type).length])),
  };
}

function validateCase(item) {
  if (!object(item) || !nonempty(item.id) || !categories.includes(item.category) || !nonempty(item.query)) throw new Error('Case needs id, known category, and nonempty query');
  if (Object.keys(item).some(k => !['id','category','query','expected','search','notes','class','suite','acceptable'].includes(k))) throw new Error('Unknown benchmark case field');
  if (item.class !== undefined && !queryClasses.includes(item.class)) throw new Error('Unknown query class');
  if (item.suite !== undefined && !querySuites.includes(item.suite)) throw new Error('Unknown query suite');
  if (item.search !== undefined && (!object(item.search) || Object.keys(item.search).some(k => !['filters','ranges','facets','identifier','orderBy'].includes(k)))) throw new Error('search only accepts actual searchQuery filters/ranges/facets/identifier/orderBy');
}

export async function benchmarkSearch(db, catalog, fixture, { category, suite, queryClass, fixtureHash = null, searchImplementationHash = null, queryBuilder = searchQuery } = {}) {
  if (!Array.isArray(fixture) || !fixture.length) throw new Error('Benchmark fixture must be a nonempty JSON array');
  if (category !== undefined && !categories.includes(category)) throw new Error(`Unknown category: ${category}`);
  if (suite !== undefined && ![...querySuites,'new'].includes(suite)) throw new Error(`Unknown suite: ${suite}`);
  if (queryClass !== undefined && !queryClasses.includes(queryClass)) throw new Error(`Unknown query class: ${queryClass}`);
  const ids = new Map();
  for (const item of fixture) if (nonempty(item?.id)) ids.set(item.id, (ids.get(item.id) ?? 0) + 1);
  const cases = fixture.filter(q => (!category || q?.category === category) && (!suite ||
    (suite === 'new' ? ['development','holdout'].includes(q?.suite) : (q?.suite ?? 'regression') === suite)) && (!queryClass || q?.class === queryClass));
  const results = [];
  for (const item of cases) {
    let query;
    let resolution;
    let acceptable;
    const result = {
      id: item?.id ?? null, category: item?.category ?? null, query: item?.query ?? null, expected: item?.expected ?? null,
      class:item?.class ?? 'unclassified', suite:item?.suite ?? 'regression', acceptable:item?.acceptable ?? null,
      precision_at_5:null, precision_at_10:null, acceptable_count:null,
      search_options: item?.search ?? {}, notes: item?.notes ?? null,
      status: null, reason: null, rank: null, reciprocal_rank: 0,
      zero_results: null, retrieved_count: 0, search_exhausted: false,
      resolved_products: [], missing_targets: [], ambiguous_targets: [], top_results: [],
      executed_pages: 0, rows_read: 0, elapsed_ms: 0, sql_duration_ms:0, size_bytes:null, sql: null, params: [],
    };
    try {
      validateCase(item);
      if (ids.get(item.id) > 1) throw new Error('Duplicate fixture case id');
      query = queryBuilder(item.category, { ...item.search, keyword: item.query, limit: 100 });
      resolution = resolveExpected(catalog, item.category, item.expected);
      if (resolution.status === 'EXPECTED_DATA_INVALID') {
        result.ambiguous_targets = resolution.ambiguous;
        throw new Error(resolution.reason);
      }
      if (item.acceptable !== undefined) {
        const resolved = resolveExpected(catalog,item.category,item.acceptable);
        if (resolved.status === 'EXPECTED_DATA_INVALID') throw new Error(`Invalid acceptable: ${resolved.reason}`);
        acceptable = new Set(resolved.products.map(p => p.id));
        result.acceptable_count = acceptable.size;
      }
    } catch (error) {
      result.status = 'EXPECTED_DATA_INVALID';
      result.reason = error.message;
      results.push(result);
      continue;
    }
    result.sql = query.sql;
    result.params = query.params;
    result.resolved_products = resolution.products.map(productSummary);
    result.missing_targets = resolution.missing;
    const targetIds = new Set(resolution.products.map(p => p.id));
    let offset = 0;
    const started = performance.now();
    // Append only pagination to the real generated SQL; predicates and ordering stay intact.
    // Diagnostic ranking is bounded by the same keyword window as the UI.
    while (offset < 1000) {
      // When the real query already uses all 100 D1 binds, emit the internally
      // counted integer offset as a literal rather than creating a 101st bind.
      const bindOffset = query.params.length < 100;
      const sql = offset ? `${query.sql} OFFSET ${bindOffset ? '?' : offset}` : query.sql;
      const params = offset && bindOffset ? [...query.params,offset] : query.params;
      const page = await db.query(sql, params);
      result.executed_pages++;
      result.rows_read += page.meta?.rows_read ?? 0;
      result.sql_duration_ms += page.meta?.duration ?? 0;
      result.size_bytes = page.meta?.size_after ?? null;
      if (offset === 0) {
        result.zero_results = page.results.length === 0;
        result.top_results = page.results.slice(0,20).map((p,index) => ({ rank: index+1, ...productSummary(p) }));
        if (acceptable) {
          result.precision_at_5 = page.results.slice(0,5).filter(p => acceptable.has(p.id)).length/5;
          result.precision_at_10 = page.results.slice(0,10).filter(p => acceptable.has(p.id)).length/10;
          result.recall_at_10 = acceptable.size > 1 ? page.results.slice(0,10).filter(p => acceptable.has(p.id)).length/acceptable.size : null;
        }
      }
      result.retrieved_count += page.results.length;
      result.search_exhausted = page.results.length < 100;
      const found = page.results.findIndex(p => targetIds.has(p.id));
      if (found !== -1) result.rank = offset + found + 1;
      if (result.rank !== null || result.search_exhausted || !targetIds.size) break;
      offset += page.results.length;
    }
    result.elapsed_ms = performance.now() - started;
    result.reciprocal_rank = result.rank === null ? 0 : 1/result.rank;
    result.status = classifyFailure({ expectedStatus: resolution.status, rank: result.rank });
    result.reason = resolution.reason;
    if (result.status === 'NO_SEARCH_MATCH') {
      result.reason = resolution.products.every(p => p.active !== 1) ? 'INACTIVE_PRODUCT'
        : resolution.products.filter(p => p.active === 1).every(p => !p.spec) ? 'MISSING_SPEC_ROW'
          : 'No match from the current FTS/identifier/typed-filter combination';
    } else if (result.status === 'RANKING_FAILURE') result.reason = 'Expected product matches, but is below rank 10 in the current ordering';
    results.push(result);
  }
  await assertCatalogState(db, catalog.metadata.last_sync);
  return {
    ...envelope('search_benchmark', catalog, { category: category ?? null, suite:suite ?? null, class:queryClass ?? null, active_only: true }),
    fixture_sha256: fixtureHash ?? createHash('sha256').update(JSON.stringify(fixture)).digest('hex'),
    search_implementation_sha256: searchImplementationHash,
    evaluation: { hit_cutoffs: [1,5,10], page_size: 100, rank_scan: 'until_first_relevant_or_exhausted', invalid_fixture_policy: 'excluded_from_scores', missing_product_policy: 'zero_score', precision_denominator:'K (unfilled slots are nonrelevant)', precision_aggregation:'macro average over explicit acceptable cases' },
    summary: benchmarkMetrics(results),
    by_category: Object.fromEntries(categories.filter(c => results.some(r => r.category === c)).map(c => [c, benchmarkMetrics(results.filter(r => r.category === c))])),
    by_class: Object.fromEntries([...new Set(results.map(r => r.class))].map(c => [c,benchmarkMetrics(results.filter(r => r.class === c))])),
    by_suite: Object.fromEntries(querySuites.filter(s => results.some(r => r.suite === s)).map(s => [s,benchmarkMetrics(results.filter(r => r.suite === s))])),
    new_suite: benchmarkMetrics(results.filter(r => r.suite !== 'regression')),
    results,
  };
}
