import { writeFile,readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { openDatabase } from '../src/database.js';
import { loadQualityCatalog } from '../src/quality/catalog.js';
import { loadUXFixture,evaluateUX,qualityFailures,sourceCatalog } from '../src/quality/ux.js';
import { planForSync, publishedSnapshot } from '../src/application-plan.js';
import { publicationCases, assertPublicationCoverage } from '../src/quality/publication-cases.js';
const {values:args}=parseArgs({options:{remote:{type:'boolean',default:false},output:{type:'string'},budgets:{type:'string'}}});
const budgets=args.budgets?JSON.parse(await readFile(args.budgets,'utf8')):{};
const db=await openDatabase(args.remote);
try {
  const catalog=await loadQualityCatalog(db),{fixture:requested,hash}=await loadUXFixture();
  const snapshot=publishedSnapshot(await planForSync(catalog.metadata.last_sync));
  if(snapshot.commit!==catalog.metadata.last_sync?.source_commit)throw new Error('Snapshot differs');
  const {fixture,coverage}=publicationCases(requested,snapshot);assertPublicationCoverage(coverage,requested);
  const report=await evaluateUX(db,catalog,fixture,{fixtureHash:hash,source:sourceCatalog(snapshot,catalog)});
  report.evaluation_coverage=coverage;
   report.measurement={environment:args.remote?'remote_d1':'local_d1',measured_at:new Date().toISOString(),budgets};
   report.release_failures=qualityFailures(report,{budgets});
   await writeFile(args.output??`.cache/search-ux${args.remote?'-remote':''}.json`,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({by_intent:report.by_intent,release_failures:report.release_failures},null,2));
}finally{await db.close();}
