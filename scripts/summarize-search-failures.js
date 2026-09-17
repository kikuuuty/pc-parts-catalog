import {readFile} from 'node:fs/promises';
const r=JSON.parse(await readFile(process.argv[2]??'.cache/search-failures-before.json','utf8'));
console.table((r.diagnostics??r.results.filter(x=>r.release_failures.some(f=>f.startsWith(x.id+':')))).map(x=>({id:x.id,intent:x.intent,query:x.query,relevant:x.relevant_count,returned:x.returned,fp:x.false_positive_count,fn:x.false_negative_count,coverage:x.relevant_coverage,precision:x.precision,rank:x.rank,rows:x.rows_read,ms:x.sql_duration_ms})));
for(const x of (r.diagnostics??[]).filter(x=>process.argv[3]===x.id)) {
  console.log(x.id,JSON.stringify({selector:x.relevant,search:x.search,fp:x.false_positives.map(p=>p.name),top:x.intent==='lookup'?x.top_results:undefined}));
}
