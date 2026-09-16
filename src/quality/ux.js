import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { models } from '../model.js';
import { searchQuery, hasCatalogFullScan } from '../queries.js';
import { resolveExpected } from './benchmark.js';
import { loadSearchFixture } from './fixtures.js';
import { assertCatalogState } from './catalog.js';
import { searchWindow } from '../pagination.js';

export const intents = ['lookup','identifier','browse','browse_filter','filter_only'];
export const quantile = (xs, q) => xs.length ? [...xs].sort((a,b) => a-b)[Math.max(0,Math.ceil(xs.length*q)-1)] : null;
const hasFilters = s => ['filters','ranges','facets'].some(k => Object.keys(s?.[k] ?? {}).length);
export function classifyIntent(item) {
  if (item.intent) return item.intent;
  if (item.search?.identifier || item.class === 'identifier') return 'identifier';
  if (!item.query) return 'filter_only';
  if (hasFilters(item.search)) return 'browse_filter';
  return ['family','broad','spec_only','model_spec','typed_spec','facet','range'].includes(item.class) ? 'browse' : 'lookup';
}

// These predicates execute on independently normalized source records, never on
// search results. SQL collation semantics are intentional (exact typed equality).
export function matchesFilters(product, search = {}) {
  const field = key => Object.hasOwn(models[product.category].fields,key) ? product.spec?.[key] : product[key];
  return Object.entries(search.filters ?? {}).every(([k,v]) => (Array.isArray(v) ? v : [v]).includes(field(k))) &&
    Object.entries(search.ranges ?? {}).every(([k,r]) => field(k) != null && (r.min === undefined || field(k)>=r.min) && (r.max === undefined || field(k)<=r.max)) &&
    Object.entries(search.facets ?? {}).every(([k,v]) => product.facets?.some(f => f.attribute===k && (Array.isArray(v) ? v : [v]).includes(f.value)));
}

export function sourceCatalog(snapshot, catalog) {
  const ids = new Map(catalog.products.map(p => [p.upstream_key,p.id]));
  return { ...catalog, products: snapshot.records.map(r => ({ ...r.product, id: ids.get(r.product.upstream_key) ?? `missing:${r.product.upstream_key}`, active:1,
    source:'buildcores', spec:r.spec, identifiers:r.identifiers, facets:r.facets })) };
}

export async function loadUXFixture() {
  const legacy = await loadSearchFixture(), extended = await loadSearchFixture('test/fixtures/search-extended.json');
  const { fixture: added } = await loadSearchFixture('test/fixtures/search-ux.json');
  const reviews=JSON.parse(await readFile('test/fixtures/search-reviews.json','utf8'));
  for(const [id,review] of Object.entries(reviews)) {
    if(!extended.fixture.some(r=>r.id===id)||review.status!=='reviewed'||review.fixture_sha256!==extended.hash||
      typeof review.reviewer!=='string'||!review.reviewer.trim()||typeof review.rationale!=='string'||!review.rationale.trim()) {
      throw new Error(`Invalid or stale human fixture review: ${id}`);
    }
  }
  const fixture = [...legacy.fixture,...extended.fixture].map(item => {
    const intent = classifyIntent(item);
    const relevant = ['browse','browse_filter'].includes(intent)
      ? item.acceptable ?? (item.expected?.set ? item.expected : { set: { nameTokens: item.query.match(/[\p{L}\p{N}]+/gu) } }) : undefined;
    return { ...item, intent, relevant, review: item.suite === 'extended' ? reviews[item.id]?.status ?? 'pending' : 'reviewed' };
  }).concat(added);
  return { fixture, hash:createHash('sha256').update(JSON.stringify(fixture)).digest('hex') };
}

export function setMetrics(ids, relevant) {
  const found = new Set(ids), expected = new Set(relevant);
  const tp = [...found].filter(id => expected.has(id)).length;
  const at = k => { const page = ids.slice(0,k), hit = page.filter(id => expected.has(id)).length;
    return { [`recall_at_${k}`]: expected.size ? hit/expected.size : 1,
      [`precision_at_${k}`]: page.length ? hit/page.length : expected.size ? 0 : 1 }; };
  return { ...at(10), ...at(20), relevant_count:expected.size, recall:expected.size ? tp/expected.size : 1,
    precision:found.size ? tp/found.size : expected.size ? 0 : 1, relevant_coverage:expected.size ? tp/expected.size : 1,
    false_positive_count:found.size-tp, false_negative_count:expected.size-tp,
    exact_set_equality:tp===expected.size && tp===found.size };
}

export function summarizeUX(results) {
  const mean = key => { const xs=results.map(r=>r[key]).filter(Number.isFinite); return xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : null; };
  const cost = field => { const xs=results.map(r=>r[field]).filter(Number.isFinite); return { median:quantile(xs,.5),p95:quantile(xs,.95) }; };
  const ranked = results.filter(r => ['lookup','identifier'].includes(r.intent));
  return { count:results.length, pending_review:results.filter(r=>r.review==='pending').length,
    zero_result_rate:results.length ? results.filter(r=>r.zero_results).length/results.length : null,
    ...Object.fromEntries([1,3,5].map(k=>[`hit_at_${k}`,ranked.length ? ranked.filter(r=>r.rank!==null && r.rank<=k).length/ranked.length : null])),
    mrr:ranked.length ? ranked.reduce((n,r)=>n+(r.rank ? 1/r.rank : 0),0)/ranked.length : null,
    ...Object.fromEntries(['recall_at_10','recall_at_20','precision_at_10','precision_at_20','recall','precision','relevant_coverage'].map(k=>[k,mean(k)])),
    false_positive_count:results.reduce((n,r)=>n+(r.false_positive_count??0),0),
    false_negative_count:results.reduce((n,r)=>n+(r.false_negative_count??0),0),
    invalid_filter_products:results.reduce((n,r)=>n+(r.invalid_filter_products??0),0),
    rows_read:cost('rows_read'),sql_duration_ms:cost('sql_duration_ms'),
    catalog_full_scan_count:results.filter(r=>r.catalog_full_scan).length,
    temp_b_tree_count:results.filter(r=>r.temp_b_tree?.length).length };
}

export async function evaluateUX(db, catalog, fixture, { fixtureHash = null, source = catalog } = {}) {
  if (!fixture.length || fixture.some(r=>typeof r.id!=='string'||!r.id.trim()) || new Set(fixture.map(r=>r.id)).size!==fixture.length) throw new Error('Fixture IDs must be unique and nonempty');
  const results = [];
  const sourceById = new Map(source.products.map(p=>[p.id,p]));
  for (const item of fixture) {
    const intent = classifyIntent(item), setIntent = !['lookup','identifier'].includes(intent);
    if (!intents.includes(intent)) throw new Error(`Unknown intent: ${intent}`);
    let targets;
    if (intent==='filter_only') targets = source.products.filter(p=>p.category===item.category && p.active===1 && matchesFilters(p,item.search));
    else {
      const selector = setIntent ? item.relevant : item.equivalents ?? item.expected;
      const resolution = resolveExpected(source,item.category,selector);
      if (resolution.status === 'EXPECTED_DATA_INVALID') throw new Error(`${item.id}: ${resolution.reason}`);
      targets = resolution.products.filter(p=>p.active===1 && (!setIntent || matchesFilters(p,item.search)));
    }
    const targetIds = new Set(targets.map(p=>p.id)), ids = [], costs=[];
    const options = { ...item.search, ...(item.query ? {keyword:item.query} : {}), limit:50 };
    const query = searchQuery(item.category,options);
    const window = searchWindow(options);
    const plan = (await db.query(`EXPLAIN QUERY PLAN ${query.sql}`,query.params)).results.map(r=>r.detail);
    let exhausted = false;
    // UI window, not an unbounded rank hunt. Cost records first page separately.
    for (let offset=0;offset<window;offset+=50) {
      const response = await db.query(`${query.sql} OFFSET ?`,[...query.params,offset]);
      ids.push(...response.results.map(p=>p.id)); costs.push(response.meta ?? {});
      exhausted = response.results.length<50;
      if (exhausted || !setIntent && ids.some(id=>targetIds.has(id))) break;
    }
    const rank = ids.findIndex(id=>targetIds.has(id));
    const r = { id:item.id,category:item.category,intent,review:item.review??'reviewed',class:item.class,
      expected:item.expected,relevant:item.relevant,search:item.search,query:item.query,
      rank:setIntent ? null : rank<0 ? null : rank+1,zero_results:ids.length===0,returned:ids.length,
      window_limit:window,window_exhausted:!exhausted && ids.length===window,query_plan:plan,catalog_full_scan:hasCatalogFullScan(plan),
      temp_b_tree:plan.filter(p=>p.includes('TEMP B-TREE')),
      rows_read:costs[0]?.rows_read ?? null,sql_duration_ms:costs[0]?.duration ?? null,
      all_pages_rows_read:costs.every(c=>Number.isFinite(c.rows_read)) ? costs.reduce((n,c)=>n+c.rows_read,0) : null,
      all_pages_sql_duration_ms:costs.every(c=>Number.isFinite(c.duration)) ? costs.reduce((n,c)=>n+c.duration,0) : null,
      top20:ids.slice(0,20),floors:item.floors };
    if (setIntent) Object.assign(r,setMetrics(ids,targetIds));
    if (['browse_filter','filter_only'].includes(intent)) {
      r.invalid_filter_products = ids.filter(id=>!sourceById.has(id) || !matchesFilters(sourceById.get(id),item.search)).length;
      r.filter_correctness = r.invalid_filter_products===0;
    }
    if (intent==='filter_only') {
      const repeat = await db.query(query.sql,query.params);
      // Different page boundaries detect skipped/duplicated rows as well as ties.
      const alternate = searchQuery(item.category,{...options,limit:37}), alternateIds=[];
      for(let offset=0;offset<ids.length;offset+=37) {
        const page=await db.query(`${alternate.sql} OFFSET ?`,[...alternate.params,offset]);
        alternateIds.push(...page.results.map(p=>p.id));
      }
      r.pagination_correctness = new Set(ids).size===ids.length &&
        JSON.stringify(ids)===JSON.stringify(alternateIds.slice(0,ids.length)) &&
        JSON.stringify(ids.slice(0,50))===JSON.stringify(repeat.results.map(p=>p.id));
    }
    results.push(r);
  }
  await assertCatalogState(db,catalog.metadata.last_sync);
  return { schema_version:2,kind:'ux_search_benchmark',fixture_sha256:fixtureHash,catalog:catalog.metadata,
    semantics:{keyword_window:1000,filter_window:100000,page_size:50,precision_denominator:'returned slots up to K',recall_denominator:'complete independent source relevant set',performance:'first UI page; all-page costs separate',pending_review:'measured, never auto-relabeled'},
    summary:summarizeUX(results),by_intent:Object.fromEntries(intents.map(i=>[i,summarizeUX(results.filter(r=>r.intent===i))])),results };
}

export function qualityFailures(report, { requireReview = true } = {}) {
  const failures=[];
  for(const intent of intents) if (!report.results.some(r=>r.intent===intent)) failures.push(`missing intent coverage: ${intent}`);
  for(const r of report.results) {
    const fail = why => failures.push(`${r.id}: ${why}`);
    if (r.review==='pending') { if(requireReview) fail('human review pending'); }
    if (r.catalog_full_scan) fail('catalog full scan');
    if (!Number.isFinite(r.rows_read) || !Number.isFinite(r.sql_duration_ms)) fail('missing D1 cost metadata');
    if (r.rows_read>(r.floors?.max_rows_read??500000) || r.sql_duration_ms>(r.floors?.max_sql_duration_ms??250)) fail('performance budget');
    if (r.review==='pending') continue;
    if (['lookup','identifier'].includes(r.intent)) {
      const cutoff = r.intent==='identifier' || r.class==='exact_model' ? 1 : r.class==='fallback' ? 5 : 3;
      if(r.rank===null || r.rank>cutoff) fail(`Hit@${cutoff} floor`);
    } else if(r.intent==='browse') {
      // For N>20, raw Recall@20 cannot exceed 20/N. Gate attainable
      // recall explicitly, not an impossible 95% raw recall over huge series.
      const ceiling=r.relevant_count ? Math.min(20,r.relevant_count)/r.relevant_count : 1;
      if(r.recall_at_20 < (r.floors?.recall_at_20??ceiling*.9)) fail('Recall@20 floor');
      if(r.precision_at_20 < (r.floors?.precision??.9)) fail('Precision@20 floor');
      if(r.zero_results && r.relevant_count) fail('unexpected zero result');
    } else {
      if(!r.filter_correctness || r.false_positive_count || r.false_negative_count) fail('filtered set mismatch');
      if(r.intent==='filter_only' && (!r.exact_set_equality || !r.pagination_correctness)) fail('pagination/set correctness');
    }
  }
  return failures;
}
