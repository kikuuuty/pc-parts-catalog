import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { database } from '../test-support/database.js';
import { normalize } from '../src/normalize.js';
import { syncSnapshot } from '../src/sync.js';
import { latestSync, storedCatalog, digest } from '../src/application-plan.js';
import { cacheEpoch } from '../scripts/lib/release-gates.js';
import { ftsIntegrity } from '../scripts/lib/fts-integrity.js';
import { loadQualityCatalog } from '../src/quality/catalog.js';
import { verifySourceCatalog } from '../src/quality/integrity.js';
import { captureProjection, compareProjection } from '../scripts/lib/fts-verification.js';
import { publicationInputs, releaseRequest, selectPublicationSource, restorePublication, assertPublicationState, githubPublicationAdapter } from '../scripts/lib/publication-source.js';
import { publishCatalog, publicationDatabase } from '../scripts/lib/catalog-publication.js';
import { phaseTiming } from '../scripts/lib/phase-timing.js';
import { verifyPlans, searchQuery } from '../src/queries.js';

const commit = 'a'.repeat(40), code = 'b'.repeat(40);
async function fixture(t) {
  const db = database(); t.after(() => db.sqlite.close());
  const records = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'].map((id, i) =>
    normalize('cpu', { opendb_id: id, metadata: { name: `CPU ${i}`, manufacturer: 'AMD', part_numbers: [`CPU-${i}`] }, socket: 'AM4' }, commit));
  const prepared = await syncSnapshot(db, { commit, records }, { prepareOnly: true, workflowRunId: '123' });
  const plan = prepared.applicationPlan;
  // Fixture setup may ingest; the publication under test may NEVER do so.
  const synced = await syncSnapshot(db, { commit, records }, { applicationPlan: plan });
  const sync = { ...synced, artifact_run_id: '123' };
  await db.query('UPDATE sync_runs SET report_json=? WHERE id=?', [JSON.stringify(sync), sync.run_id]);
  const expected = { source_run_id: '123', source_attempt: '5', expected_sync_id: sync.run_id, expected_plan_hash: plan.hash, expected_upstream_commit: commit };
  const pin = { run_id: '123', commit, base_sync_id: null, base_plan_hash: null };
  const files = { pin, plan, completionPin: structuredClone(pin), completionPlan: structuredClone(plan),
    snapshot: { sync_id: sync.run_id, commit, plan_hash: plan.hash, counts: plan.counts }, sync,
    release: { result: 'success', validation: { sync_completion: 'passed' }, sync_id: sync.run_id, sync_status: 'complete', plan_hash: plan.hash },
    receipt: { state: 'saved', artifact_id: 20, run_id: '123', commit, base_sync_id: null, plan_hash: plan.hash } };
  const artifacts = [{ id: 10, name: 'catalog-snapshot-pin', expired: false }, { id: 20, name: 'catalog-application-plan', expired: false }, { id: 30, name: 'catalog-release-attempt-5', expired: false }];
  const metadata = { id: 123, run_attempt: 5, head_sha: commit, head_branch: 'main', workflow_id: 99, event: 'workflow_dispatch',
    status: 'completed', conclusion: 'cancelled', repository: { full_name: 'owner/catalog' }, head_repository: { full_name: 'owner/catalog' } };
  const events = [], faults = {};
  const adapter = {
    async run(attempt) { events.push('source_run'); assert.equal(attempt, '5'); return metadata; },
    async workflow() { return { id: 99, path: '.github/workflows/sync.yml' }; },
    async repository() { return { full_name: 'owner/catalog', default_branch: 'main' }; },
    async jobs() { return [{ steps: [{ name: 'Production sync and completion verification', conclusion: faults.step || 'success' }] }]; },
    async list() { events.push('list'); if (faults.list) throw Error('listing_failed'); return artifacts; },
    async download(a, kind) { events.push(`download_${kind}`); if (faults.download) throw Error('download_failed');
      if (kind === 'pin') return files.pin; if (kind === 'plan') return files.plan; return files; },
  };
  const context = { repository: 'owner/catalog', runId: '456', codeSha: code };
  const restore = () => restorePublication(adapter, expected, context);
  const config = JSON.parse(await readFile('wrangler.json', 'utf8'));
  const bindings = () => [{ name: 'DB', type: 'd1', id: config.d1_databases[0].database_id },
    ...Object.entries(config.vars).map(([name, text]) => ({ name, type: 'plain_text', text })),
    ...config.ratelimits.map(r => ({ ...r, type: 'ratelimit' })), { name: 'YAHOO_SHOPPING_APP_ID', type: 'secret_text' }];
  let current = { id: 'c'.repeat(36), tag: 'old', bindings: bindings() }, deploys = 0;
  const report = { result: 'running', validation: {}, deploy: 'not run', post_deploy: 'not run' };
  const timing = phaseTiming(report, async () => {});
  const adapters = {
    async cloudflareRelease() { return { async current() { events.push('worker_state'); return current; } }; },
    // Small fixtures cannot satisfy the production 20k envelope. The real fixed
    // plan/content checks and lease remain in use; production readiness is not relaxed.
    async readiness(locked) { events.push('readiness'); const s = await latestSync(locked); const fts = await ftsIntegrity(locked); assert(fts.pass);
      return { sync: s, counts: plan.counts, active: 2, cache_epoch: cacheEpoch(s), fts }; },
    async searchGate(locked, options) {
      assert.equal(options.representative, false);
      for (const name of ['source_integrity', 'filter_metadata', 'search_quality', 'query_plans']) {
        events.push(name); options.onPhase(name, 'running');
        if (faults.gate === name) throw Error('gate_failed');
        if (name === 'source_integrity') assert((await verifySourceCatalog(locked, await loadQualityCatalog(locked), options.snapshot)).pass);
        options.onPhase(name, 'passed');
      }
      if (faults.lease) db.sqlite.exec('UPDATE sync_lock SET expires_at=0');
      if (faults.write) await locked.query('UPDATE products SET active=0');
      return { validation: Object.fromEntries(['source_integrity', 'filter_metadata', 'search_quality', 'query_plans'].map(k => [k, 'passed'])) };
    },
    async releaseIdentity() { return 'release-new'; },
    async wrangler(args) {
      if (args.includes('--dry-run')) { events.push('compile'); return ''; }
      events.push('deploy'); deploys++;
      current = { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', tag: 'release-new', bindings: bindings().map(b => b.name === 'CATALOG_CACHE_EPOCH' ? { ...b, text: cacheEpoch({ id: sync.run_id, status: 'complete' }) } : b) };
      if (faults.transport) throw Error('response_lost');
      return `Current Version ID: ${current.id}`;
    },
    async verifyProduction(locked, origin, options) { events.push('http'); assert.equal(options.golden, true); if (faults.http) throw Error('http_failed'); options.report.contract = 'pass'; },
  };
  const publish = async target => publishCatalog({ db, config, target: target ?? await restore(), report, timing, adapters });
  return { db, plan, sync, pin, expected, files, artifacts, metadata, adapter, context, restore, events, faults, config, adapters, report, timing, publish,
    get deploys() { return deploys; }, get current() { return current; }, set current(value) { current = value; } };
}

test('cancelled source with successful sync publishes unchanged plan/data under one lease across all gates', async t => {
  const f = await fixture(t), before = await captureProjection(f.db), target = await f.restore();
  assert.equal(target.source.run_id, '123'); assert.equal(target.source.publication_run_id, '456');
  assert.equal(target.source.code_sha, commit); assert.equal(target.source.publication_code_sha, code);
  const pin = structuredClone(f.pin), plan = structuredClone(f.plan);
  await f.publish(target);
  assert.deepEqual(compareProjection(before, await captureProjection(f.db)).data_changed_tables, []);
  assert.deepEqual(f.pin, pin); assert.deepEqual(f.plan, plan);
  assert.equal(f.report.post_deploy, 'pass'); assert.equal(f.deploys, 1);
  assert.deepEqual(f.events.filter(e => ['source_integrity','filter_metadata','search_quality','query_plans','compile','deploy','http'].includes(e)),
    ['source_integrity','filter_metadata','search_quality','query_plans','compile','deploy','http']);
  assert.equal((await f.db.query('SELECT count(*) n FROM sync_runs')).results[0].n, 1);
  assert.equal((await f.db.query('SELECT count(*) n FROM sync_lock')).results[0].n, 0);
  assert(f.report.d1.queries > 0); assert(f.report.d1.rows_written > 0, 'only lease writes are metered');
});

test('publication rejects failed sync step even when whole run succeeded, but permits cancelled parent', async t => {
  const f = await fixture(t); await f.restore(); f.metadata.conclusion = 'success'; f.faults.step = 'failure';
  await assert.rejects(f.publish(), /sync_step_not_successful/); assert.equal(f.deploys, 0);
});

test('missing, expired, ambiguous and failed artifact reads fail closed without any fallback', async t => {
  for (const failure of ['list', 'download', 'expired', 'missing', 'ambiguous']) {
    const f = await fixture(t), before = await storedCatalog(f.db);
    if (['list','download'].includes(failure)) f.faults[failure] = true;
    if (failure === 'expired') f.artifacts[1].expired = true;
    if (failure === 'missing') f.artifacts.pop();
    if (failure === 'ambiguous') f.artifacts.push({ ...f.artifacts[1], id: 21 });
    await assert.rejects(f.publish()); assert.equal(f.deploys, 0); assert.deepEqual(await storedCatalog(f.db), before);
  }
});

test('source workflow/repository/branch/attempt and immutable body provenance are checked before DB access', async t => {
  for (const field of ['workflow_id', 'repository', 'head_repository', 'head_branch', 'run_attempt']) {
    const f = await fixture(t);
    f.metadata[field] = field.endsWith('repository') ? { full_name: 'foreign/fork' } : 'wrong';
    await assert.rejects(f.publish()); assert.equal(f.deploys, 0);
  }
});

test('corrupt plan and mismatched commit/hash/sync/completion/receipt never deploy or regenerate', async t => {
  for (const fault of ['hash','commit','format','contract','normalizer','sync_id','snapshot_missing','partial','remaining','release','receipt','copy']) {
    const f = await fixture(t);
    if (fault === 'hash') f.files.plan.rows[0].active = 0;
    if (['commit','format','contract','normalizer'].includes(fault)) {
      const { hash: ignored, ...body } = f.files.plan;
      body[{ commit:'commit',format:'version',contract:'contract_version',normalizer:'normalization_version' }[fault]] = fault === 'commit' ? 'e'.repeat(40) : 999;
      f.files.plan = { ...body, hash: digest(body) };
    }
    if (fault === 'sync_id') f.files.snapshot.sync_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    if (fault === 'snapshot_missing') delete f.files.snapshot;
    if (fault === 'partial') f.files.sync.status = 'partial';
    if (fault === 'remaining') f.files.sync.remaining = 1;
    if (fault === 'release') f.files.release.result = 'failed';
    if (fault === 'receipt') f.files.receipt.artifact_id = 99;
    if (fault === 'copy') f.files.completionPin.run_id = '456';
    await assert.rejects(f.publish()); assert.equal(f.deploys, 0);
  }
});

test('DB partial/failed/running or different sync identity cannot publish; same count/commit does not suffice', async t => {
  for (const state of ['partial','failed','running','id','hash','commit','content','local']) {
    const f = await fixture(t), target = await f.restore();
    if (['partial','failed','running'].includes(state)) await f.db.query('UPDATE sync_runs SET status=?', [state]);
    if (state === 'id') await f.db.query('UPDATE sync_runs SET id=?', ['eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee']);
    if (state === 'hash') await f.db.query('UPDATE sync_runs SET plan_hash=?', ['f'.repeat(64)]);
    if (state === 'commit') await f.db.query('UPDATE sync_runs SET source_commit=?', ['f'.repeat(40)]);
    if (state === 'content') f.db.sqlite.exec("UPDATE cpu SET socket='wrong' WHERE product_id=1");
    if (state === 'local') f.db.sqlite.exec("INSERT INTO local_enrichments(product_id,namespace,key,value_json,evidence) VALUES(1,'spec','note','true','changed')");
    await assert.rejects(f.publish(target)); assert.equal(f.deploys, 0);
    assert(!f.events.includes('source_integrity'));
  }
});

test('all gate failures and lease loss prevent deployment; lease cleanup uses existing protocol', async t => {
  for (const gate of ['source_integrity','filter_metadata','search_quality','query_plans','lease']) {
    const f = await fixture(t), before = await storedCatalog(f.db);
    if (gate === 'lease') f.faults.lease = true; else f.faults.gate = gate;
    await assert.rejects(f.publish()); assert.equal(f.deploys, 0); assert.equal(f.report.result, 'failed');
    assert.deepEqual(await storedCatalog(f.db), before);
    assert.equal((await f.db.query('SELECT count(*) n FROM sync_lock')).results[0].n, 0);
  }
});

test('HTTP failure is unfinished after actual deploy; retry reconciles version/tag without duplicate deployment', async t => {
  const f = await fixture(t); f.faults.http = true;
  await assert.rejects(f.publish(), /http_failed/);
  assert.equal(f.report.deploy, 'success'); assert.equal(f.report.post_deploy, 'failed'); assert.equal(f.report.result, 'failed');
  f.faults.http = false; await f.publish();
  assert.equal(f.deploys, 1); assert.equal(f.report.deploy, 'already deployed'); assert.equal(f.report.post_deploy, 'pass');
});

test('lost deployment response is not resent; same target retry reconciles the live tag', async t => {
  const f = await fixture(t); f.faults.transport = true;
  await assert.rejects(f.publish(), /response_lost/); assert.equal(f.deploys, 1);
  f.faults.transport = false; await f.publish(); assert.equal(f.deploys, 1); assert.equal(f.report.post_deploy, 'pass');
});

test('expired lease is recovered only by normal lease protocol; a live foreign writer blocks publication', async t => {
  for (const expired of [false,true]) {
    const f = await fixture(t);
    await f.db.query("INSERT INTO sync_lock(id,owner,expires_at) VALUES(1,'previous',unixepoch()+?)", [expired ? -10 : 900]);
    if (expired) { await f.publish(); assert.equal(f.deploys,1); }
    else { await assert.rejects(f.publish(),/Writer holds catalog lease/); assert.equal(f.deploys,0); }
  }
});

test('actual Worker DB or rate-limit mismatch stops before catalog gates/deployment', async t => {
  for (const kind of ['db','rate']) {
    const f = await fixture(t);
    if (kind === 'db') f.current.bindings.find(b=>b.name==='DB').id='00000000-0000-4000-8000-000000000000';
    else f.current.bindings.find(b=>b.type==='ratelimit').simple={limit:999,period:10};
    await assert.rejects(f.publish(),/binding differs|rate limit differs/); assert.equal(f.deploys,0); assert(!f.events.includes('source_integrity'));
  }
});

test('publication read guard prevents catalog/migration/history/FTS writes even from a gate adapter', async t => {
  const f = await fixture(t), guarded = publicationDatabase(f.db, {});
  await guarded.query("SELECT replace('x','x','y') value");
  const query = searchQuery('cpu', { manufacturer: 'AMD', limit: 2 });
  await guarded.query(query.sql, query.params);
  assert((await verifyPlans(guarded)).length > 0, 'real compiler/plan SQL is accepted by read guard');
  for (const sql of ['UPDATE products SET active=0','DELETE FROM sync_runs','ALTER TABLE sync_runs ADD COLUMN bad TEXT',
    'INSERT INTO ingest(payload) VALUES(?)','INSERT INTO cpu_fts(cpu_fts) VALUES(?)','PRAGMA optimize','WITH x AS (SELECT 1) DELETE FROM products']) {
    await assert.rejects(guarded.query(sql), /write prohibited/);
  }
  f.faults.write = true; await assert.rejects(f.publish(), /write prohibited/); assert.equal(f.deploys, 0);
});

test('normal completed sync output attempt is retained on publish-only retries; scheduled/invalid/skipped paths fail safely', () => {
  const env = { GITHUB_REF:'refs/heads/main',DEFAULT_BRANCH:'main',GITHUB_EVENT_NAME:'workflow_dispatch',RELEASE_MODE:'publish_existing',
    SOURCE_RUN_ID:'123',SOURCE_ATTEMPT:'5',EXPECTED_SYNC_ID:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',EXPECTED_PLAN_HASH:'a'.repeat(64),EXPECTED_UPSTREAM_COMMIT:commit };
  const request = releaseRequest(env);
  assert.equal(selectPublicationSource(request,'skipped',{}).source_attempt,'5');
  const outputs = { ...env, GITHUB_RUN_ATTEMPT:'9' };
  const normal = releaseRequest({ ...env,RELEASE_MODE:'sync_release' });
  assert.equal(selectPublicationSource(normal,'success',outputs).source_attempt,'5');
  for (const status of ['failure','cancelled','skipped']) assert.throws(() => selectPublicationSource(normal,status,outputs));
  assert.equal(releaseRequest({ ...env,GITHUB_EVENT_NAME:'schedule' }).mode,'sync_release');
  for (const key of ['SOURCE_RUN_ID','SOURCE_ATTEMPT','EXPECTED_SYNC_ID','EXPECTED_PLAN_HASH','EXPECTED_UPSTREAM_COMMIT']) assert.throws(() => publicationInputs({ ...env,[key]:'' }));
  assert.throws(() => releaseRequest({ ...env,RELEASE_MODE:'unknown' }));
  assert.throws(() => releaseRequest({ ...env,GITHUB_REF:'refs/heads/foreign' }));
});

test('phase diagnostics record start/end/elapsed and partial interruption without enabling phase skipping', async () => {
  const report = {}, saves = []; let time = 1000;
  const timing = phaseTiming(report, async r => saves.push(structuredClone(r)), () => time);
  await timing.run('good', async () => { time += 25; });
  await assert.rejects(timing.run('bad', async () => { time += 10; throw Error('stop'); }));
  timing.mark('interrupted','running'); time += 50; timing.interrupt(); await timing.persist();
  assert.equal(report.timings.good.elapsed_ms,25); assert.equal(report.timings.bad.status,'failed');
  assert.equal(report.timings.interrupted.elapsed_ms,50); assert.equal(report.timings.interrupted.status,'interrupted');
  assert(saves.some(r => r.timings.good?.status === 'running'));
});

test('workflow wiring splits jobs with 120-minute full publication, explicit source outputs and safe skipped-sync condition', async () => {
  const yml = await readFile('.github/workflows/sync.yml','utf8');
  assert(yml.includes('needs: [validate, sync]')); assert(yml.includes("if: always() && needs.validate.result == 'success'"));
  assert(yml.includes("needs.validate.outputs.mode == 'publish_existing' || needs.sync.result == 'success'"));
  assert(yml.includes('timeout-minutes: 120')); assert(yml.includes('source_attempt: ${{ steps.sync.outputs.source_attempt }}'));
  assert(yml.includes('needs.sync.outputs.source_attempt')); assert(!yml.includes('SOURCE_ATTEMPT: ${{ github.run_attempt }}'));
  assert(yml.includes('group: catalog-production-sync')); assert(yml.includes('cancel-in-progress: false'));
  const publication = yml.split('  publish:')[1]; assert(!publication.includes('release:sync')); assert(!publication.includes('db:migrate'));
  assert(publication.includes('node scripts/catalog-publication.js publish'));
});
