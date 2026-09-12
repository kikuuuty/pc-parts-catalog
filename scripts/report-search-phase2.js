import { readFile, writeFile } from 'node:fs/promises';

const load = async file => JSON.parse(await readFile(`.cache/${file}`,'utf8'));
const before = await load('phase2-expanded-before.json');
const catalog = await load('phase2-catalog.json');
const products = new Map(catalog.products.map(p => [p.id,p]));
const selected = ['ryzen 7','ryzen 9','rtx 5080','5070 ti','b650e','b650e wifi','990 pro 2tb','sn850x 2tb','ddr5 6000 cl30 32gb','850w gold','360mm aio'];
const top = r => r.top_results.slice(0,5).map(p => ({name:p.name,release_year:products.get(p.id).release_year}));
if (process.argv[2] === 'costs') {
  const dev=await load('phase2-development.json');
  console.log(JSON.stringify(['before','after'].map(label=>{const rows=label==='before'?before.results.filter(r=>r.suite==='development'):dev.results;return {label,rows_read:rows.reduce((s,r)=>s+r.rows_read,0),elapsed:rows.reduce((s,r)=>s+r.elapsed_ms,0),worst:rows.toSorted((a,b)=>b.rows_read-a.rows_read).slice(0,6).map(r=>({query:r.query,rows:r.rows_read}))};}),null,2));
} else if (process.argv[2] === 'development') {
  console.log(JSON.stringify(before.results.filter(r => r.suite === 'development' && (r.rank !== 1 || r.precision_at_10 !== null && r.precision_at_10 < 1)).map(r => ({query:r.query,rank:r.rank,p5:r.precision_at_5,p10:r.precision_at_10,top:top(r)})),null,2));
  console.log(JSON.stringify(selected.map(query => {const r = before.results.find(r => r.query===query); return {query,rank:r.rank,top:top(r)};}),null,2));
} else if (process.argv[2] === 'compare') {
  const after = await load('phase2-expanded-after.json');
  if (before.fixture_sha256 !== after.fixture_sha256 || before.catalog.catalog_sha256 !== after.catalog.catalog_sha256) throw new Error('Fixture/catalog changed');
  const stats = rows => {
    const times=rows.map(r=>r.elapsed_ms).toSorted((a,b)=>a-b);
    return {queries:rows.length,rows_read:rows.reduce((s,r) => s+r.rows_read,0),elapsed_ms:rows.reduce((s,r) => s+r.elapsed_ms,0),
      elapsed_median_ms:(times[Math.floor((times.length-1)/2)]+times[Math.floor(times.length/2)])/2,
      elapsed_p95_ms:times[Math.ceil(times.length*0.95)-1],elapsed_max_ms:times.at(-1),
      sql_ms:rows.reduce((s,r) => s+r.sql_duration_ms,0),size_bytes:rows.find(r => r.size_bytes)?.size_bytes ?? null};
  };
  const regressions = after.results.flatMap(r => {
    const b = before.results.find(v => v.id===r.id);
    return (r.rank ?? Infinity) > (b.rank ?? Infinity) || r.precision_at_5 < b.precision_at_5 || r.precision_at_10 < b.precision_at_10
      ? [{id:r.id,query:r.query,suite:r.suite,before:{rank:b.rank,p5:b.precision_at_5,p10:b.precision_at_10},after:{rank:r.rank,p5:r.precision_at_5,p10:r.precision_at_10}}] : [];
  });
  const comparison = {catalog:after.catalog.catalog_sha256,fixture:after.fixture_sha256,
    before:{overall:before.summary,suites:before.by_suite,new:before.new_suite,classes:before.by_class},
    after:{overall:after.summary,suites:after.by_suite,new:after.new_suite,classes:after.by_class},
    composition:{categories:Object.fromEntries(Object.entries(after.by_category).map(([k,v]) => [k,v.query_count])),classes:Object.fromEntries(Object.entries(after.by_class).map(([k,v]) => [k,v.query_count]))},
    performance:Object.fromEntries(['regression','development','holdout','overall'].map(s => [s,{
      before:stats(before.results.filter(r => s === 'overall' || r.suite===s)),after:stats(after.results.filter(r => s === 'overall' || r.suite===s)),
    }])),regressions,
    slowest_sql:after.results.toSorted((a,b)=>b.sql_duration_ms-a.sql_duration_ms).slice(0,5).map(r=>({query:r.query,sql_ms:r.sql_duration_ms,elapsed_ms:r.elapsed_ms,rows_read:r.rows_read})),
    imperfect_precision:after.results.filter(r=>r.precision_at_10!==null && (r.precision_at_5<1 || r.precision_at_10<1)).map(r=>({query:r.query,suite:r.suite,p5:r.precision_at_5,p10:r.precision_at_10})),
    not_first:after.results.filter(r => r.rank !== 1).map(r => ({id:r.id,query:r.query,suite:r.suite,rank:r.rank,status:r.status,top:top(r)})),
    cases:selected.map(query => {const b=before.results.find(r => r.query===query),a=after.results.find(r => r.query===query); return {query,before:top(b),after:top(a),rank_before:b.rank,rank_after:a.rank};}),
  };
  await writeFile('.cache/phase2-comparison.json',JSON.stringify(comparison,null,2)+'\n');
  console.log(JSON.stringify(process.argv.includes('--summary-only') ? {performance:comparison.performance,slowest_sql:comparison.slowest_sql,regressions:comparison.regressions,imperfect_precision:comparison.imperfect_precision} : comparison,null,2));
} else throw new Error('Use costs, development or compare');
