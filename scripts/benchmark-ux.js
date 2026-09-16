import { writeFile } from 'node:fs/promises';
import { openDatabase } from '../src/database.js';
import { loadQualityCatalog } from '../src/quality/catalog.js';
import { loadUXFixture,evaluateUX,qualityFailures,sourceCatalog } from '../src/quality/ux.js';
import { loadSnapshot } from '../src/upstream.js';
const db=await openDatabase(false);
try {
  const catalog=await loadQualityCatalog(db),{fixture,hash}=await loadUXFixture();
  const snapshot=await loadSnapshot();
  if(snapshot.commit!==catalog.metadata.last_sync?.source_commit)throw new Error('Snapshot differs');
  const report=await evaluateUX(db,catalog,fixture,{fixtureHash:hash,source:sourceCatalog(snapshot,catalog)});
  report.release_failures=qualityFailures(report);
  await writeFile('.cache/search-ux.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({by_intent:report.by_intent,release_failures:report.release_failures},null,2));
}finally{await db.close();}
