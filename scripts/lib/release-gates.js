import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { remoteDatabaseId } from '../../src/remote-config.js';
import { validateProtectionConfig } from '../../src/search-protection.js';
import { CACHE_SCHEMA_GENERATION } from '../../src/search-cache.js';
import { NORMALIZER_VERSION, categories, models } from '../../src/model.js';
import { catalogState, assertCatalogState, loadQualityCatalog } from '../../src/quality/catalog.js';
import { loadUXFixture, evaluateUX, qualityFailures, sourceCatalog } from '../../src/quality/ux.js';
import { loadSnapshot } from '../../src/upstream.js';
import { verifySourceCatalog } from '../../src/quality/integrity.js';
import { ftsIntegrity } from './fts-integrity.js';
import { verifyPlans } from '../../src/queries.js';

export const FTS_GENERATION = 8;
export function productionConfig(config, env = process.env) {
  remoteDatabaseId(config);
  validateProtectionConfig(config);
  assert(!env.CLOUDFLARE_D1_DATABASE_ID || env.CLOUDFLARE_D1_DATABASE_ID === remoteDatabaseId(config), 'D1 override differs from production binding');
  assert(!env.CLOUDFLARE_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID === config.account_id, 'Account override differs from production');
  return config;
}
export function cacheEpoch(sync, fts = FTS_GENERATION, schema = CACHE_SCHEMA_GENERATION) {
  assert.equal(sync?.status, 'complete', 'Epoch requires complete sync');
  assert.match(sync.id, /^[a-f0-9-]{36}$/);
  const value = `sync-${sync.id}-fts${fts}-cache${schema.replace(/^v/, '')}`;
  assert.match(value, /^[a-zA-Z0-9_-]{1,100}$/);
  return value;
}

// Only SELECT/EXPLAIN/explicit read-only PRAGMAs are retried. SQL and provider
// error bodies never escape this administrative adapter.
export function safeDatabase(db) {
  return { ...db, async query(sql, params = []) {
    const read = /^(SELECT|WITH|EXPLAIN)\b/i.test(sql.trim()) || /^PRAGMA (foreign_key_check|table_info\(|quick_check)/i.test(sql.trim());
    for (let attempt = 0; ; attempt++) {
      try { return await db.query(sql, params); }
      catch {
        if (!read || attempt === 2) throw new Error(`D1 ${read ? 'read' : 'write'} failed; inspect service status and retry the pinned release`);
        await delay(1000 * 2 ** attempt);
      }
    }
  } };
}

export async function migrationGate(db) {
  const expected = (await readdir('migrations')).filter(f => f.endsWith('.sql')).sort();
  const applied = (await db.query('SELECT name FROM d1_migrations ORDER BY name')).results.map(r => r.name);
  assert.deepEqual(applied, expected, 'Migration history differs; apply reviewed migrations separately');
}

export async function readiness(db, { commit, expectedCounts } = {}) {
  await migrationGate(db);
  const sync = await catalogState(db);
  assert.equal(sync?.status, 'complete', 'Latest sync must be complete');
  assert(sync.finished_at && Number.isFinite(Date.parse(sync.finished_at)), 'Completed timestamp missing');
  assert.equal(sync.normalization_version, NORMALIZER_VERSION, 'Normalizer generation differs');
  if (commit) assert.equal(sync.source_commit, commit, 'Unexpected completed snapshot');
  assert.equal((await db.query("SELECT count(*) AS n FROM sync_runs WHERE status='running'")).results[0].n, 0, 'Unfinalized writer');
  // Historical failed/partial runs are retained as an audit trail; a later
  // complete sync supersedes them. No failed/partial latest run can pass.
  assert.equal((await db.query('SELECT count(*) AS n FROM sync_lock WHERE owner<>?', [db.releaseOwner ?? ''])).results[0].n, 0, 'Residual sync lease (including expired lease)');
  assert.equal((await db.query('PRAGMA foreign_key_check')).results.length, 0, 'Foreign key violation');
  assert.deepEqual((await db.query('PRAGMA quick_check')).results.map(r => r.quick_check), ['ok'], 'SQLite integrity failure');
  assert.equal((await db.query('SELECT count(*) AS n FROM ingest')).results[0].n, 0, 'Unfinished ingestion');
  const counts = Object.fromEntries((await db.query('SELECT category,count(*) AS n FROM products WHERE active=1 GROUP BY category')).results.map(r => [r.category, r.n]));
  const active = Object.values(counts).reduce((a, b) => a + b, 0);
  assert(active >= 20000 && active <= 100000, 'Active count outside reviewed production envelope (20000–100000)');
  for (const category of categories) {
    assert(counts[category] > 0, 'Empty product category');
    if (expectedCounts) assert.equal(counts[category], expectedCounts[category], 'Active count differs from validated snapshot');
    const table = models[category].table;
    const columns = (await db.query(`PRAGMA table_info(${table})`)).results.map(r => r.name);
    assert(Object.keys(models[category].fields).every(field => columns.includes(field)), 'Typed schema/model mismatch');
    assert.equal((await db.query(`SELECT count(*) AS n FROM products p LEFT JOIN ${table} s ON s.product_id=p.id WHERE p.category=? AND s.product_id IS NULL`, [category])).results[0].n, 0, 'Missing typed spec');
    assert.equal((await db.query(`SELECT count(*) AS n FROM ${table} s LEFT JOIN products p ON p.id=s.product_id WHERE p.id IS NULL OR p.category<>?`, [category])).results[0].n, 0, 'Orphan or wrong-category spec');
  }
  const integrity = await ftsIntegrity(db);
  assert(integrity.pass, 'Category FTS integrity failed');
  assert.equal((await db.query('SELECT count(*) AS n FROM products p LEFT JOIN upstream_raw r ON r.product_id=p.id WHERE r.product_id IS NULL')).results[0].n, 0, 'Missing upstream raw');
  await assertCatalogState(db, sync);
  return { sync, active, counts, fts:integrity, cache_epoch: cacheEpoch(sync) };
}

// Intent-specific floors, not exact rank/fingerprint invariance.
export function assertGolden(report) {
  assert.deepEqual(qualityFailures(report), [], 'UX release gate failed');
}
export async function searchGate(db) {
  const plans = await verifyPlans(db);
  const catalog = await loadQualityCatalog(db);
  const { fixture, hash } = await loadUXFixture();
  const snapshot=await loadSnapshot();
  assert.equal(snapshot.commit,catalog.metadata.last_sync?.source_commit,'Evaluation snapshot differs');
  const sourceIntegrity=await verifySourceCatalog(db,catalog,snapshot);
  assert(sourceIntegrity.pass,'Source catalog integrity failed');
  const report = await evaluateUX(db, catalog, fixture, { fixtureHash: hash,source:sourceCatalog(snapshot,catalog) });
  const budgets=process.env.PERFORMANCE_BUDGET_FILE?JSON.parse(await readFile(process.env.PERFORMANCE_BUDGET_FILE,'utf8')):{};
  report.release_failures=qualityFailures(report,{budgets});
  report.diagnostic_commands=[...new Set(report.release_failures.map(f=>f.split(':')[0]))].filter(id=>report.results.some(r=>r.id===id)).map(id=>`npm run diagnose:search -- --case ${id}`);
  report.source_integrity=sourceIntegrity;
  report.plans=plans;
  await writeFile('.cache/release-ux-report.json',JSON.stringify(report,null,2)+'\n');
  for(const command of report.diagnostic_commands)console.log(command);
  assert(plans.length > 0 && plans.every(r => r.index_check), 'Query plan gate failed');
  assert.deepEqual(report.release_failures,[],'UX release gate failed');
  return { golden: report.by_intent, plans: plans.length };
}

export async function releaseIdentity(config, epoch) {
  const hash = createHash('sha256').update(JSON.stringify({ ...config, env: undefined, vars: { ...config.vars, CATALOG_CACHE_EPOCH: epoch } }));
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await visit(file);
      else hash.update(file).update(await readFile(file));
    }
  }
  await visit('src');
  hash.update(await readFile('package-lock.json'));
  return `release-${hash.digest('hex').slice(0, 32)}`;
}

export async function withReleaseLease(db, operation) {
  const owner = randomUUID();
  const acquired = await db.query('INSERT INTO sync_lock(id,owner,expires_at) VALUES(1,?,unixepoch()+900) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE sync_lock.expires_at<=unixepoch() RETURNING owner', [owner]);
  assert.equal(acquired.results[0]?.owner, owner, 'Writer holds catalog lease');
  let lost = false, pending = Promise.resolve();
  const renew = async () => {
    assert(!lost, 'Release lease lost');
    try {
      const row = await db.query('UPDATE sync_lock SET expires_at=unixepoch()+900 WHERE id=1 AND owner=? AND expires_at>unixepoch() RETURNING owner', [owner]);
      assert.equal(row.results[0]?.owner, owner, 'Release lease lost');
    } catch { lost = true; throw new Error('Release lease renewal failed'); }
  };
  const timer = setInterval(() => { pending = pending.then(renew).catch(() => { lost = true; }); }, 60_000);
  try { return await operation({ ...db, releaseOwner: owner }, renew); }
  finally {
    clearInterval(timer);
    await pending;
    await db.query('DELETE FROM sync_lock WHERE id=1 AND owner=?', [owner]);
  }
}
