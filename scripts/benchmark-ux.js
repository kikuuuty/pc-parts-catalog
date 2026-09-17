import { writeFile,readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { openDatabase } from '../src/database.js';
import { loadQualityCatalog } from '../src/quality/catalog.js';
import { loadUXFixture,evaluateUX,qualityFailures,sourceCatalog } from '../src/quality/ux.js';
import { loadSnapshot } from '../src/upstream.js';
const {values:args}=parseArgs({options:{remote:{type:'boolean',default:false},output:{type:'string'},budgets:{type:'string'}}});
const budgets=args.budgets?JSON.parse(await readFile(args.budgets,'utf8')):{};
const db=await openDatabase(args.remote);
try {
  const catalog=await loadQualityCatalog(db),{fixture,hash}=await loadUXFixture();
  const snapshot=await loadSnapshot();
  if(snapshot.commit!==catalog.metadata.last_sync?.source_commit)throw new Error('Snapshot differs');
  const report=await evaluateUX(db,catalog,fixture,{fixtureHash:hash,source:sourceCatalog(snapshot,catalog)});
   report.measurement={environment:args.remote?'remote_d1':'local_d1',measured_at:new Date().toISOString(),budgets};
   report.release_failures=qualityFailures(report,{budgets});
   await writeFile(args.output??`.cache/search-ux${args.remote?'-remote':''}.json`,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({by_intent:report.by_intent,release_failures:report.release_failures},null,2));
}finally{await db.close();}
