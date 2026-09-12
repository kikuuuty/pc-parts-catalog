// All expanded query plans, plus parser edge paths. Uses the real local D1 binding.
import { readFile, writeFile } from 'node:fs/promises';
import { openDatabase } from '../src/database.js';
import { loadSearchFixture } from '../src/quality/fixtures.js';
import { searchQuery } from '../src/queries.js';

const {fixture} = await loadSearchFixture();
const previous=process.argv.includes('--check-ranking') ? JSON.parse(await readFile('.cache/phase2-expanded-after.json','utf8')) : null;
const cases = [...fixture,...[
  ['memory','ddr5'],['memory','32gb'],['memory','6000mt/s'],['psu','gold'],['cpu_cooler','aio'],
].map(([category,query]) => ({category,query}))];
const db=await openDatabase();
try {
  const reports=[];
  for (const item of cases) {
    const q=searchQuery(item.category,{...item.search,keyword:item.query,limit:20,debug:true});
    const plan=(await db.query(`EXPLAIN QUERY PLAN ${q.sql}`,q.params)).results.map(r=>r.detail);
    const page=await db.query(q.sql,q.params);
    const old=previous?.results.find(r=>r.id===item.id);
    reports.push({id:item.id,query:item.query,category:item.category,params:q.params,plan,meta:page.meta,
      ranking_changed:old ? JSON.stringify(old.top_results.map(p=>p.id))!==JSON.stringify(page.results.slice(0,10).map(p=>p.id)) : false,
      full_scan:plan.some(d=>/^SCAN (?:p|s)(?:$| USING)/.test(d)),
      top:page.results.slice(0,5).map(p=>({name:p.name,year:p.release_year,model:p.model_score,spec:p.spec_score,manufacturer:p.manufacturer_score,freshness:p.freshness_score,fallback:p.search_fallback}))});
  }
  await writeFile('.cache/phase2-plans.json',JSON.stringify(reports,null,2)+'\n');
  const bad=reports.filter(r=>r.full_scan);
  const changed=reports.filter(r=>r.ranking_changed);
  console.log(JSON.stringify({queries:reports.length,full_scans:bad.map(r=>({query:r.query,plan:r.plan})),ranking_changes:changed.map(r=>r.query),rows_read:reports.reduce((s,r)=>s+r.meta.rows_read,0),max_rows_read:Math.max(...reports.map(r=>r.meta.rows_read)),size_bytes:reports[0].meta.size_after},null,2));
  if (bad.length) throw new Error('Catalog/spec full scan detected');
  if (changed.length) throw new Error('SQL optimization changed top-10 ordering');
} finally {await db.close();}
