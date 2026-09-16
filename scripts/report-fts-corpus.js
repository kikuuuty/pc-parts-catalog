import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadQualityCatalog } from '../src/quality/catalog.js';
import { resolveExpected } from '../src/quality/benchmark.js';
import { aggregate } from './lib/corpus-experiment.js';
import { explainLexicalBm25 } from './lib/bm25-explanation.js';
import { assertGolden } from './lib/release-gates.js';
const {values:args}=parseArgs({options:{directory:{type:'string'},quiet:{type:'boolean'}}});
const root=path.resolve(args.directory ?? JSON.parse(await readFile('.cache/corpus-ab-latest.json','utf8')).directory);
const load=async name=>JSON.parse(await readFile(path.join(root,name),'utf8'));
const [a,b,comparison,schema,cost,manifest,corpusA,corpusB]=await Promise.all(['baseline.json','category.json','comparison.json','schema.json','sync-cost.json','manifest.json','corpus-baseline.json','corpus-category.json'].map(load));
const sqlite=new DatabaseSync(manifest.locations.baseline.sqlitePath,{readOnly:true});
const catalog=await loadQualityCatalog({query:async(sql,params=[])=>({results:sqlite.prepare(sql).all(...params)})});sqlite.close();
const suites={};
const floorGates={};
for (const [name,report] of [['baseline',a],['category',b]]) {
  try {assertGolden({fixture_sha256:manifest.legacy_sha256,results:report.results.filter(r=>r.suite!=='extended')});floorGates[name]={pass:true};}
  catch(e) {floorGates[name]={pass:false,error:e.message};}
}
for (const suite of ['legacy','extended']) {
  const select=rs=>rs.filter(r=>(r.suite==='extended')===(suite==='extended'));
  suites[suite]={baseline:aggregate(select(a.results)),category:aggregate(select(comparison.results))};
}
const changed= comparison.legacy_acceptance.top10_changes_requiring_review.map(id=>{
  const old=a.results.find(r=>r.id===id),now=b.results.find(r=>r.id===id);
  const resolution=resolveExpected(catalog,old.category,old.acceptable ?? old.expected);
  const relevant=new Set(resolution.products.map(p=>p.upstream_key));
  const delta=(left,right)=>left.top_results.slice(0,10).filter(p=>!right.top_results.slice(0,10).some(q=>q.upstream_key===p.upstream_key))
    .map(p=>({upstream_key:p.upstream_key,name:p.name,rank:p.rank,judged_relevant:relevant.has(p.upstream_key),model_score:p.model_score,spec_score:p.spec_score,manufacturer_score:p.manufacturer_score,freshness_score:p.freshness_score}));
  const removed=delta(old,now),added=delta(now,old);
  return {id,query:old.query,baseline_rank:old.rank,new_rank:now.rank,precision_before:old.precision_at_10,precision_after:now.precision_at_10,
    removed,added,assessment:old.acceptable && added.every(p=>p.judged_relevant) && removed.every(p=>p.judged_relevant) ? 'reordering within explicitly judged relevant set' : 'manual relevance review required'};
});
const details=id=>{
  const left=a.results.find(r=>r.id===id),right=b.results.find(r=>r.id===id);
  const stats=(corpus,r)=>{const q=corpus.queries.find(q=>q.id===r.id),s=corpus.statistics[q.index];return {index:q.index,documents:s.documents,average_document_length:s.average_document_length,match_expressions:q.match_expressions,terms:Object.fromEntries(q.tokens.map(t=>[t,s.terms[t]]))};};
  const top=r=>r.top_results.slice(0,10).map(p=>({key:p.upstream_key,name:p.name,rank:p.rank,match:p.search_match,tier:p.model_score,spec:p.spec_score,manufacturer:p.manufacturer_score,freshness:p.freshness_score}));
  return {id,query:left.query,expected:left.resolved_products,baseline:{rank:left.rank,bm25:left.bm25.normal_rank,without_bm25:left.bm25.rank_without_bm25,bm25_only:left.bm25.rank_bm25_only,top10:top(left),corpus:stats(corpusA,left)},
    category:{rank:right.rank,without_bm25:right.bm25.rank_without_bm25,bm25_only:right.bm25.rank_bm25_only,top10:top(right),corpus:stats(corpusB,right)}};
};
const planSummary=report=>({representative_passed:report.representative_plans.filter(p=>p.pass).length,representative_total:report.representative_plans.length,
  representative_failures:report.representative_plans.filter(p=>!p.pass),golden_full_scans:report.results.filter(r=>r.query_plan.catalog_full_scan).map(r=>r.id),golden_temp_b_tree_count:report.results.filter(r=>r.query_plan.temp_b_tree.length).length});
const summary={manifest,suites,existing_legacy_floor_gates:floorGates,performance20:{baseline:a.performance20,category:b.performance20},bm25:{baseline:a.aggregates.overall.bm25,category:b.aggregates.overall.bm25},
  integrity:{baseline:a.integrity,category:b.integrity},schema,cost,plans:{baseline:planSummary(a),category:planSummary(b)},
  ranking:{mean_rank_delta:comparison.mean_rank_delta,regressions:comparison.regressions,worst:comparison.worst_rank_regression,overlap:comparison.overlap,top1_regressions:comparison.dropped_top1.length,top5_regressions:comparison.dropped_top5.length,top10_regressions:comparison.dropped_top10.length},
  legacy_acceptance:comparison.legacy_acceptance,legacy_top10_review:changed,
  extended_non_top1:b.results.filter(r=>r.suite==='extended' && r.rank!==1).map(r=>({id:r.id,query:r.query,class:r.class,baseline_rank:a.results.find(p=>p.id===r.id).rank,new_rank:r.rank,expected:r.resolved_products,top3:r.top_results.slice(0,3)})),
  regression_diagnostics:comparison.regressions.map(r=>details(r.id)),
  bm25_case_diagnostics:['ext-keyboard-01','ext-monitor-01','ext-mouse-03','p2-memory-ddr5-6000'].map(details)};
summary.non_bm25_top20_changes=a.results.filter(r=>JSON.stringify(r.bm25.without_top20.map(p=>p.upstream_key))!==JSON.stringify(b.results.find(p=>p.id===r.id).bm25.without_top20.map(p=>p.upstream_key))).map(r=>r.id);
summary.non_bm25_component_changes=a.results.flatMap(r=>{
  const now=b.results.find(p=>p.id===r.id);
  return r.top_results.flatMap(p=>{
    const q=now.top_results.find(x=>x.upstream_key===p.upstream_key);
    const fields=['model_score','spec_score','manufacturer_score','freshness_score','search_fallback'];
    return q && fields.some(k=>p[k]!==q[k]) ? [{id:r.id,upstream_key:p.upstream_key,fields:fields.filter(k=>p[k]!==q[k])}] : [];
  });
});
const explanation={};
for (const [corpus,report,stats] of [['baseline',a,corpusA],['category',b,corpusB]]) {
  const sqlite=new DatabaseSync(manifest.locations[corpus].sqlitePath,{readOnly:true});
  try {
    const query=stats.queries.find(q=>q.id==='ext-mouse-03');
    explanation[corpus]=explainLexicalBm25(sqlite,query.index,query.match_expressions[0],report.results.find(r=>r.id==='ext-mouse-03').top_results);
  } finally {sqlite.close();}
}
await writeFile(path.join(root,'bm25-explanation.json'),JSON.stringify(explanation,null,2)+'\n');
assert(summary.integrity.baseline.pass && summary.integrity.category.pass);
await writeFile(path.join(root,'summary.json'),JSON.stringify(summary,null,2)+'\n');
await writeFile(path.join(root,'review.json'),JSON.stringify({plans:summary.plans,existing_legacy_floor_gates:floorGates,non_bm25_top20_changes:summary.non_bm25_top20_changes,non_bm25_component_changes:summary.non_bm25_component_changes,legacy_top10_review:changed,regression_diagnostics:summary.regression_diagnostics,
  bm25:Object.fromEntries([['baseline',a],['category',b]].map(([name,report])=>[name,{mean_rank_delta:report.aggregates.overall.bm25.mean_rank_delta,
    changed:report.results.filter(r=>r.bm25.effect!=='unchanged').map(r=>({id:r.id,query:r.query,normal:r.rank,without:r.bm25.rank_without_bm25,only:r.bm25.rank_bm25_only,delta:r.bm25.delta,effect:r.bm25.effect}))}]))},null,2)+'\n');
const fmt=v=>v===null || v===undefined ? 'N/A' : typeof v==='number' ? Number.isInteger(v) ? String(v) : v.toFixed(6) : String(v);
const table=(headers,rows)=>'| '+headers.join(' | ')+' |\n| '+headers.map(()=> '---').join(' | ')+' |\n'+rows.map(row=>'| '+row.map(fmt).join(' | ')+' |').join('\n')+'\n';
let md='# FTS corpus A/B measured results\n\n';
md+=`Snapshot: \`${manifest.snapshot}\`. Local D1/workerd; 222 identical queries, independent cloned DBs. Five paired warm rounds, alternating A/B.\n\n`;
md+='## Golden quality\n\n';
md+=table(['Suite','Metric','2 FTS','30 FTS'],Object.entries(suites).flatMap(([suite,s])=>['query_count','hit_at_1','hit_at_5','hit_at_10','mrr','precision_at_5','precision_at_10','recall_at_10','zero_result_rate'].map(k=>[suite,k,s.baseline.overall[k],s.category.overall[k]])));
md+='\n## Category quality and first-page read cost\n\n';
md+=table(['Category','Queries','A Hit@1','B Hit@1','A MRR','B MRR','A/B zero rate','Regressions','A rows median/p95','B rows median/p95'],Object.keys(a.aggregates.by_category).map(c=>{
  const x=a.aggregates.by_category[c],y=comparison.by_category[c],ap=a.performance20.by_category[c],bp=b.performance20.by_category[c];
  return [c,x.query_count,x.hit_at_1,y.hit_at_1,x.mrr,y.mrr,`${fmt(x.zero_result_rate)}/${fmt(y.zero_result_rate)}`,y.rank_regression_count,`${ap.rows_read_median}/${ap.rows_read_p95}`,`${bp.rows_read_median}/${bp.rows_read_p95}`];
}));
md+='\n## Query class quality\n\n';
md+=table(['Suite','Class','N','A Hit@1','B Hit@1','A MRR','B MRR'],Object.entries(suites).flatMap(([suite,s])=>Object.entries(s.baseline.by_query_class).map(([cls,x])=>[suite,cls,x.query_count,x.hit_at_1,s.category.by_query_class[cls].hit_at_1,x.mrr,s.category.by_query_class[cls].mrr])));
md+='\n## Performance, storage, sync and schema\n\n';
md+=table(['Metric','A','B'],[
  ...['rows_read_median','rows_read_p95','sql_duration_median_ms','sql_duration_p95_ms'].map(k=>[`First-page ${k}`,a.performance20.overall[k],b.performance20.overall[k]]),
  ...['db_size_bytes','fts_related_bytes','raw_bytes','products','identifiers','fts_count','shadow_table_count','sqlite_schema_entries'].map(k=>[k,schema.storage.baseline[k],schema.storage.category[k]]),
  ['Full refresh rows_written',cost.baseline.full_refresh.rows_written,cost.category.full_refresh.rows_written],['Full refresh duration ms',cost.baseline.full_refresh.duration_ms,cost.category.full_refresh.duration_ms],
  ['Full refresh SQL duration ms',cost.baseline.full_refresh.sql_duration_ms,cost.category.full_refresh.sql_duration_ms],
  ['No-change rows_written',cost.baseline.no_change.rows_written,cost.category.no_change.rows_written],['No-change duration ms',cost.baseline.no_change.duration_ms,cost.category.no_change.duration_ms],
  ['Migration bytes (A cumulative; B extra)',schema.baseline_migrations.total_bytes,schema.candidate_migration.migration_bytes],['Max statement bytes',schema.baseline_migrations.max_statement_bytes,schema.candidate_migration.max_statement_bytes],
  ['Max CREATE TRIGGER bytes',schema.storage.baseline.max_create_trigger_bytes,schema.storage.category.max_create_trigger_bytes],
  ['BM25 improved',summary.bm25.baseline.improved,summary.bm25.category.improved],['BM25 degraded',summary.bm25.baseline.degraded,summary.bm25.category.degraded],['BM25 unchanged',summary.bm25.baseline.unchanged,summary.bm25.category.unchanged],
  ['Representative plans passing',summary.plans.baseline.representative_passed,summary.plans.category.representative_passed],['Golden full scans',summary.plans.baseline.golden_full_scans.length,summary.plans.category.golden_full_scans.length]
]);
md+=`\nDB size delta: ${schema.db_size_difference_bytes} bytes (${fmt(schema.db_size_difference_percent)}%). Non-FTS tables and six-field FTS projection hashes identical.\n\n`;
md+='## Ranking changes\n\n'+table(['Query','A rank','B rank','Delta'],comparison.regressions.map(r=>[r.id,r.baseline_rank,r.new_rank,r.delta]));
md+=`\nMean finite rank delta (B - A; positive is worse): ${fmt(comparison.mean_rank_delta)}. Top1/top5/top10 losses: ${comparison.dropped_top1.length}/${comparison.dropped_top5.length}/${comparison.dropped_top10.length}.\n\n`;
md+=table(['K','Mean intersection','Mean Jaccard'],[5,10,20].map(k=>[k,comparison.overlap[k].mean_intersection,comparison.overlap[k].mean_jaccard]));
md+='\n## Legacy top10 membership review\n\n'+table(['Query','A P@10','B P@10','Assessment'],changed.map(r=>[r.id,r.precision_before,r.precision_after,r.assessment]));
md+='\n## Extended non-top1 cases (unchanged expectations)\n\n'+table(['ID','Class','Query','A rank','B rank','B top1'],summary.extended_non_top1.map(r=>[r.id,r.class,r.query,r.baseline_rank,r.new_rank,r.top3[0]?.name]));
md+='\nFull score traces, expected identities, plans, pagination costs, corpus DF/prefix DF and individual top20 positions are in the adjacent JSON reports. SQL durations are local D1 metadata, not remote service latency. Sync cost is one complete update pass, not initial ingestion. No graded judgments: nDCG is not reported.\n';
await writeFile(path.join(root,'report.md'),md);
console.log(args.quiet ? `Report, summary and review saved in ${root}` : md);
