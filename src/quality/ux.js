import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { models } from '../model.js';
import { searchQuery, hasCatalogFullScan } from '../queries.js';
import { resolveExpected } from './benchmark.js';
import { loadSearchFixture } from './fixtures.js';
import { assertCatalogState } from './catalog.js';
import { searchWindow, cursorContext, encodeCursor, decodeCursor } from '../pagination.js';
import { identifierKey } from '../normalize.js';
import { loadProductDetail } from '../product-detail.js';
import { resolveProducts } from '../product-reference.js';

export const intents = ['lookup','identifier','browse','browse_filter','filter_only'];
export const performanceIntents = [...intents,'product_detail','product_resolve'];
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
  const ids = new Map(catalog.products.map(p => [`${p.source}/${p.upstream_key}`,p.id]));
  return { ...catalog, source_snapshot_commit:snapshot.commit, products: snapshot.records.map(r => ({ ...r.product, id: ids.get(`buildcores/${r.product.upstream_key}`) ?? `missing:${r.product.upstream_key}`, active:1,
    source:'buildcores', spec:r.spec, identifiers:r.identifiers, facets:r.facets })) };
}

export async function loadUXFixture() {
  const legacy = await loadSearchFixture(), extended = await loadSearchFixture('test/fixtures/search-extended.json');
  const { fixture: added } = await loadSearchFixture('test/fixtures/search-ux.json');
  const overrides=JSON.parse(await readFile('test/fixtures/search-ux-overrides.json','utf8'));
  const inputs=[...legacy.fixture,...extended.fixture,...added].map(item=>({...item,...overrides[item.id]}));
  const hashes=new Map(inputs.map(item=>[item.id,createHash('sha256').update(JSON.stringify(item)).digest('hex')]));
  const fixture = inputs.map(item => {
    const intent = classifyIntent(item);
    const relevant = ['browse','browse_filter'].includes(intent)
      ? item.relevant ?? item.acceptable ?? (item.expected?.set ? item.expected : { set: { nameTokens: item.query.match(/[\p{L}\p{N}]+/gu) } }) : undefined;
    return { ...item, intent, relevant, fixture_sha256:hashes.get(item.id) };
  });
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
  return { count:results.length,
    zero_result_rate:results.length ? results.filter(r=>r.zero_results).length/results.length : null,
    ...Object.fromEntries([1,3,5].map(k=>[`hit_at_${k}`,ranked.length ? ranked.filter(r=>r.rank!==null && r.rank<=k).length/ranked.length : null])),
    mrr:ranked.length ? ranked.reduce((n,r)=>n+(r.rank ? 1/r.rank : 0),0)/ranked.length : null,
    ...Object.fromEntries(['recall_at_10','recall_at_20','precision_at_10','precision_at_20','recall','precision','relevant_coverage'].map(k=>[k,mean(k)])),
    false_positive_count:results.reduce((n,r)=>n+(r.false_positive_count??0),0),
    false_negative_count:results.reduce((n,r)=>n+(r.false_negative_count??0),0),
    invalid_filter_products:results.reduce((n,r)=>n+(r.invalid_filter_products??0),0),
    rows_read:cost('rows_read'),sql_duration_ms:cost('sql_duration_ms'),query_count:cost('query_count'),total_query_count:results.reduce((n,r)=>n+(r.query_count??0),0),
    window_exhausted_count:results.filter(r=>r.window_exhausted).length,
    catalog_full_scan_count:results.filter(r=>r.catalog_full_scan).length,
    temp_b_tree_count:results.filter(r=>r.temp_b_tree?.length).length };
}

export async function evaluateUX(db, catalog, fixture, { fixtureHash = null, source } = {}) {
  if(!source?.source_snapshot_commit||source.source_snapshot_commit!==catalog.metadata.last_sync?.source_commit)throw Error('Independent source snapshot matching the catalog is required');
  if (!fixture.length || fixture.some(r=>typeof r.id!=='string'||!r.id.trim()) || new Set(fixture.map(r=>r.id)).size!==fixture.length) throw new Error('Fixture IDs must be unique and nonempty');
  const results = [];
  const sourceById = new Map(source.products.map(p=>[p.id,p]));
  for (const item of fixture) {
    const intent = classifyIntent(item), setIntent = !['lookup','identifier'].includes(intent);
    if (!intents.includes(intent)) throw new Error(`Unknown intent: ${intent}`);
    let targets;
    if (intent==='identifier') {
      const identifier=item.search?.identifier??{value:item.query};
      targets=source.products.filter(p=>p.category===item.category && p.active===1 && p.identifiers.some(i=>(!identifier.type||i.type===identifier.type)&&identifierKey(i.value)===identifierKey(identifier.value)));
    } else if (intent==='filter_only') targets = source.products.filter(p=>p.category===item.category && p.active===1 && matchesFilters(p,item.search));
    else {
      const selector = setIntent ? item.relevant : item.equivalents ?? item.expected;
      const resolution = resolveExpected(source,item.category,selector);
      if (resolution.status === 'EXPECTED_DATA_INVALID') throw new Error(`${item.id}: ${resolution.reason}`);
      targets = resolution.products.filter(p=>p.active===1 && (!setIntent || matchesFilters(p,item.search)));
    }
    const targetIds = new Set(targets.map(p=>p.id)), ids = [], costs=[],sortValues=[];
    const options = { ...item.search, ...(item.query ? {keyword:item.query} : {}), limit:51,cursorPage:true };
    const query = searchQuery(item.category,options);
    const window = searchWindow(options);
    const context=await cursorContext({category:item.category,...options},catalog.metadata.last_sync?.id??'unversioned');
    const plan = (await db.query(`EXPLAIN QUERY PLAN ${query.sql}`,query.params)).results.map(r=>r.detail);
    let exhausted = false, cursor;
    // UI window, not an unbounded rank hunt. Cost records first page separately.
    for (let offset=0;window===null||offset<window;offset+=50) {
      const q=window===null?searchQuery(item.category,{...options,after:cursor?await decodeCursor(cursor,context):undefined}):{sql:`${query.sql} OFFSET ?`,params:[...query.params,offset]};
      const response = await db.query(q.sql,q.params);
      const page=response.results.slice(0,50);
      ids.push(...page.map(p=>p.id)); costs.push(response.meta ?? {});
      if(window===null)sortValues.push(...page.map(p=>JSON.parse(p._cursor_values)));
      exhausted = response.results.length<=50;
      if(window===null&&page.length) {
        cursor=await encodeCursor(context,JSON.parse(page.at(-1)._cursor_values));
        if(offset===0&&!exhausted) {
          const seek=searchQuery(item.category,{...options,after:await decodeCursor(cursor,context)});
          plan.push(...(await db.query(`EXPLAIN QUERY PLAN ${seek.sql}`,seek.params)).results.map(r=>r.detail));
        }
      }
      if (exhausted || !setIntent && ids.some(id=>targetIds.has(id))) break;
    }
    const rank = ids.findIndex(id=>targetIds.has(id));
    const r = { id:item.id,fixture_sha256:item.fixture_sha256,category:item.category,intent,class:item.class,
      expected:item.expected,relevant:item.relevant,search:item.search,query:item.query,
      rank:setIntent ? null : rank<0 ? null : rank+1,zero_results:ids.length===0,returned:ids.length,
      window_limit:window,window_exhausted:window!==null && !exhausted && ids.length===window,query_plan:plan,catalog_full_scan:hasCatalogFullScan(plan),
      query_count:1,all_pages_query_count:costs.length,source_grounded:intent==='identifier'?targets.length>0:undefined,
      equivalent_refs:intent==='identifier'?targets.map(p=>({source:p.source,upstream_key:p.upstream_key})):undefined,
      temp_b_tree:plan.filter(p=>p.includes('TEMP B-TREE')),
      rows_read:costs[0]?.rows_read ?? null,sql_duration_ms:costs[0]?.duration ?? null,
      all_pages_rows_read:costs.every(c=>Number.isFinite(c.rows_read)) ? costs.reduce((n,c)=>n+c.rows_read,0) : null,
      all_pages_sql_duration_ms:costs.every(c=>Number.isFinite(c.duration)) ? costs.reduce((n,c)=>n+c.duration,0) : null,
      max_page_rows_read:Math.max(...costs.map(c=>c.rows_read??NaN)),max_page_sql_duration_ms:Math.max(...costs.map(c=>c.duration??NaN)),
      top20:ids.slice(0,20),floors:item.floors };
    if (setIntent) Object.assign(r,setMetrics(ids,targetIds));
    if (['browse_filter','filter_only'].includes(intent)) {
      r.invalid_filter_products = ids.filter(id=>!sourceById.has(id) || !matchesFilters(sourceById.get(id),item.search)).length;
      r.filter_correctness = r.invalid_filter_products===0;
    }
    if (intent==='filter_only') {
      const repeat = await db.query(query.sql,query.params);
      // Different page boundaries detect skipped/duplicated rows as well as ties.
      const alternateIds=[];let after;
      while(true) {
        const alternate=searchQuery(item.category,{...options,limit:37,after});
        const page=await db.query(alternate.sql,alternate.params);
        alternateIds.push(...page.results.map(p=>p.id));
        if(page.results.length<37)break;
        after=await decodeCursor(await encodeCursor(context,JSON.parse(page.results.at(-1)._cursor_values)),context);
      }
      r.pagination_correctness = new Set(ids).size===ids.length &&
        JSON.stringify(ids)===JSON.stringify(alternateIds) &&
        JSON.stringify(ids.slice(0,50))===JSON.stringify(repeat.results.slice(0,50).map(p=>p.id));
      const fold=v=>typeof v==='string'?v.replace(/[A-Z]/g,c=>c.toLowerCase()):v;
      r.stable_ordering=sortValues.every((tuple,i)=>{
        if(!i)return true;const previous=sortValues[i-1];
        for(let j=0;j<tuple.length;j++)if(fold(previous[j])!==fold(tuple[j]))return fold(previous[j])<fold(tuple[j]);
        return false;
      });
    }
    results.push(r);
  }
  const operationResults=await evaluateProductOperations(db,catalog,source);
  await assertCatalogState(db,catalog.metadata.last_sync);
  return { schema_version:4,kind:'ux_search_benchmark',fixture_sha256:fixtureHash,catalog:catalog.metadata,
    display_values:{series_null:source.products.filter(p=>p.series===null).length,series_empty:source.products.filter(p=>p.series==='').length,manufacturer_null:source.products.filter(p=>p.manufacturer===null).length},
    semantics:{keyword_window:1000,filter_pagination:'cursor/keyset, no window',page_size:50,precision_denominator:'returned slots up to K',recall_denominator:'complete independent source relevant set',performance:'first UI page / complete detail or resolve operation; all-page costs separate',human_review:'optional offline diagnostics; never a release gate'},
    summary:summarizeUX(results),by_intent:Object.fromEntries(performanceIntents.map(i=>[i,summarizeUX([...results,...operationResults].filter(r=>r.intent===i))])),results,operation_results:operationResults };
}

export function qualityFailures(report, { budgets = {} } = {}) {
  const failures=[];
  for(const intent of intents) if (!report.results.some(r=>r.intent===intent)) failures.push(`missing intent coverage: ${intent}`);
  if(report.schema_version>=3)for(const intent of ['product_detail','product_resolve'])if(!report.operation_results?.some(r=>r.intent===intent))failures.push(`missing intent coverage: ${intent}`);
  for(const r of [...report.results,...(report.operation_results??[])]) {
    const fail = why => failures.push(`${r.id}: ${why}`);
    if (r.catalog_full_scan) fail('catalog full scan');
    if (!Number.isFinite(r.rows_read) || !Number.isFinite(r.sql_duration_ms)) fail('missing D1 cost metadata');
    if (Object.hasOwn(r,'all_pages_rows_read') && (!Number.isFinite(r.all_pages_rows_read)||!Number.isFinite(r.all_pages_sql_duration_ms))) fail('missing pagination cost metadata');
    const budget=budgets[r.intent]??{};
    if (r.rows_read>(budget.max_rows_read??500000) || r.sql_duration_ms>(budget.max_sql_duration_ms??250)) fail('performance safety ceiling');
    if(r.max_page_rows_read>500000||r.max_page_sql_duration_ms>250)fail('pagination safety ceiling');
    if (r.intent.startsWith('product_')) { if(!r.correctness)fail('product reference/detail correctness');continue; }
    if (['lookup','identifier'].includes(r.intent)) {
      const cutoff = r.intent==='identifier' ? 1 : r.floors?.hit_at ?? (r.class==='exact_model' ? 1 : ['fallback','typo'].includes(r.class) ? 5 : 3);
      if(r.intent==='identifier'&&!r.source_grounded)fail('source identifier mapping missing');
      if(!Number.isSafeInteger(r.rank)||r.rank<1 || r.rank>cutoff) fail(`Hit@${cutoff} floor`);
    } else if(r.intent==='browse') {
      // A full large window is a UI refinement state, not missing-catalog recall.
      const ceiling=r.window_exhausted&&r.relevant_count>r.window_limit?r.window_limit/r.relevant_count:1;
      if(!Number.isFinite(r.relevant_coverage)||r.relevant_coverage < (r.floors?.candidate_coverage??.9)*ceiling) fail('candidate coverage floor');
      if(!Number.isFinite(r.precision)||r.precision < (r.floors?.candidate_precision??.9)) fail('candidate precision floor');
      if(r.zero_results && r.relevant_count) fail('unexpected zero result');
    } else {
      if(!r.filter_correctness || r.false_positive_count || r.false_negative_count) fail('filtered set mismatch');
      if(r.intent==='filter_only' && (!r.exact_set_equality || !r.pagination_correctness || !r.stable_ordering)) fail('pagination/set correctness');
    }
  }
  for(const [intent,budget] of Object.entries(budgets)) {
    if(!performanceIntents.includes(intent)||!budget||typeof budget!=='object'||Object.entries(budget).some(([k,v])=>!['max_rows_read','max_sql_duration_ms','rows_read_p95','sql_duration_ms_p95','max_query_count'].includes(k)||!Number.isFinite(v)||v<=0))throw Error('Invalid intent performance budget');
    const rows=[...report.results,...(report.operation_results??[])].filter(r=>r.intent===intent);
    for(const [metric,key] of [['rows_read','rows_read_p95'],['sql_duration_ms','sql_duration_ms_p95']])if(budget[key]!==undefined&&quantile(rows.map(r=>r[metric]),.95)>budget[key])failures.push(`${intent}: remote ${key} budget`);
    if(budget.max_query_count!==undefined&&rows.some(r=>r.query_count>budget.max_query_count))failures.push(`${intent}: query count budget`);
  }
  return failures;
}

async function evaluateProductOperations(db,catalog,source) {
  const results=[];
  const sample=[...new Set(source.products.map(p=>p.category))].map(c=>source.products.find(p=>p.category===c&&Number.isSafeInteger(p.id)));
  const measure=async(intent,id,operation)=>{
    const costs=[],plans=[];
    const execute=async(sql,params)=>{
      plans.push(...(await db.query(`EXPLAIN QUERY PLAN ${sql}`,params)).results.map(r=>r.detail));
      const response=await db.query(sql,params);costs.push(response.meta??{});return response.results;
    };
    const correctness=await operation(execute);
    const sum=key=>costs.every(c=>Number.isFinite(c[key]))?costs.reduce((n,c)=>n+c[key],0):null;
    results.push({id,intent,correctness,query_count:costs.length,rows_read:sum('rows_read'),sql_duration_ms:sum('duration'),query_plan:plans,catalog_full_scan:hasCatalogFullScan(plans)});
  };
  for(const p of sample.filter(Boolean))await measure('product_detail',`detail-${p.category}`,async execute=>{
    const detail=await loadProductDetail(execute,p.id);
    return detail?.source===p.source&&detail?.upstream_key===p.upstream_key;
  });
  const products=[...sample.filter(Boolean),...catalog.products.filter(p=>p.active===0).slice(0,1)];
  const refs=products.map(p=>({source:p.source,upstream_key:p.upstream_key}));
  if(refs.length) {refs.push(refs[0]);products.push(products[0]);}
  refs.push({source:'unknown',upstream_key:'CPU/missing'});products.push(null);
  for(const size of [1,12,32,64])await measure('product_resolve',`resolve-shared-build-${size}`,async execute=>{
    const input=Array.from({length:size},(_,i)=>refs[i%refs.length]);
    const result=await resolveProducts(execute,input);
    return result.products.length===input.length&&result.products.every((p,i)=>{
      const expected=products[i%refs.length];
      return p.source===input[i].source&&p.upstream_key===input[i].upstream_key&&p.id===(expected?.id??null)&&p.status===(expected?(expected.active===1?'active':'inactive'):'missing');
    });
  });
  return results;
}
