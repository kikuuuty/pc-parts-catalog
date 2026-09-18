import { readFile, writeFile } from 'node:fs/promises';
import { performanceIntents, qualityFailures } from '../src/quality/ux.js';
const reports=await Promise.all(['.cache/search-ux.json','.cache/transition-ux-remote-1.json','.cache/transition-ux-remote-2.json'].map(async f=>JSON.parse(await readFile(f,'utf8'))));
const result=performanceIntents.map(intent=>({intent,runs:reports.map(report=>{
  const rows=[...report.results,...report.operation_results].filter(r=>r.intent===intent);
  return {...report.by_intent[intent],max_rows:Math.max(...rows.map(r=>r.rows_read)),max_sql:Math.max(...rows.map(r=>r.sql_duration_ms)),max_page_rows:Math.max(...rows.map(r=>r.max_page_rows_read??r.rows_read)),max_page_sql:Math.max(...rows.map(r=>r.max_page_sql_duration_ms??r.sql_duration_ms))};
})}));
console.log(JSON.stringify(result.map(({intent,runs})=>({intent,runs:runs.map(r=>({count:r.count,rows:r.rows_read,sql:r.sql_duration_ms,max_rows:r.max_rows,max_sql:r.max_sql,max_page_rows:r.max_page_rows,max_page_sql:r.max_page_sql}))})),null,2));
if(process.argv.includes('--budgets')) {
  const budgets=JSON.parse(await readFile('docs/production-performance-budgets.json','utf8'));
  console.log(JSON.stringify({budget_failures:reports.slice(1).map(r=>qualityFailures(r,{budgets}))}));
}
console.log(JSON.stringify({representative_identifiers:reports[2].results.filter(r=>r.intent==='identifier').slice(0,2).map(r=>r.id)}));
await writeFile('.cache/transition-measurement-summary.json',JSON.stringify(result,null,2)+'\n');
