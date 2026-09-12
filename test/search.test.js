import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { database } from '../test-support/database.js';
import { normalize } from '../src/normalize.js';
import { searchQuery, searchTerms } from '../src/queries.js';
import { syncSnapshot } from '../src/sync.js';
import { addLocalIdentifier, setLocalEnrichment } from '../src/enrichment.js';

const commit = 'a'.repeat(40);
const record = (category, name, metadata = {}, data = {}) => normalize(category, {
  opendb_id: randomUUID(), ...data, metadata: { manufacturer:'Example',part_numbers:[],...metadata,name },
},commit);
const seed = (db,records) => syncSnapshot(db,{commit,records});
const search = async (db,category,keyword,options = {}) => {
  const q = searchQuery(category,{keyword,debug:true,...options});
  assert(q.params.length <= 100);
  return (await db.query(q.sql,q.params)).results;
};
const names = rows => rows.map(r => r.name);

test('whole name/model tokens outrank suffix SKUs and contradictory variant fields', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  const models = ['14900K','285K','9800X3D','7640U']; // Includes a model outside Golden Query.
  await seed(db,models.flatMap(model => [
    record('cpu',`Example Core ${model}F`,{variant:model+'F'}),
    record('cpu',`Example Core ${model}S`,{variant:model+'S'}),
    record('cpu',`Example Core ${model}`,{variant:model+'S'}),
  ]));
  for (const model of models) {
    const rows = await search(db,'cpu',model.toLowerCase());
    assert.equal(rows[0].name,`Example Core ${model}`);
    assert.equal(rows.length,3);
    assert(rows[0].search_score > rows[1].search_score);
    assert.equal((await search(db,'cpu',model+'s'))[0].name,`Example Core ${model}S`);
  }
  assert.equal((await search(db,'cpu','Ｅｘａｍｐｌｅ Ｃｏｒｅ １４９００Ｋ'))[0].search_match,'exact-name');
  const plain = await search(db,'cpu','14900k',{debug:false});
  assert(!Object.hasOwn(plain[0],'search_score'));
});

test('bounded compact model forms retrieve spaced/hyphenated models in both directions', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  await seed(db,[
    record('storage','Samsung 990 PRO 1TB',{manufacturer:'Samsung'}),
    record('storage','Samsung 990 PRO 2TB',{manufacturer:'Samsung'}),
    record('storage','Samsung 990 PROX 2TB',{manufacturer:'Samsung'}),
    record('storage','Unrelated 990 fast professional'),
    record('storage','WD SN850X 1TB'), record('storage','WD SN 850 X 2TB'),
    record('storage','Example AB1234Z'), record('storage','Example AB 1234 Z'),
    record('gpu','Board GeForce RTX 5080'), record('gpu','Board GeForce RTX5080'),
    record('gpu','Board GeForce RTX-5080'), record('gpu','Board RTX special 5080'),
    record('gpu','Board RTX 50800'),
    record('cpu','AMD Ryzen 7 9800X3D'), record('cpu','AMD Ryzen 7 9800 X3D'),
  ]);
  for (const query of ['990pro','990 pro','９９０ＰＲＯ','990-pro']) {
    const rows = await search(db,'storage',query);
    assert.deepEqual(new Set(names(rows.slice(0,2))),new Set(['Samsung 990 PRO 1TB','Samsung 990 PRO 2TB']));
    if (!/[ -]/.test(query)) assert(!names(rows).includes('Unrelated 990 fast professional'));
  }
  for (const query of ['rtx5080','rtx 5080','RTX-5080']) {
    const rows = await search(db,'gpu',query);
    assert(rows.slice(0,3).every(r => /RTX[ -]?5080$/.test(r.name)));
    assert(names(rows).includes('Board GeForce RTX5080'));
    assert(names(rows).includes('Board GeForce RTX 5080'));
  }
  assert(!names(await search(db,'gpu','rtx5080')).includes('Board RTX special 5080'));
  for (const queries of [['sn850x','sn 850x','sn850 x','sn 850 x'],['ab1234z','ab 1234z','ab1234 z'],['9800x3d','9800 x3d']]) {
    const category = queries[0].startsWith('9800') ? 'cpu' : 'storage';
    for (const query of queries) assert.equal((await search(db,category,query)).length,2,query);
  }
});

test('natural language is not compacted and model expansion stays bounded', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  await seed(db,[record('gpu','Red Dragon 5080'),record('gpu','RedDragon 5080')]);
  assert.deepEqual(names(await search(db,'gpu','red dragon 5080')),['Red Dragon 5080']);
  assert.deepEqual(names(await search(db,'gpu','reddragon 5080')),['RedDragon 5080']);
  assert.deepEqual(await search(db,'gpu','red OR dragon'),[]);
  assert.deepEqual(await search(db,'gpu','red missingword'),[]);
  const terms = searchTerms('a 123 b c 456 d e 789 f g 123 h');
  assert(JSON.stringify(terms).length < 10000);
  assert.throws(() => searchTerms('a '.repeat(13)),/1–12/);
  assert.throws(() => searchTerms('x'.repeat(201)),/200/);
});

test('short family numbers match whole tokens; name/family outrank identifier noise', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  await seed(db,[
    record('cpu','AMD Ryzen Threadripper 7970X',{manufacturer:'AMD',part_numbers:['7']}),
    record('cpu','AMD Ryzen 5 7600',{manufacturer:'AMD',part_numbers:['7']}),
    record('cpu','AMD Ryzen 7 7800X3D',{manufacturer:'AMD',series:'Ryzen 7 7000'}),
    record('cpu','Example Ultra 7 900',{part_numbers:['9']}),
    record('cpu','Example Core Ultra 9 285K'),
    record('cpu','Example Core 7 150U'),
  ]);
  const ryzen = await search(db,'cpu','ryzen 7');
  assert.equal(ryzen[0].name,'AMD Ryzen 7 7800X3D');
  assert.equal(ryzen.length,3); // Identifier noise still retrievable, just below the family.
  assert.equal((await search(db,'cpu','ultra 9'))[0].name,'Example Core Ultra 9 285K');
  assert.equal((await search(db,'cpu','core 7'))[0].name,'Example Core 7 150U');
});

test('fallback drops one isolated letter only after scoped strict AND returns zero', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  const loose = record('gpu','MSI GeForce RTX 5080 16G GAMING TRIO OC',{manufacturer:'MSI'},{length:300});
  const strict = record('gpu','Other GeForce RTX 5080 GAMING X TRIO',{manufacturer:'Other'},{length:350});
  await seed(db,[loose,strict,record('gpu','MSI GAMING TRIO 5070',{manufacturer:'MSI'},{length:250})]);
  const query = 'gaming x trio 5080';
  const rows = await search(db,'gpu',query);
  assert.deepEqual(names(rows),[strict.product.name]);
  assert.notEqual(rows[0].search_match,'fallback');
  // A strict hit in another manufacturer/range must not suppress in-scope fallback.
  const options = {filters:{manufacturer:'MSI'},ranges:{length_mm:{max:320}}};
  const fallback = await search(db,'gpu',query,options);
  assert.deepEqual(names(fallback),[loose.product.name]);
  assert.equal(fallback[0].search_match,'fallback');
  assert(fallback[0].search_score < (await search(db,'gpu','gaming trio 5080',options))[0].search_score);
  for (const query of ['gaming missing trio 5080','gaming 9 trio 5080','gaming x 5080','gaming x y trio 5080','gaming x trio 9999','gaming trio 5080 x']) {
    assert.deepEqual(await search(db,'gpu',query,options),[],query);
  }
  assert.equal(searchTerms('gaming x trio').fallback,null);
  const repeat = await search(db,'gpu',query,options);
  assert.deepEqual(repeat,fallback);
  const q = searchQuery('gpu',{keyword:query,...options,limit:1});
  assert.deepEqual((await db.query(`${q.sql} OFFSET ?`,[...q.params,1])).results,[]);
  await db.query('UPDATE products SET active=0 WHERE upstream_id=?',[strict.product.upstream_id]);
  assert.equal((await search(db,'gpu',query))[0].search_match,'fallback');
});

test('exact identifier boost requires shape and distinct low-frequency ownership', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  const records = [
    record('memory','Example AB1234ZZ'),
    record('memory','Actual memory',{part_numbers:['AB1234Z','AB1234Z']}),
    ...Array.from({length:4},(_,i) => record('memory',`Shared memory ${i}`,{part_numbers:['SHARED123','OC','16','32']})),
    record('memory','SHARED123 memory'),record('memory','OC memory'),record('memory','16 memory'),
  ];
  await seed(db,records);
  assert.equal((await search(db,'memory','AB1234Z'))[0].name,'Actual memory');
  assert.equal((await search(db,'memory','AB1234Z'))[0].search_match,'exact-identifier');
  for (const query of ['SHARED123','OC','16','32']) {
    const rows = await search(db,'memory',query);
    assert(rows.every(r => r.search_match !== 'exact-identifier'),query);
    if (query !== '32') assert.equal(rows[0].name,`${query} memory`);
  }
  const id = (await search(db,'memory','Actual'))[0].id;
  await addLocalIdentifier(db,{productId:id,type:'jan',value:'0012345678901',evidence:'Test label'});
  assert.equal((await search(db,'memory','００１２３４５６７８９０１'))[0].search_match,'exact-identifier');
  await db.query('DELETE FROM local_identifiers');
  assert.deepEqual(await search(db,'memory','0012345678901'),[]);
  // No punctuation stripping for exact identifiers, nor numeric coercion of leading zeroes.
  assert.deepEqual(await search(db,'memory','12345678901'),[]);
});

test('stable ties, explicit order, scoped identifier/facets and the 100-bind ceiling survive ranking', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  await seed(db,[record('cpu_cooler','Example Tower 1234',{part_numbers:['COOL1234']},{height:160,cpu_sockets:['AM5']}),
    record('cpu_cooler','Example Tower 1234',{part_numbers:['COOL1234']},{height:150,cpu_sockets:['LGA1700']})]);
  const rows = await search(db,'cpu_cooler','tower 1234');
  assert(rows[0].id < rows[1].id);
  assert.deepEqual(await search(db,'cpu_cooler','tower 1234'),rows);
  assert.equal((await search(db,'cpu_cooler','tower 1234',{orderBy:'height_mm'}))[0].height_mm,150);
  const scoped = {identifier:{type:'mpn',value:'COOL1234'},facets:{socket:'AM5'}};
  assert.equal((await search(db,'cpu_cooler','tower 1234',scoped)).length,1);
  const values = Array(20).fill('Example');
  const filters = {manufacturer:values,series:values,variant:values,family:values,socket:Array(16).fill('AM5')};
  const q = searchQuery('cpu',{keyword:'gaming x trio 1234',filters});
  assert.equal(q.params.length,100);
  await db.query(q.sql,q.params);
  assert.throws(() => searchQuery('cpu',{keyword:'gaming x trio 1234',filters:{...filters,socket:Array(17).fill('AM5')}}),/100 bound/);
});

test('migration backfills search only and subsequent ingest refreshes fields atomically', async t => {
  const db = database({through:'0003_query_plan_tuning.sql'}); t.after(() => db.sqlite.close());
  const original = record('cpu','Example Core 14900K',{series:'Core 9',variant:'14900KS',part_numbers:['BX14900K']});
  await seed(db,[original]);
  await addLocalIdentifier(db,{productId:1,type:'mpn',value:'LOCAL1234',evidence:'Test'});
  await setLocalEnrichment(db,{productId:1,namespace:'test',key:'unchanged',value:true,evidence:'Test'});
  const tables = ['products','upstream_raw','upstream_identifiers','local_identifiers','local_enrichments','cpu','product_facets','sync_runs'];
  const protectedRows = () => tables.map(table => db.sqlite.prepare(`SELECT * FROM ${table}`).all());
  const before = protectedRows();
  db.sqlite.exec(readFileSync(new URL('../migrations/0004_search_relevance.sql',import.meta.url),'utf8'));
  assert.deepEqual(protectedRows(),before);
  assert.equal((await search(db,'cpu','14900k'))[0].search_match,'name-phrase');
  assert.equal((await search(db,'cpu','LOCAL1234'))[0].search_match,'exact-identifier');
  const changed = structuredClone(original);
  changed.product.name = 'Example Core 285K'; changed.product.variant = '285K';
  changed.product.content_hash = 'changed'; changed.search_text = 'Example Core 285K';
  await seed(db,[changed]);
  assert.deepEqual(await search(db,'cpu','14900k'),[]);
  assert.equal((await search(db,'cpu','285k'))[0].search_match,'name-phrase');
  const invalid = structuredClone(changed);
  invalid.product.name = 'Broken 7777K'; invalid.product.content_hash = 'invalid';
  invalid.identifiers[0].region = null;
  await assert.rejects(seed(db,[invalid]),/NOT NULL/);
  assert.deepEqual(await search(db,'cpu','7777k'),[]);
  assert.equal((await search(db,'cpu','285k')).length,1);
});
