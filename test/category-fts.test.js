import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { database } from '../test-support/database.js';
import { categories, models, ftsName } from '../src/model.js';
import { normalize } from '../src/normalize.js';
import { syncSnapshot } from '../src/sync.js';
import { searchQuery } from '../src/queries.js';
import { categoryMigration } from '../scripts/lib/category-migration.js';
import { ftsIntegrity } from '../scripts/lib/fts-integrity.js';
import { captureProjection, compareProjection } from '../scripts/lib/fts-verification.js';
import { explainLexicalBm25 } from '../scripts/lib/bm25-explanation.js';
const commit='a'.repeat(40);
const record=c=>normalize(c,{opendb_id:randomUUID(),metadata:{name:`Example ${c}`,manufacturer:'Example',part_numbers:['MODEL-12345']}},commit);
const documents=db=>categories.flatMap(c=>db.sqlite.prepare(`SELECT rowid,* FROM ${ftsName(c)} ORDER BY rowid`).all());

test('registry routes all 30 categories exclusively and rejects SQL names; migration statements have ample D1 headroom',()=>{
  const m=categoryMigration(); assert(m.metrics.max_statement_bytes<10000); assert(m.metrics.max_create_trigger_bytes<10000);
  for(const c of categories){ const q=searchQuery(c,{keyword:'Example'}); assert(q.sql.includes(ftsName(c)));
    for(const other of categories.filter(x=>x!==c)) assert(!new RegExp(`\\b${ftsName(other)}\\b`).test(q.sql)); }
  assert.equal(categories.length,30); assert.throws(()=>ftsName('bad; DROP TABLE products'));
});

test('upgrade preserves source/local data and active projections, removes inactive documents, drops old corpora',async t=>{
  const db=database({through:'0007_all_categories.sql'});t.after(()=>db.sqlite.close());
  const records=categories.map(record);await syncSnapshot(db,{commit,records});
  db.sqlite.exec('UPDATE products SET active=0 WHERE id=1');
  const tables=['products','upstream_raw','upstream_identifiers','product_facets','local_identifiers','local_enrichments',...Object.values(models).map(m=>m.table)];
  const rows=()=>tables.map(n=>db.sqlite.prepare(`SELECT * FROM ${n} ORDER BY rowid`).all()); const before=rows();
  db.sqlite.exec(categoryMigration().sql); assert.deepEqual(rows(),before);
  assert((await ftsIntegrity(db)).pass);assert.equal(documents(db).length,29);
  assert.equal(db.sqlite.prepare("SELECT count(*) n FROM sqlite_schema WHERE name IN ('product_fts','extended_product_fts')").get().n,0);
  await syncSnapshot(db,{commit,records}); assert((await ftsIntegrity(db)).pass);assert.equal(documents(db).length,30);
});

for(const category of categories) test(`${category}: insert/update/move/inactivate/reactivate/delete/rollback/resume`,async t=>{
  const db=database();t.after(()=>db.sqlite.close()); const original=record(category), snapshot={commit,records:[original]};
  await syncSnapshot(db,snapshot);assert((await ftsIntegrity(db)).pass);
  const initial=documents(db);const changed=structuredClone(original);changed.product.name='Changed model';changed.product.content_hash+='change';changed.search_text='Changed model';
  // Entire staging statement rolls back, including text/typed/category FTS updates.
  db.sqlite.exec(`CREATE TRIGGER reject_spec BEFORE INSERT ON ${models[category].table} BEGIN SELECT RAISE(ABORT,'rollback'); END`);
  await assert.rejects(syncSnapshot(db,{commit,records:[changed]}),/rollback/);assert.deepEqual(documents(db),initial);
  db.sqlite.exec('DROP TRIGGER reject_spec');
  assert.equal((await syncSnapshot(db,{commit,records:[changed]},{maxProducts:0})).status,'partial');
  assert.equal((await syncSnapshot(db,{commit,records:[changed]})).updated,1);
  assert.equal(documents(db)[0].name,'Changed model');
  db.sqlite.exec('UPDATE products SET active=0'); assert.equal(documents(db).length,0);
  db.sqlite.exec('UPDATE products SET active=1'); assert((await ftsIntegrity(db)).pass);
  const other=categories[(categories.indexOf(category)+1)%categories.length], moved=record(other);
  moved.product.upstream_key=original.product.upstream_key;
  await syncSnapshot(db,{commit,records:[moved]});assert((await ftsIntegrity(db)).pass);
  assert.equal(db.sqlite.prepare(`SELECT count(*) n FROM ${ftsName(category)}`).get().n,0);
  assert.equal(db.sqlite.prepare(`SELECT count(*) n FROM ${models[category].table}`).get().n,0);
  db.sqlite.exec('BEGIN; DELETE FROM products; ROLLBACK'); assert((await ftsIntegrity(db)).pass);
  db.sqlite.exec('DELETE FROM products');assert.equal(documents(db).length,0);assert((await ftsIntegrity(db)).pass);
  await syncSnapshot(db,{commit,records:[record(other)]});assert.equal(db.sqlite.prepare('SELECT id FROM products').get().id,2);
});

test('unrelated corpus writes cannot change BM25; diagnostics retain canonical projection checks',async t=>{
  const db=database();t.after(()=>db.sqlite.close());const cpu=record('cpu'); await syncSnapshot(db,{commit,records:[cpu]});
  const query=searchQuery('cpu',{keyword:'Example',debug:true}), before=(await db.query(query.sql,query.params)).results;
  await syncSnapshot(db,{commit,records:[cpu,...categories.filter(c=>c!=='cpu').map(record)]});
  assert.deepEqual((await db.query(query.sql,query.params)).results,before);
  assert(explainLexicalBm25(db.sqlite,'cpu_fts','"Example"*',before).documents===1);
  const a=await captureProjection(db), b=structuredClone(a);b.fts.rows[0][8]='bad';
  assert.equal(compareProjection(a,b).fts_difference_count,1);
});

test('integrity gate detects missing, duplicate, wrong-category and inactive orphan independently',async t=>{
  const db=database();t.after(()=>db.sqlite.close());await syncSnapshot(db,{commit,records:[record('cpu')]});
  db.sqlite.exec('BEGIN; DELETE FROM cpu_fts');assert.equal((await ftsIntegrity(db)).missing_fts_row,1);db.sqlite.exec('ROLLBACK');
  db.sqlite.exec('INSERT INTO memory_fts(rowid,text,name,manufacturer,series,variant,family) SELECT rowid,* FROM cpu_fts');
  let integrity=await ftsIntegrity(db);assert.equal(integrity.duplicate_fts_row,1);assert.equal(integrity.wrong_category_row,1);assert(!integrity.pass);
  db.sqlite.exec('UPDATE products SET active=0');integrity=await ftsIntegrity(db);assert.equal(integrity.inactive_orphan,1);assert(!integrity.pass);
});
