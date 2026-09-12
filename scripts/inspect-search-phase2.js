// Read-only catalog evidence for evaluation design; never uses search ranks to select targets.
import { readFile, writeFile } from 'node:fs/promises';
import { openDatabase } from '../src/database.js';
import { loadQualityCatalog } from '../src/quality/catalog.js';
import { loadSearchFixture } from '../src/quality/fixtures.js';
import { resolveExpected } from '../src/quality/benchmark.js';

let catalog;
if (process.argv.includes('--cached')) catalog = JSON.parse(await readFile('.cache/phase2-catalog.json','utf8'));
else {
  const db = await openDatabase();
  try { catalog = await loadQualityCatalog(db); }
  finally { await db.close(); }
  await writeFile('.cache/phase2-catalog.json',JSON.stringify(catalog));
}
if (process.argv.includes('--fixtures')) {
  const {fixture,hash} = await loadSearchFixture();
  const evidence = fixture.map(item => {
    const r = resolveExpected(catalog,item.category,item.expected);
    return { id:item.id,query:item.query,class:item.class,suite:item.suite,category:item.category,expected:item.expected,
      status:r.status,reason:r.reason,count:r.products.length,upstream_ids:r.products.map(p => p.upstream_id),
      samples:r.products.slice(0,3).map(p => ({upstream_id:p.upstream_id,name:p.name,manufacturer:p.manufacturer,release_year:p.release_year,spec:p.spec})) };
  });
  await writeFile('.cache/phase2-fixture-evidence.json',JSON.stringify({catalog:catalog.metadata,fixture_sha256:hash,evidence},null,2));
  for (const e of evidence.filter(e => e.suite !== 'regression')) console.log(JSON.stringify({id:e.id,count:e.count,status:e.status,reason:e.reason,samples:e.samples.map(p => p.name)}));
  if (evidence.some(e => e.status)) throw new Error('Resolve all evaluation targets before freezing fixture');
  console.log(JSON.stringify({total:fixture.length,hash,categories:Object.fromEntries([...new Set(fixture.map(r => r.category))].map(c => [c,fixture.filter(r => r.category===c).length])),suites:Object.fromEntries(['regression','development','holdout'].map(s => [s,fixture.filter(r => r.suite===s).length]))}));
} else {
const fields = {
  cpu:['family','generation'], gpu:['chipset'], memory:['ram_type','capacity_gb','speed','cas_latency'],
  storage:['capacity_gb','nvme'], motherboard:['socket','chipset','form_factor'], psu:['wattage','efficiency_rating','form_factor'],
  case:['form_factor'], cpu_cooler:['water_cooled','radiator_size_mm','fan_size_mm'], case_fan:['size_mm','pwm'],
};
console.log(JSON.stringify(catalog.metadata));
for (const [category,keys] of Object.entries(fields)) {
  const rows = catalog.products.filter(p => p.category === category && p.active);
  const counts = Object.fromEntries(keys.map(key => {
    const groups = new Map();
    for (const p of rows) { const v = p.spec?.[key] ?? null; groups.set(v,(groups.get(v) ?? 0)+1); }
    return [key,[...groups].sort((a,b) => b[1]-a[1]).slice(0,18)];
  }));
  console.log(JSON.stringify({category,counts,samples:rows.slice(0,3).map(p => ({upstream_id:p.upstream_id,name:p.name,spec:p.spec}))}));
}
const golden = JSON.parse(await readFile('test/fixtures/search-benchmark.json','utf8'));
console.log(JSON.stringify(golden.map(p => ({id:p.id,category:p.category,query:p.query}))));
}
