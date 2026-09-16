import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { database } from '../test-support/database.js';
import { normalize } from '../src/normalize.js';
import { syncSnapshot } from '../src/sync.js';
import { searchQuery, searchTerms } from '../src/queries.js';
import { categoryMigration, categoryIndexes, experimentQuery, integrity, compareRuns, rankChange, hash } from '../scripts/lib/corpus-experiment.js';
import { splitSqlStatements } from '../scripts/lib/sql-statements.js';
import { explainLexicalBm25 } from '../scripts/lib/bm25-explanation.js';

test('category experiment preserves fields, updates only routed FTS, moves/deactivates/reactivates atomically and protects local data',async t => {
  const db=database();t.after(()=>db.sqlite.close());
  const commit='a'.repeat(40), records=['cpu','keyboard','mouse'].map(category => normalize(category,{opendb_id:randomUUID(),metadata:{name:'Example 1234',manufacturer:'Example',part_numbers:['EX-1234']}},commit));
  await syncSnapshot(db,{commit,records});
  const migration=categoryMigration(db.sqlite.prepare("SELECT sql FROM sqlite_schema WHERE name='ingest_product'").get().sql);
  assert.equal(splitSqlStatements(migration.sql).length,migration.statements.length);
  for (const sql of migration.statements) db.sqlite.exec(sql);
  assert.equal(Object.keys(categoryIndexes).length,30);
  assert((await integrity(db,'category')).pass);
  const id=db.sqlite.prepare("SELECT id FROM products WHERE category='keyboard'").get().id;
  db.sqlite.prepare("INSERT INTO local_enrichments VALUES(?,'test','key','1','evidence',NULL,'now')").run(id);
  db.sqlite.prepare("INSERT INTO local_identifiers(product_id,type,value,value_key,evidence) VALUES(?,'mpn','LOCAL-1234','LOCAL1234','evidence')").run(id);
  const unchangedMouse=db.sqlite.prepare('SELECT * FROM mouse_fts').all();
  records[1].product.name='Updated 1234'; records[1].product.content_hash='changed';records[1].search_text='Updated 1234';
  await syncSnapshot(db,{commit,records});
  assert.equal(db.sqlite.prepare('SELECT name FROM keyboard_fts WHERE rowid=?').get(id).name,'Updated 1234');
  assert.deepEqual(db.sqlite.prepare('SELECT * FROM mouse_fts').all(),unchangedMouse);
  // A transaction failure after the FTS move must roll everything back.
  db.sqlite.exec('BEGIN');
  const moving=structuredClone(records[1]);moving.product.category='mouse';moving.spec=records[2].spec;
  db.sqlite.prepare('INSERT INTO ingest(payload) VALUES(?)').run(JSON.stringify(moving));
  assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM keyboard_fts WHERE rowid=?').get(id).n,0);
  assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM mouse_fts WHERE rowid=?').get(id).n,1);
  db.sqlite.exec('ROLLBACK');
  assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM keyboard_fts WHERE rowid=?').get(id).n,1);
  // Actual failed multi-row ingest rolls back a previously successful row too.
  const bad=structuredClone(moving);bad.product.upstream_key='bad';bad.product.category='unknown';
  assert.throws(()=>db.sqlite.prepare('INSERT INTO ingest(payload) SELECT value FROM json_each(?)').run(JSON.stringify([moving,bad])));
  assert.equal(db.sqlite.prepare('SELECT category FROM products WHERE id=?').get(id).category,'keyboard');
  db.sqlite.prepare('INSERT INTO ingest(payload) VALUES(?)').run(JSON.stringify(moving));
  assert((await integrity(db,'category')).pass);
  db.sqlite.prepare('UPDATE products SET active=0 WHERE id=?').run(id);
  assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM mouse_fts WHERE rowid=?').get(id).n,0);
  db.sqlite.prepare('INSERT INTO ingest(payload) VALUES(?)').run(JSON.stringify(moving));
  assert((await integrity(db,'category')).pass);
  assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM local_enrichments').get().n,1);
  assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM local_identifiers').get().n,1);
  db.sqlite.exec('BEGIN');
  for (const table of ['upstream_raw','upstream_identifiers','local_identifiers','local_enrichments','product_facets','mouse']) db.sqlite.prepare(`DELETE FROM ${table} WHERE product_id=?`).run(id);
  db.sqlite.prepare('DELETE FROM products WHERE id=?').run(id);
  assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM mouse_fts WHERE rowid=?').get(id).n,0);
  db.sqlite.exec('ROLLBACK');
});

test('diagnostic modes leave baseline SQL unchanged and change only ordering contributions',async t => {
  const db=database();t.after(()=>db.sqlite.close());
  const records=['Common 1234','Common 1234 Extra Extra Extra'].map(name => normalize('keyboard',{opendb_id:randomUUID(),metadata:{name,manufacturer:'Example'}},'a'.repeat(40)));
  await syncSnapshot(db,{commit:'a'.repeat(40),records});
  const options={keyword:'Common 1234',debug:true};
  assert.deepEqual(experimentQuery()('keyboard',options),searchQuery('keyboard',options));
  const rankings={};
  for (const mode of ['normal','without_bm25','bm25_only']) { const q=experimentQuery('baseline',mode)('keyboard',options);rankings[mode]=(await db.query(q.sql,q.params)).results; }
  for (const p of rankings.normal) {
    const without=rankings.without_bm25.find(r => r.id===p.id),only=rankings.bm25_only.find(r => r.id===p.id);
    assert(Math.abs((p.search_score-without.search_score)-p.search_fts_relevance/(1+p.search_fts_relevance))<1e-10);
    assert.equal(only.search_score,p.search_fts_relevance);
    assert.equal(without.model_score,p.model_score);
  }
  const explanation=explainLexicalBm25(db.sqlite,'extended_product_fts',searchTerms(options.keyword).strict.prefix,rankings.normal);
  assert.equal(explanation.documents,2);
  assert(explanation.phrases.every(p=>p.document_frequency===2));
  assert(explanation.results.every(r=>r.contributions.some(p=>p.weighted_tf>0)));
});

test('category FTS partial import resumes and a completed no-change sync performs no ingest',async t=>{
  const db=database();t.after(()=>db.sqlite.close());
  const migration=categoryMigration(db.sqlite.prepare("SELECT sql FROM sqlite_schema WHERE name='ingest_product'").get().sql);
  for (const sql of migration.statements) db.sqlite.exec(sql);
  const commit='a'.repeat(40),records=Object.keys(categoryIndexes).map(category=>normalize(category,{opendb_id:randomUUID(),metadata:{name:'Sample 1234',manufacturer:'Example'}},commit));
  const snapshot={commit,records};
  const first=await syncSnapshot(db,snapshot,{maxProducts:7});assert.equal(first.status,'partial');assert.equal(first.added,7);
  assert((await integrity(db,'category')).pass);
  const second=await syncSnapshot(db,snapshot);assert.equal(second.added,23);assert.equal(second.unchanged,7);
  assert.equal(second.status,'complete');assert.equal((await integrity(db,'category')).active_products,30);
  let ingests=0;
  const repeat=await syncSnapshot({...db,async query(sql,params){if (/^INSERT INTO ingest/.test(sql)) ingests++;return db.query(sql,params);}},snapshot,{reuseComplete:true});
  assert.equal(repeat.unchanged,30);assert.equal(ingests,0);assert((await integrity(db,'category')).pass);
});

test('missing ranks, unequal short lists and regressions are reported without optimistic cutoff imputation',()=>{
  assert.deepEqual(rankChange(1,null),{delta:null,regressed:true,improved:false});
  const make=(rank,keys)=>({fixture_sha256:'same',results:[{id:'q',category:'cpu',class:'exact_model',suite:'regression',query:'x',expected:{upstream_key:'x'},rank,status:'HIT',top_results:keys.map((key,i)=>({upstream_key:key,rank:i+1})),rows_read:5,sql_duration_ms:1}]});
  const report=compareRuns(make(1,['a','b']),make(3,['b','c']));
  assert.equal(report.regressions.length,1);assert.equal(report.dropped_top1.length,1);assert.equal(report.overlap[10].mean_jaccard,1/3);
});

test('extended suite is independently frozen, stable-key selected, all-category and all-class covered',async()=>{
  const input=await readFile('test/fixtures/search-extended.json','utf8'),fixture=JSON.parse(input);
  const manifest=JSON.parse(await readFile('test/fixtures/search-extended-evidence.json','utf8'));
  assert.equal(hash(input),'0159fb0832226c96918e2d24052e5917ea357069cac71999d0284a5c5c28f4be');
  assert.equal(hash(input),manifest.fixture_sha256);assert.equal(fixture.length,102);
  assert.equal(new Set(fixture.map(r => r.category)).size,21);
  for (const cls of ['exact_model','compact_model','manufacturer_model','variant','identifier','broad','typed_spec','facet','range']) assert(fixture.some(r => r.class===cls));
  assert(fixture.every(r => r.expected.upstream_key || r.expected.anyOf.every(p => p.upstream_key)));
  assert.match(manifest.review_status,/pending human/);
});
