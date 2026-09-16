// Current compiler phase diagnostics, without saved pre-migration SQL adapters.
import { writeFile } from 'node:fs/promises';
import { openDatabase } from '../src/database.js';
import { searchQuery,hasCatalogFullScan } from '../src/queries.js';
import { searchCTEs,broadQueries,exactQueries } from './lib/broad-workload.js';
const db=await openDatabase(false),report=[];
try {
  for(const item of [...broadQueries,...exactQueries]) {
    const query=searchQuery(item.category,{keyword:item.keyword,limit:20,debug:true}),phases=[];
    for(const phase of ['strict_fts','strict','ranked','scored']) {
      const result=await db.query(`${searchCTEs(query.sql)}SELECT count(*) n FROM ${phase}`,query.params.slice(0,-1));
      phases.push({phase,candidates:result.results[0].n,rows_read:result.meta.rows_read,sql_duration_ms:result.meta.duration});
    }
    const plan=(await db.query(`EXPLAIN QUERY PLAN ${query.sql}`,query.params)).results.map(r=>r.detail);
    const rows=await db.query(query.sql,query.params);
    report.push({...item,phases,plan,catalog_full_scan:hasCatalogFullScan(plan),temp_b_tree:plan.filter(d=>d.includes('TEMP B-TREE')),top20:rows.results,meta:rows.meta});
  }
  await writeFile('.cache/broad-read-analysis.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report.map(({id,phases,catalog_full_scan})=>({id,phases,catalog_full_scan})),null,2));
}finally{await db.close();}
