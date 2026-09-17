// Paired local compiler A/B: same snapshot, same original inputs, interleaved
// order and three measured samples after warmup. No catalog writes.
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {openDatabase} from '../src/database.js';
import {searchQuery} from '../src/queries.js';
import {quantile} from '../src/quality/ux.js';
const input=JSON.parse(await readFile(process.argv[2]??'.cache/search-failures-before.json','utf8'));
const ref=process.argv[3]??'HEAD';
const commit=execFileSync('git',['rev-parse','--verify',ref],{encoding:'utf8'}).trim();
const original=execFileSync('git',['show',`${commit}:src/queries.js`],{encoding:'utf8'}).replace(/from '(\.\/[^']+)'/g,(_,file)=>`from '${new URL(file,new URL('../src/queries.js',import.meta.url)).href}'`);
const {searchQuery:beforeQuery}=await import(`data:text/javascript;base64,${Buffer.from(original).toString('base64')}`);
const db=await openDatabase(false);
try {
  const sync=(await db.query("SELECT id,source_commit FROM sync_runs WHERE status='complete' ORDER BY started_at DESC LIMIT 1")).results[0];
  if(sync.id!==input.catalog.last_sync.id||sync.source_commit!==input.catalog.last_sync.source_commit)throw Error('Baseline snapshot differs');
  const results=[];
  for(const r of input.results) {
    const options={...r.search,...(r.query?{keyword:r.query}:{}),limit:51,cursorPage:true};
    const queries={before:beforeQuery(r.category,options),after:searchQuery(r.category,options)},samples={before:[],after:[]};
    for(let round=0;round<4;round++)for(const phase of round%2?['after','before']:['before','after']) {
      const q=queries[phase],response=await db.query(q.sql,q.params);
      if(round)samples[phase].push({rows_read:response.meta.rows_read,sql_duration_ms:response.meta.duration});
    }
    results.push({id:r.id,intent:r.intent,...Object.fromEntries(Object.entries(samples).map(([phase,rows])=>[phase,{rows_read:quantile(rows.map(r=>r.rows_read),.5),sql_duration_ms:quantile(rows.map(r=>r.sql_duration_ms),.5)}]))});
  }
  const cost=rows=>Object.fromEntries(['rows_read','sql_duration_ms'].map(k=>[k,{median:quantile(rows.map(r=>r[k]),.5),p95:quantile(rows.map(r=>r[k]),.95)}]));
  const by_intent=Object.fromEntries([...new Set(results.map(r=>r.intent))].map(intent=>{const rows=results.filter(r=>r.intent===intent);return [intent,{count:rows.length,before:cost(rows.map(r=>r.before)),after:cost(rows.map(r=>r.after))}];}));
  const report={environment:'local_d1',baseline_commit:commit,source_snapshot:sync,measured_at:new Date().toISOString(),samples_per_case:3,semantics:'first UI page, interleaved A/B after warmup, per-case medians',by_intent,results};
  await writeFile('.cache/search-compiler-ab.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({by_intent,increased_rows:results.filter(r=>r.after.rows_read>r.before.rows_read),duration_increase_over_5ms:results.filter(r=>r.after.sql_duration_ms-r.before.sql_duration_ms>5)},null,2));
}finally{await db.close();}
