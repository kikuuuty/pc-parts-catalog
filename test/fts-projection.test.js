import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { database } from '../test-support/database.js';
import { normalize } from '../src/normalize.js';
import { categories, models } from '../src/model.js';
import { syncSnapshot } from '../src/sync.js';
import { searchQuery } from '../src/queries.js';
import { addLocalIdentifier, setLocalEnrichment } from '../src/enrichment.js';
import { captureProjection, compareProjection } from '../scripts/lib/fts-verification.js';

const migration = name => readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
const repair = migration('0006_fts_projection_consistency.sql');
const commit = 'a'.repeat(40);
const record = (category, data = {}, metadata = {}) => normalize(category, {
  opendb_id: randomUUID(), ...data,
  metadata: { name: `Example ${category}`, manufacturer: 'Example', part_numbers: ['ZZ-001', 'AA-002'], ...metadata },
}, commit);
const records = () => [
  record('cpu', {}, { name: 'AMD Ryzen 7 9800X3D', series: 'Ryzen 7 9000', manufacturer: 'AMD' }),
  record('gpu', { chipset: 'GeForce RTX 5080', chipset_manufacturer: 'NVIDIA' }),
  record('motherboard', { chipset: 'AMD B650E' }, { name: 'Example Board WIFI' }),
  ...categories.filter(c => !['cpu', 'gpu', 'motherboard'].includes(c)).map(c => record(c)),
];
const seed = (db, rows) => syncSnapshot(db, { commit, records: rows });
const fts = db => db.sqlite.prepare('SELECT rowid,text,name,manufacturer,series,variant,family FROM product_fts ORDER BY rowid').all();
const protectedRows = db => ['products', ...Object.values(models).map(m => m.table), 'upstream_raw',
  'upstream_identifiers', 'local_identifiers', 'local_enrichments', 'product_facets', 'sync_runs', 'local_identifier_fts']
  .map(table => db.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());

test('0006 makes both historical backfill and 0005 fresh-ingest paths equal to canonical fresh ingest', async t => {
  const legacy = database({ through: '0003_query_plan_tuning.sql' });
  const oldFresh = database({ through: '0005_spec_search_indexes.sql' });
  const fresh = database();
  for (const db of [legacy, oldFresh, fresh]) t.after(() => db.sqlite.close());
  const rows = records();
  await seed(legacy, rows);
  legacy.sqlite.exec(migration('0004_search_relevance.sql') + migration('0005_spec_search_indexes.sql'));
  await seed(oldFresh, rows);
  assert.equal(fts(legacy)[2].family, '');
  assert.equal(fts(oldFresh)[2].family, 'AMD B650E'); // Reproduce the actual bug, not just a mocked bad row.
  for (const db of [legacy, oldFresh]) {
    await addLocalIdentifier(db, { productId: 1, type: 'jan', value: '0012345678901', evidence: 'synthetic label' });
    await setLocalEnrichment(db, { productId: 1, namespace: 'test', key: 'preserved', value: true, evidence: 'synthetic' });
    db.sqlite.exec('UPDATE products SET active=0 WHERE id=9');
    const before = protectedRows(db);
    const text = fts(db).map(r => [r.rowid, r.text]);
    db.sqlite.exec(repair);
    assert.deepEqual(protectedRows(db), before); // Includes timestamps/raw/local data, no exclusions.
    assert.deepEqual(fts(db).map(r => [r.rowid, r.text]), text);
    assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  }
  await seed(fresh, rows);
  assert.deepEqual(fts(legacy), fts(fresh));
  assert.deepEqual(fts(oldFresh), fts(fresh));
});

test('canonical category mapping, NULL handling and legacy text/identifier order remain explicit', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  const rows = records();
  rows.push(record('cpu'), record('gpu'), record('cpu', {}, { name: 'Ryzen 9 unnamed generation', series: null }));
  await seed(db, rows);
  const all = fts(db);
  assert.equal(all[0].family, 'Ryzen 7 9000');
  assert.equal(all[1].family, 'GeForce RTX 5080 GeForce RTX 50');
  assert.equal(all[2].family, '');
  assert(all[2].text.includes('AMD B650E')); // Chipset recall stays in text and typed Phase 2 paths.
  for (const row of all.slice(3, 11)) assert.equal(row.family, '');
  assert.equal(all[11].family, 'Ryzen 9');
  for (let i = 0; i < rows.length; i++) {
    for (const key of ['name', 'manufacturer', 'series', 'variant']) assert.equal(all[i][key], rows[i].product[key]);
    assert.equal(all[i].text, rows[i].search_text);
    assert(all[i].text.endsWith('ZZ-001 AA-002'));
  }
  const q = searchQuery('motherboard', { keyword: 'b650e wifi', debug: true });
  assert.equal((await db.query(q.sql, q.params)).results[0].search_match, 'family-chipset');
});

test('new, changed and reactivated ingestion matches backfill and no-op sync does not rewrite FTS', async t => {
  const upgraded = database({ through: '0005_spec_search_indexes.sql' });
  const fresh = database();
  for (const db of [upgraded, fresh]) t.after(() => db.sqlite.close());
  const rows = records();
  await seed(upgraded, rows); upgraded.sqlite.exec(repair); await seed(fresh, rows);
  for (const db of [upgraded, fresh]) {
    const changed = structuredClone(rows);
    changed[0].product.name = 'Updated CPU'; changed[0].spec.family = null; changed[0].spec.generation = '9000';
    changed[1].spec.chipset = 'Arc B580'; changed[1].spec.chip_series = 'Arc B';
    changed[2].spec.chipset = 'Intel Z890';
    for (const r of changed) r.product.content_hash += 'changed';
    await seed(db, changed);
    const before = fts(db);
    assert.equal(before[0].family, '9000'); assert.equal(before[1].family, 'Arc B580 Arc B'); assert.equal(before[2].family, '');
    // Force a repair-only defect in test DB, then backfill must restore the same result.
    db.sqlite.exec("UPDATE product_fts SET name='bad',family='bad'; DROP TRIGGER ingest_search_fields; DROP VIEW product_search_projection;");
    // Recreate the old trigger solely so the forward migration can replace it again.
    db.sqlite.exec('CREATE TRIGGER ingest_search_fields BEFORE DELETE ON ingest BEGIN SELECT 1; END;');
    db.sqlite.exec(repair);
    assert.deepEqual(fts(db), before);
    const result = await seed(db, changed); assert.equal(result.unchanged, rows.length); assert.deepEqual(fts(db), before);
    db.sqlite.exec('UPDATE products SET active=0');
    const reactivated = await seed(db, changed);
    assert.equal(reactivated.reactivated, rows.length);
    assert.deepEqual(fts(db), before);
  }
  assert.deepEqual(fts(upgraded), fts(fresh));
});

test('projection uses persisted fields at staging deletion and failures roll the whole ingest back', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  const rows = records(); await seed(db, rows);
  const changed = structuredClone(rows[2]); changed.product.content_hash += 'new'; changed.product.name = 'New Board'; changed.spec.chipset = 'Intel Z890';
  // A projection-source mismatch catches any regression back to JSON payload field extraction.
  db.sqlite.exec("CREATE TRIGGER test_persisted_name AFTER UPDATE ON products BEGIN UPDATE products SET name='Persisted Board' WHERE id=new.id; END;");
  await seed(db, [rows[0], rows[1], changed, ...rows.slice(3)]);
  assert.equal(fts(db)[2].name, 'Persisted Board'); assert.equal(fts(db)[2].family, '');
  db.sqlite.exec('DROP TRIGGER test_persisted_name');
  const before = fts(db), protectedBefore = protectedRows(db).slice(0, -2);
  db.sqlite.exec("CREATE TRIGGER test_projection_abort AFTER UPDATE ON products BEGIN SELECT RAISE(ABORT,'projection transaction test'); END;");
  changed.product.content_hash += 'bad';
  await assert.rejects(seed(db, [rows[0], rows[1], changed, ...rows.slice(3)]), /projection transaction test/);
  assert.deepEqual(fts(db), before);
  assert.deepEqual(protectedRows(db).slice(0, -2), protectedBefore);
  assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM ingest').get().n, 0);
});

test('FTS diagnostic distinguishes exact contents, protected data, order and numeric differences', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  await seed(db, records());
  const before = await captureProjection(db);
  const after = structuredClone(before);
  after.fts.rows[2][8] = 'unexpected chipset';
  let diff = compareProjection(before, after);
  assert.equal(diff.fts_difference_count, 1);
  assert.deepEqual(diff.fts_differences[0].fields, ['family']);
  assert.deepEqual(diff.data_changed_tables, []);
  after.tables.products.sha256 = 'changed';
  assert.deepEqual(compareProjection(before, after).data_changed_tables, ['products']);
  const ranked = structuredClone(before);
  ranked.fixture_sha256 = 'synthetic';
  ranked.ranking = [{ id: 'q', top20: [1, 2].map(n => ({ upstream_key: String(n), search_score: 600, search_fts_relevance: n, search_match: 'fts' })) }];
  const numeric = structuredClone(ranked);
  numeric.ranking[0].top20[0].search_fts_relevance += Number.EPSILON;
  diff = compareProjection(ranked, numeric);
  assert.deepEqual(diff.ranking_changes, []); assert.deepEqual(diff.score_changes, ['q']);
  assert.equal(diff.max_relevance_delta, Number.EPSILON);
  numeric.ranking[0].top20.reverse();
  assert.deepEqual(compareProjection(ranked, numeric).ranking_changes, ['q']);
});
