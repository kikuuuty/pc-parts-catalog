// Explicit one-off transition commands. Capture is read-only; seed/sync refuse
// the retained production UUID. No command silently retries a write.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { openDatabase } from '../src/database.js';
import { cloudflareRelease } from './lib/cloudflare-release.js';
import { safeDatabase, readiness } from './lib/release-gates.js';
import { loadSnapshot } from '../src/upstream.js';
import { syncSnapshot } from '../src/sync.js';

export const retainedDatabase = '180175e0-edc0-49df-a9d7-5958d5982e8f';
const snapshotCommit = 'eec0df175504ebd15f0f3e3a8249a18a22f00940';
const command = process.argv[2];
const config = JSON.parse(await readFile('wrangler.json', 'utf8'));
const target = process.env.CLOUDFLARE_D1_DATABASE_ID || config.d1_databases[0].database_id;
assert(['capture', 'seed', 'sync', 'integrity'].includes(command));
if (['seed', 'sync'].includes(command)) {
  assert.notEqual(target, retainedDatabase, 'Never rebuild retained production');
  assert.notEqual(target, config.d1_databases[0].database_id, 'Never rebuild configured production');
}
const db = safeDatabase(await openDatabase(true));
const rows = async (sql, params = []) => (await db.query(sql, params)).results;
try {
  if (command === 'capture') {
    assert.equal(target, retainedDatabase);
    const before = await rows('SELECT * FROM sync_runs ORDER BY started_at DESC,id DESC LIMIT 1');
    const backup = { captured_at: new Date().toISOString(), database: target,
      worker: await (await cloudflareRelease(config)).current(),
      migrations: await rows('SELECT * FROM d1_migrations ORDER BY name'),
      sync_runs: await rows('SELECT * FROM sync_runs ORDER BY started_at'),
      leases: await rows('SELECT * FROM sync_lock'),
      sources: await rows('SELECT * FROM sources'),
      local_identifiers: await rows('SELECT * FROM local_identifiers'),
      local_enrichments: await rows('SELECT * FROM local_enrichments'),
      fts: await rows("SELECT name,sql FROM sqlite_schema WHERE sql LIKE 'CREATE VIRTUAL TABLE%fts5%'") };
    backup.products = [];
    for (let id = 0;;) {
      const page = await rows('SELECT * FROM products WHERE id>? ORDER BY id LIMIT 1000', [id]);
      if (!page.length) break;
      backup.products.push(...page); id = page.at(-1).id;
    }
    backup.counts = await rows('SELECT category,active,count(*) AS n FROM products GROUP BY category,active');
    backup.http = [];
    for (const path of ['/v1/health', '/v1/categories', '/v1/search?category=cpu&q=9800X3D', '/v1/products/1']) {
      const response = await fetch(`https://pc-parts-catalog.kikuuuty.workers.dev${path}`);
      backup.http.push({ path, status: response.status, body: await response.json() });
    }
    assert.deepEqual(await rows('SELECT * FROM sync_runs ORDER BY started_at DESC,id DESC LIMIT 1'), before);
    assert.equal(backup.leases.length, 0);
    await writeFile('.cache/transition-before.json', JSON.stringify(backup, null, 2) + '\n');
    console.log(JSON.stringify({ database: target, worker: backup.worker, migrations: backup.migrations, products: backup.products.length, counts: backup.counts, sync: before, local_identifiers: backup.local_identifiers.length, local_enrichments: backup.local_enrichments.length, http: backup.http.map(r => ({ path: r.path, status: r.status, categories: r.body.data?.length })) }, null, 2));
  }
  if (command === 'seed') {
    const backup = JSON.parse(await readFile('.cache/transition-before.json', 'utf8'));
    // A nonempty local overlay needs an explicit restore/reconciliation, never omission.
    assert.equal(backup.local_identifiers.length, 0);
    assert.equal(backup.local_enrichments.length, 0);
    assert(backup.products.every(p => p.source === 'buildcores' && p.active === 1));
    assert.equal((await rows('SELECT count(*) AS n FROM products'))[0].n, 0, 'Seed only an empty isolated catalog');
    const columns = Object.keys(backup.products[0]);
    assert(columns.every(c => /^[a-z_]+$/.test(c)));
    for (let offset = 0; offset < backup.products.length; offset += 100) {
      const page = backup.products.slice(offset, offset + 100).map(p => ({ ...p, content_hash: 'transition-rebuild-required' }));
      await db.query(`INSERT INTO products(${columns.join(',')}) SELECT ${columns.map(c => `json_extract(value,'$.${c}')`).join(',')} FROM json_each(?)`, [JSON.stringify(page)]);
    }
    console.log(JSON.stringify({ seeded: backup.products.length, identity: 'IDs preserved; every record requires normal ingestion' }));
  }
  if (command === 'sync') {
    const snapshot = await loadSnapshot();
    assert.equal(snapshot.commit, snapshotCommit);
    const report = await syncSnapshot(db, snapshot, { maxProducts: 50000, writeBudget: 5000000, reuseComplete: true });
    await writeFile('.cache/transition-sync.json', JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
    assert.equal(report.status, 'complete');
  }
  if (command === 'integrity') {
    const snapshot = await loadSnapshot();
    assert.equal(snapshot.commit, snapshotCommit);
    const counts = Object.fromEntries(Object.entries(snapshot.report.categories).map(([k, v]) => [k, v.count]));
    const report = await readiness(db, { commit: snapshotCommit, expectedCounts: counts });
    const backup = JSON.parse(await readFile('.cache/transition-before.json', 'utf8'));
    let stable = 0;
    for (let offset = 0; offset < backup.products.length; offset += 500) {
      const old = backup.products.slice(offset, offset + 500);
      const current = await rows('SELECT p.id,p.source,p.upstream_key FROM products p JOIN json_each(?) j ON p.id=json_extract(j.value,\'$.id\')', [JSON.stringify(old.map(({ id }) => ({ id })))]);
      assert.deepEqual(current.sort((a,b) => a.id-b.id), old.map(({id,source,upstream_key}) => ({id,source,upstream_key})));
      stable += current.length;
    }
    const sequence = await rows('SELECT high_water,(SELECT max(id) FROM products) AS max_id FROM product_id_sequence');
    assert.equal(sequence.length, 1); assert(sequence[0].high_water >= sequence[0].max_id);
    Object.assign(report, { database: target, stable_ids: stable, sequence });
    await writeFile('.cache/transition-integrity.json', JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ active: report.active, fts: report.fts.pass, stable_ids: stable, sequence, cache_epoch: report.cache_epoch }));
  }
} finally { await db.close(); }
