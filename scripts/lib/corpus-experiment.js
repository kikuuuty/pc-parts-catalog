// Local experiment only. No production registry, SQL or API option is changed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { models } from '../../src/model.js';
import { searchQuery, hasCatalogFullScan, representativeQueries } from '../../src/queries.js';
import { benchmarkMetrics } from '../../src/quality/benchmark.js';

export const categoryIndexes = Object.fromEntries(Object.keys(models).map(c => [c, `${c}_fts`]));
export const hash = value => createHash('sha256').update(value).digest('hex');
export const normalFormula = 'tier + spec_score + manufacturer_score + freshness_score + relevance/(1+relevance) - fallback*1000';
export function experimentQuery(corpus = 'baseline', mode = 'normal') {
  assert(['baseline','category'].includes(corpus));
  assert(['normal','without_bm25','bm25_only'].includes(mode));
  return (category, options) => {
    const query = searchQuery(category, options);
    if (corpus === 'category') query.sql = query.sql.replaceAll(models[category].searchIndex, categoryIndexes[category]);
    if (options.keyword !== undefined && mode !== 'normal') {
      assert.equal(query.sql.split(normalFormula).length, 2, 'Ranking formula changed: review diagnostic adapter');
      query.sql = query.sql.replace(normalFormula, mode === 'without_bm25'
        ? 'tier + spec_score + manufacturer_score + freshness_score - fallback*1000' : 'relevance');
    }
    return query;
  };
}

// The common ingest trigger is retained verbatim except for its bounded old FTS
// block. Small category hooks run at the existing ordered staging-delete boundary,
// after typed specs exist. No reliance on sibling trigger execution order.
export function categoryMigration(ingestSQL) {
  const start = ingestSQL.indexOf('  DELETE FROM product_fts WHERE');
  const end = ingestSQL.indexOf('  DELETE FROM cpu WHERE', start);
  assert(start > 0 && end > start, 'Unrecognized ingest trigger; review generator');
  const common = ingestSQL.slice(0,start) + ingestSQL.slice(end);
  assert(!/\b(?:extended_product_fts|product_fts)\b/.test(common));
  const statements = ['DROP TRIGGER ingest_search_fields', 'DROP TRIGGER ingest_product', common];
  for (const [c, index] of Object.entries(categoryIndexes)) {
    assert(/^[a-z_]+$/.test(c));
    statements.push(`CREATE VIRTUAL TABLE ${index} USING fts5(text,name,manufacturer,series,variant,family,tokenize='unicode61',prefix='2 3 4')`);
    statements.push(`INSERT INTO ${index}(rowid,text,name,manufacturer,series,variant,family)
      SELECT f.rowid,f.text,f.name,f.manufacturer,f.series,f.variant,f.family FROM ${models[c].searchIndex} f JOIN products p ON p.id=f.rowid WHERE p.category='${c}' AND p.active=1`);
    statements.push(`CREATE TRIGGER experiment_${c}_ingest BEFORE DELETE ON ingest
      WHEN json_extract(old.payload,'$.product.category')='${c}' BEGIN
      DELETE FROM ${index} WHERE rowid=(SELECT id FROM products WHERE source='buildcores' AND upstream_key=json_extract(old.payload,'$.product.upstream_key'));
      INSERT INTO ${index}(rowid,text,name,manufacturer,series,variant,family)
        SELECT v.product_id,json_extract(old.payload,'$.search_text'),v.name,v.manufacturer,v.series,v.variant,v.family
        FROM product_search_projection v JOIN products p ON p.id=v.product_id
        WHERE p.source='buildcores' AND p.upstream_key=json_extract(old.payload,'$.product.upstream_key') AND p.active=1;
      END`);
    statements.push(`CREATE TRIGGER experiment_${c}_move BEFORE UPDATE OF category,active ON products
      WHEN old.category='${c}' AND (new.category<>old.category OR new.active=0) BEGIN
      DELETE FROM ${index} WHERE rowid=old.id; END`);
    statements.push(`CREATE TRIGGER experiment_${c}_delete BEFORE DELETE ON products WHEN old.category='${c}' BEGIN
      DELETE FROM ${index} WHERE rowid=old.id; END`);
  }
  statements.push('DROP TABLE product_fts', 'DROP TABLE extended_product_fts');
  const sql = '-- EXPERIMENT ONLY; generated from the registry and effective ingest schema.\n' + statements.map(s => s.replace(/;\s*$/, '')+';').join('\n')+'\n';
  return { statements, sql, metrics: { migration_bytes: Buffer.byteLength(sql), max_statement_bytes: Math.max(...statements.map(s => Buffer.byteLength(s+';'))),
    max_create_trigger_bytes: Math.max(...statements.filter(s => /^CREATE TRIGGER/.test(s)).map(s => Buffer.byteLength(s+';'))), statement_count: statements.length } };
}

export async function integrity(db, corpus) {
  const indexes = corpus === 'category' ? Object.values(categoryIndexes) : ['product_fts','extended_product_fts'];
  // D1 limits compound SELECT terms more strictly than desktop SQLite. Scan each
  // index with bounded rowid pages instead of a 30-way UNION used only by audits.
  const products=new Map(),orphans=[];
  let cursor=0;
  while (true) {
    const rows=(await db.query('SELECT id,upstream_key,category,active FROM products WHERE id>? ORDER BY id LIMIT 500',[cursor])).results;
    if (!rows.length) break;
    for (const row of rows) products.set(row.id,{...row,documents:0,correct:0});
    cursor=rows.at(-1).id;
  }
  for (const index of indexes) {
    cursor=0;
    while (true) {
      const rows=(await db.query(`SELECT rowid AS id FROM ${index} WHERE rowid>? ORDER BY rowid LIMIT 500`,[cursor])).results;
      if (!rows.length) break;
      for (const row of rows) {
        const p=products.get(row.id);
        if (!p || p.active!==1) orphans.push({...row,corpus:index});
        if (p) {p.documents++;if (index===(corpus==='category' ? categoryIndexes[p.category] : models[p.category].searchIndex)) p.correct++;}
      }
      cursor=rows.at(-1).id;
    }
  }
  const active=[...products.values()].filter(p => p.active===1),violations=active.filter(p => p.documents!==1 || p.correct!==1);
  return { active_products:active.length, violations, orphans, pass: !violations.length && !orphans.length };
}

export const quantile = (values, q) => values.length ? [...values].sort((a,b) => a-b)[Math.max(0, Math.ceil(values.length*q)-1)] : null;
const mean = xs => xs.length ? xs.reduce((a,b) => a+b,0)/xs.length : null;
export function aggregate(results) {
  const summarize = rs => ({ ...benchmarkMetrics(rs), rank_regression_count: rs.filter(r => r.comparison?.regressed).length,
    rows_read_median: quantile(rs.map(r => r.rows_read), .5), rows_read_p95: quantile(rs.map(r => r.rows_read), .95),
    sql_duration_median_ms: quantile(rs.map(r => r.sql_duration_ms), .5), sql_duration_p95_ms: quantile(rs.map(r => r.sql_duration_ms), .95),
    bm25: { improved: rs.filter(r => r.bm25?.effect === 'improved').length, degraded: rs.filter(r => r.bm25?.effect === 'degraded').length, unchanged: rs.filter(r => r.bm25?.effect === 'unchanged').length,
      mean_rank_delta: mean(rs.map(r => r.bm25?.delta).filter(Number.isFinite)),
      worst_regression: rs.filter(r => r.bm25?.delta > 0).sort((a,b) => b.bm25.delta-a.bm25.delta).slice(0,1).map(r => ({id:r.id,...r.bm25})),
      best_improvement: rs.filter(r => r.bm25?.delta < 0).sort((a,b) => a.bm25.delta-b.bm25.delta).slice(0,1).map(r => ({id:r.id,...r.bm25})) } });
  const group = field => Object.fromEntries([...new Set(results.map(r => r[field]))].map(key => [key, summarize(results.filter(r => r[field] === key))]));
  return { overall: summarize(results), by_category: group('category'), by_query_class: group('class'), by_suite: group('suite') };
}
// Missing ranks are never silently equal to a finite cutoff. Numeric deltas are
// null for censored ranks; transitions to/from missing are separately classified.
export function rankChange(before, after) {
  return { delta: before !== null && after !== null ? after-before : null,
    regressed: before !== null && (after === null || after > before), improved: after !== null && (before === null || after < before) };
}
export function compareRuns(a, b) {
  assert.equal(a.fixture_sha256,b.fixture_sha256);
  assert.equal(a.results.length,b.results.length);
  const results = b.results.map(r => {
    const old = a.results.find(x => x.id === r.id); assert(old);
    assert.deepEqual([old.category,old.query,old.expected,old.search_options],[r.category,r.query,r.expected,r.search_options]);
    const overlap = Object.fromEntries([5,10,20].map(k => {
      const left = old.top_results.slice(0,k).map(p => p.upstream_key), right = r.top_results.slice(0,k).map(p => p.upstream_key);
      const intersection = left.filter(id => right.includes(id)).length;
      return [k, { intersection, jaccard: new Set([...left,...right]).size ? intersection/new Set([...left,...right]).size : 1 }];
    }));
    return {...r, comparison: { baseline_rank:old.rank, ...rankChange(old.rank,r.rank), overlap,
      dropped_cutoffs: [1,5,10].filter(k => old.rank !== null && old.rank<=k && (r.rank===null || r.rank>k)),
      top20_rank_changes: r.top_results.map(p => ({upstream_key:p.upstream_key, baseline_rank:old.top_results.find(x => x.upstream_key===p.upstream_key)?.rank ?? null, new_rank:p.rank})) }};
  });
  const regressions = results.filter(r => r.comparison.regressed).map(r => ({id:r.id,category:r.category,query:r.query,baseline_rank:r.comparison.baseline_rank,new_rank:r.rank,...r.comparison}));
  const legacy = results.filter(r => r.suite !== 'extended');
  const top10Changes = legacy.filter(r => r.comparison.overlap[10].jaccard !== 1).map(r => r.id);
  return { rank_delta_definition:'new_rank - baseline_rank; positive = worse; missing transitions classified separately',
    mean_rank_delta:mean(results.map(r => r.comparison.delta).filter(Number.isFinite)), regressions,
    worst_rank_regression:regressions.sort((x,y) => (y.delta ?? Infinity)-(x.delta ?? Infinity))[0] ?? null,
    dropped_top1:regressions.filter(r => r.dropped_cutoffs.includes(1)), dropped_top5:regressions.filter(r => r.dropped_cutoffs.includes(5)), dropped_top10:regressions.filter(r => r.dropped_cutoffs.includes(10)),
    overlap:Object.fromEntries([5,10,20].map(k => [k,{mean_intersection:mean(results.map(r => r.comparison.overlap[k].intersection)),mean_jaccard:mean(results.map(r => r.comparison.overlap[k].jaccard))}])),
    legacy_acceptance:{ hit_120:legacy.length===120 && legacy.every(r => r.status==='HIT'), no_rank_regressions:legacy.every(r => !r.comparison.regressed),
      precision_floor:benchmarkMetrics(legacy).precision_at_5 >= 216/220-1e-12 && benchmarkMetrics(legacy).precision_at_10 >= 434/440-1e-12,
      no_new_zero_results:legacy.every(r => !r.zero_results || a.results.find(x => x.id===r.id).zero_results), top10_changes_requiring_review:top10Changes },
    ...aggregate(results), results };
}

export async function queryPlans(db, corpus) {
  const build = experimentQuery(corpus);
  const reports = [];
  for (const q of representativeQueries) {
    const {sql,params} = build(q.category,q.options);
    const details = (await db.query(`EXPLAIN QUERY PLAN ${sql}`,params)).results.map(r => r.detail);
    reports.push({name:q.name,details,catalog_full_scan:hasCatalogFullScan(details),temp_b_tree:details.filter(d => d.includes('TEMP B-TREE')),
      pass:!hasCatalogFullScan(details) && q.indexes.every(i => details.some(d => d.includes(i))) });
  }
  return reports;
}
