import { readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { summarizeUX,qualityFailures } from '../src/quality/ux.js';
import { assertGolden } from './lib/release-gates.js';
const {directory}=JSON.parse(await readFile('.cache/category-release-latest.json','utf8'));
const load=async name=>JSON.parse(await readFile(path.join(directory,name+'.json'),'utf8'));
const quality=await load('quality'),plans=await load('plans'),details=await load('detail-api');
let releaseGate='pass';
try {assertGolden(quality);}catch {releaseGate='blocked';}
const report={release_gate:releaseGate,snapshot:quality.catalog.last_sync.source_commit,migration:await load('migration'),integrity:await load('integrity'),
  storage:Object.fromEntries(Object.entries(await load('storage')).filter(([k])=>!['non_fts_tables','fts_documents'].includes(k))),
  by_intent:quality.by_intent,
  lookup:summarizeUX(quality.results.filter(r=>r.intent==='lookup')),
  exact_models:summarizeUX(quality.results.filter(r=>r.class==='exact_model')),
  ui:quality.results.filter(r=>r.id.startsWith('ux-')).map(r=>({id:r.id,relevant_count:r.relevant_count,returned:r.returned,
    recall_at_20:r.recall_at_20,precision_at_20:r.precision_at_20,recall:r.recall,precision:r.precision,rows_read:r.rows_read,
    sql_duration_ms:r.sql_duration_ms,exact_set_equality:r.exact_set_equality,pagination_correctness:r.pagination_correctness})),
  quality_failures:qualityFailures(quality),human_review:'optional; never a release gate',
  plans:{count:plans.length,passed:plans.filter(p=>p.index_check).length,full_scans:plans.filter(p=>p.catalog_full_scan).length},
  detail:{categories:details.length,plans:(await load('detail-plans')).length,
    miss_rows_read:summarizeUX(details.map(p=>({...p.miss,intent:'detail',sql_duration_ms:p.miss.sql_duration_ms}))).rows_read,
    hit_queries:details.reduce((n,p)=>n+p.hit.d1_queries,0)},
  sync_noop:await load('sync-noop'),sync_refresh:await load('sync-refresh'),sync_recovery:await load('sync-recovery')};
await writeFile(path.join(directory,'summary.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,integrity:{...report.integrity,counts:undefined},sync_noop:{...report.sync_noop,integrity:undefined},sync_refresh:{...report.sync_refresh,integrity:undefined}},null,2));
