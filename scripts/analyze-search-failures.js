import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { openDatabase } from '../src/database.js';
import { loadQualityCatalog } from '../src/quality/catalog.js';
import { loadSnapshot } from '../src/upstream.js';
import { loadUXFixture,evaluateUX,qualityFailures,sourceCatalog } from '../src/quality/ux.js';
import { diagnoseResult } from '../src/quality/diagnostics.js';
import { writeFailureReport } from './lib/failure-report.js';
import { searchQuery,hasCatalogFullScan } from '../src/queries.js';

const {values:args}=parseArgs({options:{output:{type:'string',default:'.cache/search-failure-analysis.json'},cases:{type:'string'},input:{type:'string'}}});
if(!args.output.endsWith('.json'))throw Error('--output must end in .json (a sibling .md report is also generated)');
if(args.input) {
  await writeFailureReport(JSON.parse(await readFile(args.input,'utf8')),args.output);
  console.log(`Diagnostic evidence: ${args.output}`);
} else {
console.log('Opening local D1');
const db=await openDatabase(false);
try {
  console.log('Loading source/catalog');
  const catalog=await loadQualityCatalog(db),source=sourceCatalog(await loadSnapshot(),catalog),{fixture,hash}=await loadUXFixture();
  console.log(`Evaluating ${fixture.length} cases`);
  const report=await evaluateUX(db,catalog,fixture,{source,fixtureHash:hash});
  report.release_failures=qualityFailures(report);
  report.measurement={environment:'local_d1',measured_at:new Date().toISOString()};
  const ids=new Set(args.cases?JSON.parse(await readFile(args.cases,'utf8')).release_failures.map(f=>f.split(':')[0]):report.release_failures.map(f=>f.split(':')[0]));
  for(const failure of report.release_failures)ids.add(failure.split(':')[0]);
  report.diagnostics=[];
  for(const r of report.results.filter(r=>ids.has(r.id))) {console.log(`Diagnosing ${r.id}`);report.diagnostics.push(await diagnoseResult(db,source,r));}
  if(args.cases) {
    // Same inputs isolate compiler cost changes from UX fixture reclassification.
    const before=JSON.parse(await readFile(args.cases,'utf8'));report.same_input_performance=[];
    for(const r of before.results) {
      const q=searchQuery(r.category,{...r.search,...(r.query?{keyword:r.query}:{}),limit:51,cursorPage:true});
      const plan=(await db.query(`EXPLAIN QUERY PLAN ${q.sql}`,q.params)).results.map(p=>p.detail);
      const {meta}=await db.query(q.sql,q.params);
      report.same_input_performance.push({id:r.id,intent:r.intent,before:{rows_read:r.rows_read,sql_duration_ms:r.sql_duration_ms},after:{rows_read:meta.rows_read,sql_duration_ms:meta.duration},catalog_full_scan:hasCatalogFullScan(plan)});
    }
  }
  await writeFailureReport(report,args.output);
  console.log(JSON.stringify({failures:report.release_failures,artifact:args.output},null,2));
}finally{await db.close();}
}
