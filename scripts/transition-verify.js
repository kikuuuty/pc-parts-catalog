import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { openDatabase } from '../src/database.js';
import { safeDatabase, searchGate } from './lib/release-gates.js';

const config=JSON.parse(await readFile('wrangler.json','utf8'));
if(!process.argv.includes('--representative')) {
  assert(process.env.CLOUDFLARE_D1_DATABASE_ID,'Full transition benchmark requires explicit isolated DB');
  assert.notEqual(process.env.CLOUDFLARE_D1_DATABASE_ID,config.d1_databases[0].database_id,'Full transition benchmark must precede promotion');
}
const db=safeDatabase(await openDatabase(true));
try {
  const representative=process.argv.includes('--representative');
  const result=await searchGate(db,{representative});
  const report=JSON.parse(await readFile('.cache/release-ux-report.json','utf8'));
  await writeFile(`.cache/transition-ux-${representative?'representative':'remote-2'}.json`,JSON.stringify(report,null,2)+'\n');
  const local=JSON.parse(await readFile('.cache/search-ux.json','utf8'));
  assert.equal(local.fixture_sha256,report.fixture_sha256);
  const differences=[];
  for(const row of [...report.results,...report.operation_results]) {
    const before=[...local.results,...local.operation_results].find(r=>r.id===row.id);
    for(const field of ['rows_read','query_plan','query_count'])if(JSON.stringify(before[field])!==JSON.stringify(row[field]))differences.push({id:row.id,field,local:before[field],remote:row[field]});
  }
  const comparison={source_integrity:report.source_integrity,local_vs_remote_differences:differences,by_intent:report.by_intent,plans:report.plans};
  if(!representative)await writeFile('.cache/transition-comparison.json',JSON.stringify(comparison,null,2)+'\n');
  console.log(JSON.stringify({result,source_integrity:report.source_integrity,differences},null,2));
} finally {await db.close();}
