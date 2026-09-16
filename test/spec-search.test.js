import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { database } from '../test-support/database.js';
import { normalize } from '../src/normalize.js';
import { syncSnapshot } from '../src/sync.js';
import { parseSearchIntent } from '../src/search-intent.js';
import { searchQuery } from '../src/queries.js';

const commit='a'.repeat(40);
const record=(category,name,data={},metadata={}) => normalize(category,{opendb_id:randomUUID(),...data,metadata:{name,manufacturer:'Example',part_numbers:[],...metadata}},commit);
const seed=(db,records) => syncSnapshot(db,{commit,records});
const search=async(db,category,keyword,options={}) => {
  const q=searchQuery(category,{keyword,debug:true,limit:100,...options});
  assert(q.params.length<=100);
  return (await db.query(q.sql,q.params)).results;
};
const specs=(category,query) => Object.fromEntries(parseSearchIntent(category,query).specs.map(s => [s.field,s.value]));

test('unit/context parsing is category-aware, bounded, and leaves ambiguous model numbers intact', () => {
  assert.deepEqual(specs('memory','ＤＤＲ５－６０００ ＣＬ３０ ３２ＧＢ'),{ram_type:'DDR5',capacity_gb:32,speed:6000,cas_latency:30});
  assert.deepEqual(specs('memory','6000mt/s'),{speed:6000});
  assert.deepEqual(specs('memory','6000 MHz'),{speed:6000});
  assert.deepEqual(specs('gpu','RTX 5080 16GB'),{vram_gb:16});
  assert.deepEqual(specs('storage','1.2tb'),{capacity_gb:1200});
  assert.deepEqual(specs('psu','850 W 80+ Gold'),{wattage:850,efficiency_rating:'80+ Gold'});
  assert.deepEqual(specs('case_fan','140 mm PWM'),{size_mm:140,pwm:1});
  assert.deepEqual(specs('cpu_cooler','360 aio'),{water_cooled:1,radiator_size_mm:360});
  assert.deepEqual(specs('cpu_cooler','120mm air cooler'),{water_cooled:0,fan_size_mm:120});
  assert.deepEqual(specs('motherboard','LGA1700 micro-atx DDR4'),{socket:'LGA 1700',form_factor:'Micro ATX',ram_type:'DDR4'});
  for (const category of ['cpu','gpu','memory','storage','motherboard','psu','case_fan','cpu_cooler']) {
    for (const q of ['5080','990','285','14900','6000','RM1000x','AB32GB','X1.2TB']) assert.deepEqual(specs(category,q),{},`${category}: ${q}`);
  }
  assert.deepEqual(specs('memory','32gb 64gb'),{});
  assert.equal(parseSearchIntent('memory','32gb 64gb').remaining,'32gb 64gb');
  assert.deepEqual(specs('cpu_cooler','air aio 360mm'),{});
  assert.deepEqual(specs('cpu_cooler','360mm'),{}); // Could be height or radiator; no assumed dimension.
  assert.equal(parseSearchIntent('cpu_cooler','cooler master air').remaining,'cooler master');
});

test('model anchors dominate specs, NULL specs survive, and wrong total capacity is not a kit match', async t => {
  const db=database();t.after(()=>db.sqlite.close());
  await seed(db,[
    record('storage','Samsung 990 PROX 2TB',{capacity:2000}),
    record('storage','Samsung 990 PRO 1TB',{capacity:1000}),
    record('storage','Samsung 990 PRO unknown'),
    record('storage','Samsung 990 PRO two terabytes',{capacity:2000}),
    record('storage','Other 2TB',{capacity:2000}),
    record('memory','RAM DDR5 6000 CL30 32GB misleading modules',{ram_type:'DDR5',speed:6000,cas_latency:30,capacity:64,modules:{quantity:2,capacity_gb:32}}),
    record('memory','Unlabelled memory kit',{ram_type:'DDR5',speed:6000,cas_latency:30,capacity:32}),
  ]);
  const rows=await search(db,'storage','990 pro 2tb');
  assert.equal(rows[0].name,'Samsung 990 PRO two terabytes');
  assert(rows.some(r=>r.name==='Samsung 990 PRO unknown'));
  assert(!rows.some(r=>r.name==='Other 2TB'));
  assert(rows.findIndex(r=>r.name==='Samsung 990 PRO unknown')<rows.findIndex(r=>r.name==='Samsung 990 PROX 2TB'));
  assert(rows[0].spec_score>rows.find(r=>r.name.endsWith('unknown')).spec_score);
  const memory=await search(db,'memory','ddr5 6000 cl30 32gb');
  assert.equal(memory[0].name,'Unlabelled memory kit');
  assert.equal(memory[0].search_match,'spec-intent');
  assert(memory.some(r=>r.capacity_gb===64)); // A name match is demoted, not silently cleaned or hard-filtered.
});

test('typed-only recall honors explicit scope and never drops unrecognized residual words', async t => {
  const db=database();t.after(()=>db.sqlite.close());
  await seed(db,[record('psu','Unit Alpha',{wattage:850,efficiency_rating:'80+ Gold'},{manufacturer:'Alpha',part_numbers:['UNIT850A']}),
    record('psu','Unit Beta',{wattage:850,efficiency_rating:'80+ Gold'},{manufacturer:'Beta'}),
    record('cpu_cooler','Silent tower',{fan_size:120,water_cooled:false,height:155,cpu_sockets:['AM5']})]);
  assert.equal((await search(db,'psu','850w gold')).length,2);
  const rows=await search(db,'psu','850w gold',{filters:{manufacturer:'Alpha'},identifier:{type:'mpn',value:'UNIT850A'}});
  assert.equal(rows.length,1);
  assert.equal(rows[0].manufacturer,'Alpha');
  assert.equal((await search(db,'psu','850w gold',{ranges:{wattage:{max:750}}})).length,0);
  assert.equal((await search(db,'psu','850w missingword')).length,0);
  assert.equal((await search(db,'cpu_cooler','120mm air cooler',{facets:{socket:'AM5'}})).length,1);
  assert.equal((await search(db,'cpu_cooler','120mm air cooler',{facets:{socket:'LGA1700'}})).length,0);
  await db.query("UPDATE products SET active=0 WHERE name='Unit Beta'");
  assert.equal((await search(db,'psu','850w gold')).length,1);
});

test('chipset identity separates B650-E naming from B650E and retains a missing-name typed candidate', async t => {
  const db=database();t.after(()=>db.sqlite.close());
  await seed(db,[record('motherboard','Example B650-E WIFI',{chipset:'AMD B650',form_factor:'ATX',socket:'AM5'}),
    record('motherboard','Example B650E WIFI',{chipset:'AMD B650E',form_factor:'Micro ATX',socket:'AM5'}),
    record('motherboard','Example Board Pro WIFI',{chipset:'AMD B650E',form_factor:'ATX',socket:'AM5'})]);
  const rows=await search(db,'motherboard','b650e wifi atx');
  assert.equal(rows[0].name,'Example Board Pro WIFI');
  assert.equal(rows[0].chipset,'AMD B650E');
  assert.equal(rows[0].search_match,'family-chipset');
  assert(rows.some(r=>r.chipset==='AMD B650'));
  assert.equal((await search(db,'motherboard','b650e missingword')).length,0);
});

test('freshness only adjusts CPU family matches: missing year is neutral and exact old SKUs still win', async t => {
  const db=database();t.after(()=>db.sqlite.close());
  await seed(db,[record('cpu','AMD Ryzen 7 1700X',{}, {manufacturer:'AMD',series:'Ryzen 7 1000',releaseYear:2017}),
    record('cpu','AMD Ryzen 7 1700XF',{}, {manufacturer:'AMD',series:'Ryzen 7 1000',releaseYear:2025}),
    record('cpu','AMD Ryzen 7 2700X',{}, {manufacturer:'AMD',series:'Ryzen 7 2000'}),
    record('cpu','AMD Ryzen 5 5700',{}, {manufacturer:'AMD',series:'Ryzen 5 5000',releaseYear:2026,part_numbers:['7']})]);
  const rows=await search(db,'cpu','ryzen 7');
  assert.equal(rows[0].name,'AMD Ryzen 7 1700XF');
  assert(rows.findIndex(r=>r.name.endsWith('2700X'))<rows.findIndex(r=>r.name.endsWith('1700X')));
  assert.equal(rows.find(r=>r.name.endsWith('2700X')).freshness_score,0);
  assert.equal(rows.at(-1).family,'Ryzen 5');
  const exact=await search(db,'cpu','1700x');
  assert.equal(exact[0].name,'AMD Ryzen 7 1700X');
  assert(exact.every(r=>r.freshness_score===0));
  assert.deepEqual(await search(db,'cpu','ryzen 7'),rows);
  assert.equal((await search(db,'cpu','ryzen 7',{orderBy:'release_year'}))[0].name,'AMD Ryzen 7 2700X');
});

test('manufacturer fields and punctuation variants combine with specs without changing identifiers', async t => {
  const db=database();t.after(()=>db.sqlite.close());
  await seed(db,[record('memory','G.Skill named by mistake',{speed:6000,cas_latency:30},{manufacturer:'Other'}),
    record('memory','Plain kit',{speed:6000,cas_latency:30},{manufacturer:'G.Skill',part_numbers:['KIT-6000-CL30']}),
    record('memory','G.Skill slower kit',{speed:5600,cas_latency:30},{manufacturer:'G.Skill'})]);
  const rows=await search(db,'memory','gskill 6000 cl30');
  assert.equal(rows[0].name,'Plain kit');
  assert.equal(rows[0].manufacturer_score,2);
  assert.equal((await search(db,'memory','KIT-6000-CL30'))[0].search_match,'exact-identifier');
  const plain=await search(db,'memory','gskill 6000 cl30',{debug:false});
  for (const key of ['spec_score','model_score','freshness_score','manufacturer_score','search_fallback']) assert(!Object.hasOwn(plain[0],key));
});

test('search index migration changes neither catalog values nor FTS, and spec queries stay within 100 binds', async t => {
  const db=database({through:'0004_search_relevance.sql'});t.after(()=>db.sqlite.close());
  await seed(db,[record('memory','Memory DDR5 32GB',{ram_type:'DDR5',capacity:32,speed:6000,cas_latency:30})]);
  const tables=['products','memory','upstream_raw','upstream_identifiers','local_identifiers','local_enrichments','product_fts'];
  const snapshot=()=>tables.map(table=>db.sqlite.prepare(`SELECT * FROM ${table}`).all());
  const before=snapshot();
  db.sqlite.exec(readFileSync(new URL('../migrations/0005_spec_search_indexes.sql',import.meta.url),'utf8'));
  assert.deepEqual(snapshot(),before);
  for (const name of ['0006_fts_projection_consistency.sql','0007_all_categories.sql','0008_category_fts.sql']) db.sqlite.exec(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
  const values=Array(20).fill('Example');
  const q=searchQuery('memory',{keyword:'ddr5 6000 cl30 32gb',filters:{manufacturer:values,series:values,variant:values,ecc:values,registered:Array(16).fill('Unbuffered')}});
  assert.equal(q.params.length,100);
  await db.query(q.sql,q.params);
  // Full-scan assertions run on local D1 via verify:plans/verify:search:local.
  // SQLite legitimately prefers a scan of this one-row synthetic table after ANALYZE.
});

test('scope is applied before the bounded typed-only recall path', async t => {
  const db=database();t.after(()=>db.sqlite.close());
  await seed(db,Array.from({length:300},(_,i)=>record('memory',`Unlabelled kit ${i}`,{ram_type:'DDR5',capacity:32,speed:6000,cas_latency:30},
    {manufacturer:i===299?'Late vendor':'Example'})));
  const rows=await search(db,'memory','ddr5 6000 cl30 32gb',{filters:{manufacturer:'Late vendor'}});
  assert.equal(rows.length,1);
  assert.equal(rows[0].name,'Unlabelled kit 299');
});
