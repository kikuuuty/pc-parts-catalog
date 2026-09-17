import { loadQualityCatalog } from '../../src/quality/catalog.js';
import { loadSnapshot } from '../../src/upstream.js';
import { loadUXFixture,sourceCatalog,evaluateUX,qualityFailures } from '../../src/quality/ux.js';
import { diagnoseResult } from '../../src/quality/diagnostics.js';
import { failureDecisions } from './failure-report.js';

export function createCaseDiagnostics(db) {
  let context;
  const load=()=>context??=(async()=>{
    const catalog=await loadQualityCatalog(db),source=sourceCatalog(await loadSnapshot(),catalog);
    return {catalog,source,...await loadUXFixture()};
  })().catch(error=>{context=undefined;throw error;});
  return async id=>{
    if(id===undefined)return (await loadUXFixture()).fixture.map(r=>({id:r.id,intent:r.intent,category:r.category,query:r.query}));
    const {catalog,source,fixture}=await load(),item=fixture.find(r=>r.id===id);
    if(!item)return null;
    const report=await evaluateUX(db,catalog,[item],{source,operations:false});
    return {...await diagnoseResult(db,source,report.results[0]),...((await failureDecisions())[id]??{}),failures:qualityFailures(report).filter(f=>f.startsWith(`${id}:`)),
      source_snapshot_commit:source.source_snapshot_commit,cost_scope:'first UI page; diagnostic SELECT/EXPLAIN excluded'};
  };
}
