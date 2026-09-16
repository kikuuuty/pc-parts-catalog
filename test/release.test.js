import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { database } from '../test-support/database.js';
import { normalize } from '../src/normalize.js';
import { syncSnapshot } from '../src/sync.js';
import { catalogState } from '../src/quality/catalog.js';
import { cacheEpoch, productionConfig, withReleaseLease, assertGolden, readiness, migrationGate, FTS_GENERATION } from '../scripts/lib/release-gates.js';
import { assertDeployedVars } from '../scripts/lib/cloudflare-release.js';
import { pacedRequests } from '../scripts/lib/production-smoke.js';

const commit = 'a'.repeat(40);
const record = () => normalize('cpu', { opendb_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', metadata: { name: 'AMD Ryzen 7 9800X3D', manufacturer: 'AMD' } }, commit);

test('actual CLI retry preserves immutable pin artifact separately from report and never re-resolves upstream', async t => {
  await mkdir('.cache', { recursive: true });
  const directory = path.resolve(await mkdtemp('.cache/release-pin-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, '.cache'));
  const file = path.join(directory, '.cache/release-pin.json');
  const pin = { commit, run_id: '123', base_sync_id: 'previous' };
  await writeFile(file, JSON.stringify(pin));
  const options = { cwd: directory, env: { ...process.env, GITHUB_RUN_ATTEMPT: '2', GITHUB_RUN_ID: '123', GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '' } };
  await promisify(execFile)(process.execPath, [path.resolve('scripts/catalog-release.js'), 'pin'], options);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), pin);
  assert.equal(JSON.parse(await readFile(path.join(directory, '.cache/release-pin-report.json'), 'utf8')).result, 'success');
  options.env.GITHUB_RUN_ID = 'another-run';
  await assert.rejects(promisify(execFile)(process.execPath, [path.resolve('scripts/catalog-release.js'), 'pin'], options));
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), pin);
  // The always() artifact step must also have a report after a failed command.
  assert.equal(JSON.parse(await readFile(path.join(directory, '.cache/release-pin-report.json'), 'utf8')).result, 'failed');
});

test('retry reuses completed sync only after comparing DB hashes; partial and failed writes resume', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  const snapshot = { commit, records: [record()] };
  const first = await syncSnapshot(db, snapshot, { reuseComplete: true });
  const repeat = await syncSnapshot(db, snapshot, { reuseComplete: true });
  assert.equal(repeat.run_id, first.run_id);
  assert.equal(repeat.reused, true);
  assert.equal(repeat.added, 0);
  assert.equal(repeat.updated, 0);
  assert.equal(repeat.unchanged, 1);
  assert.equal((await db.query('SELECT count(*) AS n FROM sync_runs')).results[0].n, 1);
  assert.equal(cacheEpoch(await catalogState(db)), `sync-${first.run_id}-fts${FTS_GENERATION}-cache2`);
  db.sqlite.exec("UPDATE products SET content_hash='interrupted-write'");
  const resumed = await syncSnapshot(db, snapshot, { reuseComplete: true });
  assert.notEqual(resumed.run_id, first.run_id);
  assert.equal(resumed.updated, 1);
  // A failed run with all writes already committed still needs finalization.
  db.sqlite.exec("UPDATE sync_runs SET status='failed'");
  const recovered = await syncSnapshot(db, snapshot, { reuseComplete: true });
  assert.equal(recovered.status, 'complete');
  assert.notEqual(recovered.run_id, resumed.run_id);
  assert.equal(recovered.updated, 0);
});

test('release lease excludes sync, permits its own measurements, and cleans up on gate failure', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  const snapshot = { commit, records: [record()] };
  await syncSnapshot(db, snapshot);
  await assert.rejects(withReleaseLease(db, async (locked, renew) => {
    assert.equal((await catalogState(locked)).status, 'complete');
    await assert.rejects(catalogState(db), /synchronized/);
    await assert.rejects(syncSnapshot(db, snapshot), /lease/);
    await renew();
    throw new Error('quality stopped');
  }), /quality stopped/);
  assert.equal((await db.query('SELECT count(*) AS n FROM sync_lock')).results[0].n, 0);
  await withReleaseLease(db, async (locked, renew) => {
    db.sqlite.exec('UPDATE sync_lock SET expires_at=0');
    await assert.rejects(renew, /renewal failed/);
    await assert.rejects(renew, /lost/);
  });
});

test('retry of an old workflow cannot overwrite a newer catalog, even after acquiring the lease', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  const snapshot = { commit, records: [record()] };
  const original = await syncSnapshot(db, snapshot);
  db.sqlite.exec("UPDATE sync_runs SET source_commit='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'");
  await assert.rejects(syncSnapshot(db, snapshot, { baseSyncId: 'older-run', reuseComplete: true }), /superseded/);
  assert.equal((await db.query('SELECT count(*) AS n FROM sync_runs')).results[0].n, 1);
  assert.equal((await catalogState(db)).id, original.run_id);
  assert.equal((await db.query('SELECT count(*) AS n FROM sync_lock')).results[0].n, 0);
});

test('epoch tracks snapshot/projection/cache generations, not workflow attempts', () => {
  const sync = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'complete' };
  assert.equal(cacheEpoch(sync), cacheEpoch({ ...sync, attempt: 99 }));
  assert.notEqual(cacheEpoch(sync), cacheEpoch(sync, FTS_GENERATION + 1));
  assert.notEqual(cacheEpoch(sync), cacheEpoch(sync, FTS_GENERATION, 'v3'));
  assert.throws(() => cacheEpoch({ ...sync, status: 'partial' }));
});

test('production config rejects mismatched remote overrides, retains TTL and checks effective deployed vars', async () => {
  const config = JSON.parse(await readFile('wrangler.json', 'utf8'));
  assert.equal(productionConfig(config, {}).vars.SEARCH_CACHE_TTL_SECONDS, '300');
  assert.throws(() => productionConfig(config, { CLOUDFLARE_D1_DATABASE_ID: config.env.local.d1_databases[0].database_id }));
  assert.throws(() => productionConfig(config, { CLOUDFLARE_ACCOUNT_ID: '0'.repeat(32) }));
  const bindings = Object.entries(config.vars).map(([name, text]) => ({ name, type: 'plain_text', text }));
  assertDeployedVars({ bindings }, config.vars);
  assert.throws(() => assertDeployedVars({ bindings: bindings.slice(1) }, config.vars));
});

test('UX gate rejects identifier errors, contamination, review debt and missing coverage, not browse rank movement', () => {
  const report = { results: ['lookup','identifier','browse','browse_filter','filter_only'].map(intent => ({ id:intent,intent,rank:1,
    rows_read:100,sql_duration_ms:1,relevant_count:5,recall_at_20:1,precision_at_20:1,filter_correctness:true,
    exact_set_equality:true,pagination_correctness:true })) };
  assertGolden(report);
  report.results[2].rank=999; assertGolden(report);
  for (const [index,change] of [[1,{rank:2}],[2,{precision_at_20:.5}],[3,{false_positive_count:1}],[4,{pagination_correctness:false}],[0,{review:'pending'}]]) {
    const bad = structuredClone(report); Object.assign(bad.results[index], change);
    assert.throws(() => assertGolden(bad));
  }
  assert.throws(() => assertGolden({results:[]}));
});

test('readiness rejects missing migration, unfinished latest sync and abnormal catalog count', async t => {
  const db = database(); t.after(() => db.sqlite.close());
  db.sqlite.exec('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY,name TEXT)');
  await assert.rejects(migrationGate(db));
  for (const name of (await readdir('migrations')).filter(f => f.endsWith('.sql'))) db.sqlite.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run(name);
  await migrationGate(db);
  await assert.rejects(readiness(db), /Latest sync/);
  await syncSnapshot(db, { commit, records: [record()] });
  await assert.rejects(readiness(db), /Active count/);
  db.sqlite.exec("UPDATE sync_runs SET status='partial'");
  await assert.rejects(readiness(db), /Latest sync/);
});

test('production pacing honors 429 Retry-After and bounds retries without swallowing contract failure', async () => {
  const sleeps = []; let calls = 0;
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'X-Request-ID, X-Cache, Retry-After', 'X-Request-ID': 'test' };
  const request = pacedRequests('https://catalog.example', { interval: 0, sleep: async n => sleeps.push(n), fetcher: async () => {
    calls++;
    return calls === 1 ? new Response('', { status: 429, headers: { 'Retry-After': '30' } }) : new Response('{}', { headers });
  } });
  await request('/v1/health');
  assert.equal(calls, 2); assert(sleeps.includes(30000));
  calls = 0;
  const limited = pacedRequests('https://catalog.example', { interval: 0, sleep: async () => {}, fetcher: async () => { calls++; return new Response('', { status: 429 }); } });
  await assert.rejects(limited('/v1/health'));
  assert.equal(calls, 3);
});
