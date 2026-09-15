import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { openDatabase } from '../src/database.js';
import { defaultRepo, loadSnapshot } from '../src/upstream.js';
import { models } from '../src/model.js';
import { syncSnapshot } from '../src/sync.js';
import { searchQuery } from '../src/queries.js';
import { readiness } from './lib/release-gates.js';
import { captureProjection, compareProjection } from './lib/fts-verification.js';

const { values: args } = parseArgs({ options: {
  repo: { type: 'string', default: defaultRepo }, output: { type: 'string', default: '.cache/all-categories-verification.json' },
} });
// Intentionally local-only: this validation includes a real no-change sync.
const snapshot = await loadSnapshot(args.repo);
console.log(`Validated ${snapshot.records.length} records in ${Object.keys(models).length} categories.`);
const db = await openDatabase(false);
try {
  const expectedCounts = Object.fromEntries(Object.entries(snapshot.report.categories).map(([c, r]) => [c, r.count]));
  const ready = await readiness(db, { commit: snapshot.commit, expectedCounts });
  console.log('Release readiness and projection checks passed. Comparing stored rows to upstream.');
  const rows = async (sql, params = []) => (await db.query(sql, params)).results;
  const count = async (sql, params = []) => (await rows(sql, params))[0].n;
  const categories = {};
  for (const [category, model] of Object.entries(models)) {
    const records = snapshot.records.filter(r => r.product.category === category);
    const expected = new Map(records.map(r => [r.product.upstream_key, r]));
    const stats = {
      upstream_json: records.length, validation_success: snapshot.report.categories[category].validated,
      active_products: ready.counts[category], spec_rows: await count(`SELECT count(*) AS n FROM ${model.table}`),
      active_spec_rows: await count(`SELECT count(*) AS n FROM ${model.table} s JOIN products p ON p.id=s.product_id WHERE p.active=1 AND p.category=?`, [category]),
      identifiers: await count('SELECT count(*) AS n FROM upstream_identifiers i JOIN products p ON p.id=i.product_id WHERE p.category=?', [category]),
      active_identifiers: await count('SELECT count(*) AS n FROM upstream_identifiers i JOIN products p ON p.id=i.product_id WHERE p.active=1 AND p.category=?', [category]),
      missing_specs: await count(`SELECT count(*) AS n FROM products p LEFT JOIN ${model.table} s ON s.product_id=p.id WHERE p.category=? AND s.product_id IS NULL`, [category]),
      orphan_specs: await count(`SELECT count(*) AS n FROM ${model.table} s LEFT JOIN products p ON p.id=s.product_id WHERE p.id IS NULL OR p.category<>?`, [category]),
      raw_bytes: await count('SELECT coalesce(sum(length(CAST(r.raw_json AS BLOB))),0) AS n FROM upstream_raw r JOIN products p ON p.id=r.product_id WHERE p.category=?', [category]),
      normalized_rows_verified: 0,
    };
    // Inactive upstream removals retain identity/raw/spec rows by design. Compare
    // the current snapshot to active rows, while reporting all retained storage.
    assert.equal(stats.active_identifiers, records.reduce((n, r) => n + r.identifiers.length, 0));
    assert.equal(stats.missing_specs, 0); assert.equal(stats.orphan_specs, 0);
    assert.equal(stats.active_spec_rows, records.length);
    let cursor = 0;
    while (true) {
      const page = await rows(`SELECT p.id,p.upstream_key,p.content_hash,r.raw_json,s.* FROM products p
        LEFT JOIN upstream_raw r ON r.product_id=p.id LEFT JOIN ${model.table} s ON s.product_id=p.id
        WHERE p.active=1 AND p.category=? AND p.id>? ORDER BY p.id LIMIT 250`, [category, cursor]);
      if (!page.length) break;
      for (const row of page) {
        const source = expected.get(row.upstream_key);
        assert(source, `Unexpected identity ${row.upstream_key}`);
        assert.equal(row.content_hash, source.product.content_hash);
        assert.equal(row.raw_json, source.raw, `Raw mismatch ${row.upstream_key}`);
        assert.equal(row.product_id, row.id);
        for (const [field, value] of Object.entries(source.spec)) assert.equal(row[field], value, `${row.upstream_key}.${field}`);
        stats.normalized_rows_verified++;
      }
      cursor = page.at(-1).id;
    }
    assert.equal(stats.normalized_rows_verified, records.length);
    // Real upstream samples (synthetic all-identifier-type coverage is in tests).
    const candidate = records.find(r => r.identifiers.length && r.product.name.length <= 200 && (r.product.name.match(/[\p{L}\p{N}]+/gu)?.length ?? 0) <= 12);
    assert(candidate, `No real keyword/identifier sample: ${category}`);
    const query = async options => { const q = searchQuery(category, options); return rows(q.sql, q.params); };
    const keyword = await query({ keyword: candidate.product.name, limit: 100 });
    assert(keyword.some(r => r.upstream_key === candidate.product.upstream_key), `Keyword sample missing: ${category}`);
    const identifier = candidate.identifiers[0];
    const exact = await query({ identifier: { type: identifier.type, value: identifier.value }, limit: 100 });
    assert(exact.some(r => r.upstream_key === candidate.product.upstream_key), `Identifier sample missing: ${category}`);
    stats.search_sample = { upstream_key: candidate.product.upstream_key, name: candidate.product.name, identifier: { type: identifier.type, value: identifier.value }, keyword: 'pass', identifier_search: 'pass' };
    categories[category] = stats;
    console.log(`${category}: ${stats.normalized_rows_verified} raw/spec rows verified; keyword + identifier pass.`);
  }
  const integrity = {
    foreign_key_check: await rows('PRAGMA foreign_key_check'), quick_check: await rows('PRAGMA quick_check'),
    missing_raw: await count('SELECT count(*) AS n FROM products p LEFT JOIN upstream_raw r ON r.product_id=p.id WHERE r.product_id IS NULL'),
    duplicate_upstream_keys: await rows('SELECT source,upstream_key,count(*) AS n FROM products GROUP BY source,upstream_key HAVING count(*)>1'),
    cross_category_uuids: snapshot.report.cross_category_ids.length,
  };
  assert.equal(integrity.missing_raw, 0); assert.deepEqual(integrity.duplicate_upstream_keys, []);
  const before = await captureProjection(db);
  console.log('Captured catalog fingerprints; verifying no-change sync.');
  let ingestStatements = 0;
  const repeat = await syncSnapshot({ ...db, async query(sql, params) {
    if (/^INSERT INTO ingest/.test(sql)) ingestStatements++;
    return db.query(sql, params);
  } }, snapshot);
  const after = await captureProjection(db);
  console.log('Captured post-sync fingerprints.');
  const diff = compareProjection(before, after);
  assert.equal(repeat.unchanged, snapshot.records.length); assert.equal(ingestStatements, 0);
  assert.deepEqual(diff.data_changed_tables.filter(t => t !== 'sync_runs'), []);
  assert.equal(diff.fts_difference_count, 0);
  const totals = {
    products: await count('SELECT count(*) AS n FROM products'), active_products: ready.active,
    identifiers: await count('SELECT count(*) AS n FROM identifiers'),
    upstream_identifiers: await count('SELECT count(*) AS n FROM upstream_identifiers'),
    local_identifiers: await count('SELECT count(*) AS n FROM local_identifiers'),
    fts: await count('SELECT (SELECT count(*) FROM product_fts)+(SELECT count(*) FROM extended_product_fts) AS n'),
    legacy_fts: await count('SELECT count(*) AS n FROM product_fts'),
    extended_fts: await count('SELECT count(*) AS n FROM extended_product_fts'),
    size_bytes: after.size_bytes,
    raw_bytes: Object.values(categories).reduce((n, r) => n + r.raw_bytes, 0),
  };
  const report = { commit: snapshot.commit, coverage: snapshot.report.coverage, categories, totals, integrity,
    resync: { ...repeat, ingest_statements: ingestStatements, changed_data_tables: diff.data_changed_tables.filter(t => t !== 'sync_runs'), fts_differences: diff.fts_difference_count } };
  await writeFile(args.output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output: args.output, totals, integrity, resync: report.resync }, null, 2));
} finally { await db.close(); }
