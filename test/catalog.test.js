import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from '../test-support/database.js';
import { randomUUID } from 'node:crypto';
import { normalize, cpuClass, gpuSeries, identifierKey, pcie } from '../src/normalize.js';
import { searchQuery, keywordExpression } from '../src/queries.js';
import { syncSnapshot, ingestionStatement } from '../src/sync.js';
import { addLocalIdentifier, setLocalEnrichment } from '../src/enrichment.js';

const COMMIT = 'a'.repeat(40);
// Synthetic edge cases. Real upstream schema validation + plans run via CLI on the pinned checkout.
const product = (overrides = {}) => ({
  opendb_id: randomUUID(),
  metadata: { name: 'AMD Ryzen 7 9800X3D', manufacturer: 'AMD', series: 'Ryzen 7 9000', variant: '9800X3D', part_numbers: ['100-TEST'] },
  series: 'Ryzen 7 9000', socket: 'AM5', cores: { total: 8, threads: 16 },
  specifications: { tdp: 120, memory: { types: ['DDR5'] } },
  clocks: { performance: { boost: 5.2 } },
  identifiers: { version: 1, identifiers: [{ type: 'mpn', value: '100-TEST', region: 'all' }, { type: 'ean', value: '0012345678901', region: 'all' }], retailer_listings: [] },
  ...overrides,
});
const snapshot = records => ({ commit: COMMIT, records });
const row = (db, sql, ...params) => db.sqlite.prepare(sql).get(...params);
const count = (db, table) => row(db, `SELECT count(*) AS n FROM ${table}`).n;
async function search(db, category, options) {
  const q = searchQuery(category, options);
  return (await db.query(q.sql, q.params)).results;
}

test('normalization respects actual units, known family buckets and unknown values', () => {
  assert.deepEqual(cpuClass({ series: 'Core i7 14000' }), { family: 'Core i7', generation: '14000' });
  assert.deepEqual(cpuClass({ metadata: { name: 'Intel Core i7-14700K' } }), { family: 'Core i7', generation: null });
  assert.deepEqual(cpuClass({ series: 'Core Ultra 9 200' }), { family: 'Core Ultra 9', generation: '200' });
  assert.deepEqual(cpuClass({ series: 'Xeon' }), { family: null, generation: null });
  assert.equal(gpuSeries('GeForce RTX 5080'), 'GeForce RTX 50');
  assert.equal(gpuSeries('Radeon RX 9070 XT'), 'Radeon RX 9000');
  assert.equal(gpuSeries('ARC B580'), 'Arc B');
  assert.equal(gpuSeries('Unknown 9000'), null);
  assert.deepEqual(pcie('M.2 PCIe 4.0 x4'), { pcie_generation: 4, pcie_lanes: 4 });
  assert.deepEqual(pcie('PCIe x16'), { pcie_generation: null, pcie_lanes: 16 });
  const r = normalize('cpu', product(), COMMIT);
  assert.equal(r.spec.boost_clock_ghz, 5.2);
  assert.equal(r.spec.tdp_w, 120);
  assert.equal(r.spec.ppt_w, null);
  assert.equal(normalize('gpu', product({ memory: 0, length: 0, tdp: null }), COMMIT).spec.length_mm, null);
  assert.equal(normalize('memory', product({ speed: 6000, modules: { quantity: 2, capacity_gb: 16 } }), COMMIT).spec.capacity_gb, 32);
  assert.equal(normalize('case_fan', product({ min_noise_level: 0, min_airflow: 60 }), COMMIT).spec.noise_max_db, 0);
  assert.equal(normalize('cpu_cooler', product({ min_noise_level: 25 }), COMMIT).spec.noise_max_db, 25);
});

test('all nine category projections preserve a typed row and raw data', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  const cases = [
    ['cpu', {}, 'cpu'], ['memory', { ram_type: 'DDR5', speed: 6000, capacity: 32 }, 'memory'],
    ['motherboard', { memory: { max: 128, ram_type: 'DDR5', slots: 4 } }, 'motherboard'],
    ['gpu', { chipset: 'GeForce RTX 5080', chipset_manufacturer: 'NVIDIA', length: 320, memory: 16 }, 'gpu'],
    ['storage', { capacity: 1000, storage_type: 'SSD', interface: 'M.2 PCIe 4.0 x4' }, 'storage'],
    ['psu', { wattage: 850, form_factor: 'ATX' }, 'psu'],
    ['case', { max_video_card_length: 350, supported_motherboard_form_factors: ['ATX'] }, 'pc_case'],
    ['case_fan', { size: 120, min_airflow: 60 }, 'case_fan'],
    ['cpu_cooler', { cpu_sockets: ['AM5', 'LGA1700'], height: 160 }, 'cpu_cooler'],
  ];
  const records = cases.map(([category, data]) => normalize(category, product(data), COMMIT));
  await syncSnapshot(db, snapshot(records));
  for (const [, , table] of cases) assert.equal(count(db, table), 1);
  assert.equal(count(db, 'upstream_raw'), 9);
  assert.equal(count(db, 'ingest'), 0);
  assert.equal((await db.query('PRAGMA foreign_key_check')).results.length, 0);
  assert.equal((await search(db, 'gpu', { filters: { chip_vendor: 'NVIDIA' }, ranges: { length_mm: { max: 320 }, vram_gb: { min: 16 } } })).length, 1);
});

test('resync preserves local identifiers/enrichments; delete and reappearance retain product id', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  const original = product();
  const first = normalize('cpu', original, COMMIT);
  await syncSnapshot(db, snapshot([first]));
  const id = row(db, 'SELECT id FROM products').id;
  await addLocalIdentifier(db, { productId: id, type: 'jan', value: '0491234567890', evidence: 'Package checked', verifiedAt: '2026-09-12' });
  await setLocalEnrichment(db, { productId: id, namespace: 'spec', key: 'cooler_height_mm', value: 165, evidence: 'Measured', verifiedAt: '2026-09-12' });
  const changed = normalize('cpu', { ...original, identifiers: { version: 2, identifiers: [{ type: 'mpn', value: 'NEW-MPN', region: 'jp' }], retailer_listings: [] }, metadata: { ...original.metadata, part_numbers: [] }, specifications: { tdp: 65 } }, 'b'.repeat(40));
  assert.equal((await syncSnapshot(db, snapshot([changed]))).updated, 1);
  assert.equal(row(db, 'SELECT tdp_w FROM cpu').tdp_w, 65);
  assert.equal(count(db, 'upstream_identifiers'), 1);
  assert.equal(count(db, 'local_identifiers'), 1);
  assert.equal(count(db, 'local_enrichments'), 1);
  assert.equal((await search(db, 'cpu', { identifier: { value: '0491234567890', type: 'jan' } })).length, 1);
  assert.equal((await search(db, 'cpu', { keyword: '0491234567890' })).length, 1);
  assert.equal((await search(db, 'cpu', { keyword: 'NEW-MPN' })).length, 1);
  assert.equal((await search(db, 'cpu', { identifier: { value: '100-TEST' } })).length, 0);
  await syncSnapshot(db, snapshot([]), { maxDeleteFraction: 1 });
  assert.equal(row(db, 'SELECT active FROM products').active, 0);
  assert.equal((await search(db, 'cpu', { keyword: 'NEW-MPN' })).length, 0);
  assert.equal(count(db, 'local_enrichments'), 1);
  assert.equal((await syncSnapshot(db, snapshot([changed]))).reactivated, 1);
  assert.equal(row(db, 'SELECT id FROM products').id, id);
  assert.equal(count(db, 'local_identifiers'), 1);
});

test('no-change sync does not rewrite products, raw, identifiers or FTS', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  const records = [normalize('cpu', product(), COMMIT)];
  await syncSnapshot(db, snapshot(records));
  const before = db.sqlite.prepare('SELECT * FROM products').all();
  const unchanged = await syncSnapshot(db, snapshot(records));
  assert.equal(unchanged.unchanged, 1);
  assert.equal(unchanged.added + unchanged.updated + unchanged.deleted, 0);
  assert.deepEqual(db.sqlite.prepare('SELECT * FROM products').all(), before);
});

test('same upstream UUID in two categories remains two distinct identities', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  const d = product();
  await syncSnapshot(db, snapshot([normalize('case_fan', d, COMMIT), normalize('cpu_cooler', d, COMMIT)]));
  assert.equal(count(db, 'products'), 2);
  assert.equal(count(db, 'case_fan'), 1);
  assert.equal(count(db, 'cpu_cooler'), 1);
});

test('single statement rolls back product, hash, spec, identifiers and FTS on constraint failure', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  const d = product();
  const good = normalize('cpu', d, COMMIT);
  await syncSnapshot(db, snapshot([good]));
  const invalid = normalize('cpu', { ...d, metadata: { ...d.metadata, name: 'Replacement' } }, COMMIT);
  invalid.identifiers[0].region = null;
  await assert.rejects(syncSnapshot(db, snapshot([invalid])), /NOT NULL/);
  assert.equal(row(db, 'SELECT content_hash FROM products').content_hash, good.product.content_hash);
  assert.equal(row(db, 'SELECT raw_json FROM upstream_raw').raw_json, good.raw);
  assert.equal((await search(db, 'cpu', { keyword: '9800X3D' })).length, 1);
  assert.equal((await search(db, 'cpu', { keyword: 'Replacement' })).length, 0);
  assert.equal(count(db, 'ingest'), 0);
});

test('partial initial import resumes from D1 state and defers deletions until all updates finish', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  const old = normalize('cpu', product(), COMMIT);
  await syncSnapshot(db, snapshot([old]));
  const next = [normalize('cpu', product(), COMMIT), normalize('cpu', product(), COMMIT)];
  const partial = await syncSnapshot(db, snapshot(next), { maxProducts: 1, maxDeleteFraction: 1 });
  assert.equal(partial.status, 'partial');
  assert.equal(partial.deleted, 0);
  assert.equal(row(db, 'SELECT active FROM products WHERE upstream_key=?', old.product.upstream_key).active, 1);
  const finished = await syncSnapshot(db, snapshot(next), { maxDeleteFraction: 1 });
  assert.equal(finished.added, 1);
  assert.equal(finished.unchanged, 1);
  assert.equal(finished.deleted, 1);
  assert.equal(finished.status, 'complete');
});

test('dry-run and deletion guard do not mutate catalog', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  const snap = snapshot([normalize('cpu', product(), COMMIT)]);
  assert.equal((await syncSnapshot(db, snap, { dryRun: true })).status, 'dry-run');
  assert.equal(count(db, 'products'), 0);
  await syncSnapshot(db, snap);
  await assert.rejects(syncSnapshot(db, snapshot([])), /Deletion fraction/);
  assert.equal(row(db, 'SELECT active FROM products').active, 1);
});

test('write budget pauses before ingestion and the next run can complete', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  const snap = snapshot([normalize('cpu', product(), COMMIT)]);
  const partial = await syncSnapshot(db, snap, { writeBudget: 100 });
  assert.equal(partial.status, 'partial');
  assert.equal(partial.remaining, 1);
  assert.equal(count(db, 'products'), 0);
  assert.equal((await syncSnapshot(db, snap)).status, 'complete');
});

test('local identifier edit/delete updates FTS without changing upstream search', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  await syncSnapshot(db, snapshot([normalize('cpu', product(), COMMIT)]));
  const id = row(db, 'SELECT id FROM products').id;
  await assert.rejects(addLocalIdentifier(db, { productId: id, type: 'jan', value: '123' }), /evidence/);
  await addLocalIdentifier(db, { productId: id, type: 'mpn', value: 'LOCAL-ALPHA', evidence: 'Label' });
  assert.equal((await search(db, 'cpu', { keyword: 'LOCAL-ALPHA' })).length, 1);
  await db.query('UPDATE local_identifiers SET value=?,value_key=?', ['LOCAL-BETA', identifierKey('LOCAL-BETA')]);
  assert.equal((await search(db, 'cpu', { keyword: 'LOCAL-ALPHA' })).length, 0);
  assert.equal((await search(db, 'cpu', { keyword: 'LOCAL-BETA' })).length, 1);
  await db.query('DELETE FROM local_identifiers');
  assert.equal((await search(db, 'cpu', { keyword: 'LOCAL-BETA' })).length, 0);
  assert.equal((await search(db, 'cpu', { keyword: '9800X3D' })).length, 1);
});

test('a live lease rejects another writer and expired leases cannot ingest', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  await db.query("INSERT INTO sync_lock VALUES(1,'other',unixepoch()+900)");
  const records = [normalize('cpu', product(), COMMIT)];
  await assert.rejects(syncSnapshot(db, snapshot(records)), /Another sync/);
  assert.equal(row(db, 'SELECT owner FROM sync_lock').owner, 'other');
  await db.query('UPDATE sync_lock SET expires_at=0');
  const statement = ingestionStatement(records, 'other');
  await db.query(statement.sql, statement.params);
  assert.equal(count(db, 'products'), 0);
  await syncSnapshot(db, snapshot(records));
  assert.equal(count(db, 'products'), 1);
});

test('combined min/max and multi-selection filters have inclusive boundaries and exclude unknowns', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  await syncSnapshot(db, snapshot([249,250,300,320,321,null].map(length => normalize('gpu', product({ length, memory: 16, chipset_manufacturer: 'NVIDIA', chipset: 'GeForce RTX 5080' }), COMMIT))));
  const base = { keyword: 'RTX 5080', filters: { chip_vendor: ['NVIDIA','AMD'] } };
  assert.equal((await search(db, 'gpu', { ...base, ranges: { length_mm: { min: 250, max: 320 } } })).length, 3);
  assert.equal((await search(db, 'gpu', { ...base, ranges: { length_mm: { min: 250 } } })).length, 4);
  assert.equal((await search(db, 'gpu', { ...base, ranges: { length_mm: { max: 300 } } })).length, 3);
});

test('identifier keys preserve leading zeros, punctuation and internal whitespace', () => {
  assert.equal(identifierKey('  ab-012  x  '), 'AB-012  X');
  assert.equal(identifierKey('0012345678901'), '0012345678901');
  assert.notEqual(identifierKey('AB-123'), identifierKey('AB123'));
});

test('query builder rejects SQL/FTS injection and invalid ranges/parameters', () => {
  assert.throws(() => searchQuery('cpu;DROP TABLE products'), /Unknown category/);
  assert.throws(() => searchQuery('__proto__'), /Unknown category/);
  assert.throws(() => searchQuery('gpu', { orderBy: 'length_mm;DROP TABLE products' }), /Unknown/);
  assert.throws(() => searchQuery('cpu', { ranges: { core_count: { min: 9, max: 8 } } }), /min > max/);
  assert.throws(() => searchQuery('cpu', { ranges: { core_count: { min: null } } }), /Invalid range/);
  assert.throws(() => searchQuery('cpu', { filters: { core_count: '8' } }), /Invalid value/);
  assert.throws(() => keywordExpression('***'), /tokens/);
  assert.equal(keywordExpression('RTX " OR 5080'), '"RTX"* AND "OR"* AND "5080"*');
  const q = searchQuery('cpu', { filters: { manufacturer: "x' OR 1=1 --" } });
  assert(!q.sql.includes('OR 1=1'));
  assert(q.params.includes("x' OR 1=1 --"));
});
