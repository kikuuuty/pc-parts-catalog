import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { database } from '../test-support/database.js';
import { normalize } from '../src/normalize.js';
import { syncSnapshot } from '../src/sync.js';
import { loadQualityCatalog } from '../src/quality/catalog.js';
import { verifySourceCatalog } from '../src/quality/integrity.js';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { captureProjection, compareProjection } from '../scripts/lib/fts-verification.js';
import { sourceIntegrityGate } from '../scripts/lib/source-integrity-gate.js';
import { searchGate, cacheEpoch } from '../scripts/lib/release-gates.js';

const A = 'eec0df175504ebd15f0f3e3a8249a18a22f00940';
const B = '07e5be1dad48b1913a90a1b6f34e702cce3c475a';
const snapshot = (commit, changed = false) => ({ commit, records: Array.from({ length: 10 }, (_, n) => normalize('keyboard', {
  opendb_id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`,
  metadata: { name: `Keyboard ${n}${changed && n === 0 ? ' updated' : ''}`, manufacturer: 'Example', part_numbers: [`KEY-${n}`] },
  switch_type: 'Linear', polling_rate: 1000, hot_swappable: true, connectivity: ['Bluetooth'],
}, commit)) });

test('cross-commit incremental sync preserves row provenance but source integrity accepts current content', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  await syncSnapshot(db, snapshot(A));
  await delay(5);
  const next = snapshot(B, true);
  const result = await syncSnapshot(db, next);
  assert.equal(result.updated, 1); assert.equal(result.unchanged, 9);
  const catalog = await loadQualityCatalog(db);
  assert.equal(catalog.products[0].source_commit, B);
  assert(catalog.products.slice(1).every(p => p.source_commit === A));
  assert.equal(catalog.metadata.last_sync.source_commit, B);
  assert.equal(catalog.metadata.last_sync.status, 'complete');
  assert.deepEqual([...new Set(next.records.flatMap((r, i) => Object.entries(r.product).filter(([k, v]) => catalog.products[i][k] !== v).map(([k]) => k)))], ['source_commit']);
  const integrity = await verifySourceCatalog(db, catalog, next);
  assert.equal(integrity.pass, true, JSON.stringify(integrity));
});

test('commit-only changes write no product projection, same-snapshot retry reuses sync ID and epoch', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  await syncSnapshot(db, snapshot(A));
  const before = await captureProjection(db);
  await delay(5);
  let ingests = 0;
  const counted = { ...db, async query(sql, params) { if (/^INSERT INTO ingest/.test(sql)) ingests++; return db.query(sql, params); } };
  const result = await syncSnapshot(counted, snapshot(B), { reuseComplete: true });
  assert.equal(result.unchanged, 10); assert.equal(result.updated, 0); assert.equal(ingests, 0);
  const after = await captureProjection(db), diff = compareProjection(before, after);
  assert.deepEqual(diff.data_changed_tables, ['sync_runs']); assert.equal(diff.fts_difference_count, 0);
  const catalog = await loadQualityCatalog(db);
  assert(catalog.products.every(p => p.source_commit === A));
  assert.equal(catalog.metadata.last_sync.source_commit, B);
  assert((await verifySourceCatalog(db, catalog, snapshot(B))).pass);
  const retry = await syncSnapshot(counted, snapshot(B), { reuseComplete: true });
  assert.equal(retry.reused, true); assert.equal(retry.run_id, result.run_id); assert.equal(ingests, 0);
  const current = await loadQualityCatalog(db);
  assert.equal(cacheEpoch(current.metadata.last_sync), cacheEpoch(catalog.metadata.last_sync));
});

test('add/inactivate/reactivate retains local data and strict current-source content', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  const a = snapshot(A); await syncSnapshot(db, a);
  db.sqlite.exec("INSERT INTO local_identifiers(product_id,type,value,value_key,evidence) VALUES(1,'mpn','LOCAL-1','LOCAL-1','local evidence'); INSERT INTO local_enrichments(product_id,namespace,key,value_json,evidence) VALUES(1,'local','note','true','local evidence')");
  const b = snapshot(B); b.records.shift();
  b.records.push(normalize('keyboard', { opendb_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', metadata: { name: 'Added' } }, B));
  await delay(5);
  const changed = await syncSnapshot(db, b);
  assert.equal(changed.added, 1); assert.equal(changed.deleted, 1);
  assert((await verifySourceCatalog(db, await loadQualityCatalog(db), b)).pass);
  const c = { commit: A, records: [...a.records, b.records.at(-1)] };
  await delay(5);
  assert.equal((await syncSnapshot(db, c)).reactivated, 1);
  assert.equal((await db.query('SELECT count(*) n FROM local_identifiers')).results[0].n, 1);
  assert.equal((await db.query('SELECT count(*) n FROM local_enrichments')).results[0].n, 1);
  assert((await verifySourceCatalog(db, await loadQualityCatalog(db), c)).pass);
});

for (const [kind, field, sql] of [
  ['product_field', 'content_hash', "UPDATE products SET content_hash='broken' WHERE id=1"],
  ['product_field', 'name', "UPDATE products SET name='PRIVATE_CANARY' WHERE id=1"],
  ['product_field', 'normalization_version', 'UPDATE products SET normalization_version=99 WHERE id=1'],
  ['raw', null, `UPDATE upstream_raw SET raw_json='{"secret":"PRIVATE_CANARY"}' WHERE product_id=1`],
  ['specs', 'polling_rate_hz', 'UPDATE keyboard SET polling_rate_hz=3 WHERE product_id=1'],
  ['identifiers', null, 'DELETE FROM upstream_identifiers WHERE product_id=1'],
  ['facets', null, 'DELETE FROM product_facets WHERE product_id=1'],
  ['missing_active', null, 'UPDATE products SET active=0 WHERE id=1'],
]) test(`source integrity detects ${kind}.${field ?? ''} even with unchanged content hash`, async t => {
  const db = database(); t.after(() => db.sqlite.close()); const source = snapshot(A);
  await syncSnapshot(db, source); db.sqlite.exec(sql);
  const report = await verifySourceCatalog(db, await loadQualityCatalog(db), source);
  assert.equal(report.pass, false); assert(report.by_kind[kind] > 0);
  assert(report.details.some(d => d.kind === kind && d.field === field && d.upstream_key === source.records[0].product.upstream_key));
  assert(!JSON.stringify(report).includes('PRIVATE_CANARY'));
});

test('unexpected active records and bounded samples never mask mismatch totals', async t => {
  const db = database(); t.after(() => db.sqlite.close()); const source = snapshot(A);
  await syncSnapshot(db, source);
  db.sqlite.exec("UPDATE products SET name='PRIVATE_CANARY',normalization_version=9");
  const catalog = await loadQualityCatalog(db);
  const report = await verifySourceCatalog(db, catalog, source, { sampleLimit: 2 });
  assert.equal(report.mismatch_count, 20); assert.deepEqual(report.product_fields, { name: 10, normalization_version: 10 });
  assert.equal(report.details.length, 2); assert.equal(report.omitted, 18); assert(report.truncated); assert(!report.pass);
  const zero = await verifySourceCatalog(db, catalog, source, { sampleLimit: 0 });
  assert.equal(zero.errors.length, 0); assert.equal(zero.mismatch_count, 20); assert(!zero.pass);
  assert(!JSON.stringify(report).includes('PRIVATE_CANARY'));
  const unexpected = await verifySourceCatalog(db, catalog, { ...source, records: source.records.slice(1) });
  assert.equal(unexpected.by_kind.unexpected_active, 1);
});

test('release saves source failures and snapshot mismatch before stopping; later phases remain not_run', async t => {
  const db = database(); t.after(() => db.sqlite.close()); const source = snapshot(A);
  await syncSnapshot(db, source);
  await mkdir('.cache', { recursive: true }); const directory = await mkdtemp('.cache/source-gate-test-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'release-ux-report.json'), sourceOutput = path.join(directory, 'release-source-integrity.json');
  const load = file => readFile(file, 'utf8').then(JSON.parse);
  db.sqlite.exec("UPDATE products SET content_hash='PRIVATE_CANARY' WHERE id=1");
  await assert.rejects(searchGate(db, { snapshot: source, output }), /Source catalog integrity failed/);
  assert.equal((await load(sourceOutput)).product_fields.content_hash, 1);
  assert.deepEqual((await load(output)).phases, { source_integrity: 'failed', filter_metadata: 'not_run', search_quality: 'not_run', query_plans: 'not_run' });
  assert(!(await readFile(output, 'utf8')).includes('PRIVATE_CANARY'));
  await assert.rejects(sourceIntegrityGate(db, await loadQualityCatalog(db), snapshot(B), sourceOutput), /Evaluation snapshot differs/);
  assert.equal((await load(sourceOutput)).failure, 'Evaluation snapshot differs');
  assert.equal((await load(sourceOutput)).sync.source_commit, A);
});

test('read exceptions save partial diagnostics; report write errors do not replace the read error', async t => {
  const db = database(); t.after(() => db.sqlite.close()); const source = snapshot(A);
  await syncSnapshot(db, source); const catalog = await loadQualityCatalog(db);
  await mkdir('.cache', { recursive: true }); const directory = await mkdtemp('.cache/source-read-test-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'source.json'), original = new Error('PRIVATE_CANARY provider/SQL');
  const broken = { query: async () => { throw original; } };
  await assert.rejects(sourceIntegrityGate(broken, catalog, source, output), error => error === original);
  const report = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(report.status, 'failed'); assert.equal(report.products_checked, 10); assert(!report.pass);
  assert(!JSON.stringify(report).includes('PRIVATE_CANARY'));
  await assert.rejects(sourceIntegrityGate(broken, catalog, source, path.join(directory, 'missing', 'report.json')), error => error === original && error.reportSaveFailed);
});

test('Filter failure stops publication after saved diagnostics; search/plans remain not_run', async t => {
  const db = database(); t.after(() => db.sqlite.close()); const source = snapshot(A); await syncSnapshot(db, source);
  await mkdir('.cache', { recursive: true }); const directory = await mkdtemp('.cache/filter-phase-test-');
  t.after(() => rm(directory, { recursive: true, force: true })); const output = path.join(directory, 'release-ux-report.json');
  const wrong = { ...db, async query(sql, params) {
    const r = await db.query(sql, params);
    if (sql.startsWith('SELECT json_group_array') && params[0] === 'cpu') r.results[0].manufacturer = '["Unexpected"]';
    return r;
  } };
  await assert.rejects(searchGate(wrong, { snapshot: source, output }), /Source options differ/);
  const report = JSON.parse(await readFile(output, 'utf8'));
  assert.deepEqual(report.phases, { source_integrity: 'passed', filter_metadata: 'failed', search_quality: 'not_run', query_plans: 'not_run' });
  const filter = JSON.parse(await readFile(path.join(directory, 'release-filter-metadata.json'), 'utf8'));
  assert.equal(filter.status, 'failed'); assert.equal(filter.categories[0].failure.field, 'manufacturer');
});
