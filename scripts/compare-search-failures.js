import {readFile,writeFile} from 'node:fs/promises';
import {quantile} from '../src/quality/ux.js';
const before=JSON.parse(await readFile(process.argv[2]??'.cache/search-failures-before.json','utf8'));
const evidence=JSON.parse(await readFile(process.argv[3]??'.cache/search-failures-after.json','utf8'));
const after=JSON.parse(await readFile(process.argv[4]??'.cache/search-ux.json','utf8'));
const failureIds=new Set(before.release_failures.map(f=>f.split(':')[0]));
const metric=r=>({intent:r.intent,query:r.query,search:r.search??{},relevant:r.relevant_count,returned:r.returned,coverage:r.relevant_coverage,precision:r.precision,fp:r.false_positive_count,fn:r.false_negative_count,rank:r.rank,rows_read:r.rows_read,sql_duration_ms:r.sql_duration_ms});
const report={snapshot:after.catalog.last_sync.source_commit,before_failures:before.release_failures,after_failures:after.release_failures,
  cases:before.results.filter(r=>failureIds.has(r.id)).map(r=>({id:r.id,classification:before.diagnostics.find(d=>d.id===r.id)?.classification,before:metric(r),after:metric(after.results.find(a=>a.id===r.id))})),
  performance:Object.keys(after.by_intent).map(intent=>({intent,before:{count:before.by_intent[intent].count,rows:before.by_intent[intent].rows_read,ms:before.by_intent[intent].sql_duration_ms},after:{count:after.by_intent[intent].count,rows:after.by_intent[intent].rows_read,ms:after.by_intent[intent].sql_duration_ms}})),
  same_input_performance:['lookup','identifier','browse','browse_filter','filter_only'].map(intent=>{
    const rows=evidence.same_input_performance.filter(r=>r.intent===intent);
    const cost=phase=>Object.fromEntries(['rows_read','sql_duration_ms'].map(field=>[field,{median:quantile(rows.map(r=>r[phase][field]),.5),p95:quantile(rows.map(r=>r[phase][field]),.95)}]));
    return {intent,count:rows.length,before:cost('before'),after:cost('after')};
  }),
  increased_same_input_rows:evidence.same_input_performance.filter(r=>r.after.rows_read>r.before.rows_read),
  windows:after.results.filter(r=>r.window_exhausted).map(r=>({id:r.id,relevant:r.relevant_count,returned:r.returned,coverage:r.relevant_coverage,precision:r.precision,fp:r.false_positive_count,fn:r.false_negative_count})),
  non_window_false_negatives:after.results.filter(r=>r.false_negative_count&&!r.window_exhausted).map(r=>({id:r.id,fn:r.false_negative_count})),
  remaining_false_positives:after.results.filter(r=>r.false_positive_count).map(r=>({id:r.id,fp:r.false_positive_count,precision:r.precision})),
  summary:after.by_intent};
await writeFile('.cache/search-failure-comparison.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,cases:undefined,summary:undefined},null,2));
console.table(report.cases.map(r=>({id:r.id,class:r.classification,intent:r.after.intent,expected:r.after.relevant,returned:r.after.returned,coverage:r.after.coverage,precision:r.after.precision,fp:r.after.fp,fn:r.after.fn,rank:r.after.rank,rows:r.after.rows_read,ms:r.after.sql_duration_ms})));
