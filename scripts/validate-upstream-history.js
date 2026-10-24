// Explicit, local-only reproduction tool. Never opens a D1/Worker connection.
import { parseArgs } from 'node:util';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { fetchUpstream, loadSnapshot } from '../src/upstream.js';
import { normalizeV1 } from '../src/normalize.js';
import { ingestionQuality } from '../src/quality/ingestion.js';
import { database } from '../test-support/database.js';
import { syncSnapshot, ingestionStatement } from '../src/sync.js';
import { latestSync, planForSync, publishedSnapshot } from '../src/application-plan.js';
import { loadQualityCatalog } from '../src/quality/catalog.js';
import { verifySourceCatalog } from '../src/quality/integrity.js';
import { verifyFilterMetadata } from './lib/filter-verification.js';
import { ftsIntegrity } from './lib/fts-integrity.js';
import assert from 'node:assert/strict';
import { loadUXFixture, evaluateUX, qualityFailures, sourceCatalog } from '../src/quality/ux.js';
import { publicationCases, assertPublicationCoverage } from '../src/quality/publication-cases.js';

const { values: args } = parseArgs({ options: { repo: { type: 'string', default: '.cache/resilient-source' }, baseline: { type: 'string', default: '.cache/upstream' },
  commits: { type: 'string' }, sync: { type: 'boolean', default: false }, resume: { type:'boolean',default:false }, output: { type: 'string', default: '.cache/resilient-validation' } } });
assert(args.commits, 'Supply comma-separated immutable --commits');
const commits = args.commits.split(','); assert(commits.every(c => /^[a-f0-9]{40}$/.test(c)));
await mkdir(args.output, { recursive: true });
const baseline = await loadSnapshot(args.baseline, { reportDirectory: `${args.output}/baseline` });
const old = baseline.records.map(r => ({ active: 1, record: normalizeV1(r.product.category, JSON.parse(r.raw), baseline.commit) }));
const report = { baseline: baseline.commit, baseline_count: old.length, normalizer_updates: baseline.records.filter((r,i) => r.product.content_hash !== old[i].record.product.content_hash).length,
  measurement: 'Node SQLite local changes are NOT D1 rows_written', status: 'running', snapshots: [] };
let db;
if (args.sync) {
  const filename = `${args.output}/catalog.sqlite`;
  let exists = false; try { await access(filename); exists = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  assert.equal(exists, args.resume, 'Use --resume for an existing local verification DB, or a new --output directory');
  db = database({ filename });
  if (!args.resume) {
  await db.query("INSERT INTO sync_lock VALUES(1,'seed',unixepoch()+900)");
  for (let i = 0; i < old.length; i += 25) { const q = ingestionStatement(old.slice(i,i+25).map(r => r.record), 'seed'); await db.query(q.sql,q.params); }
  await db.query('DELETE FROM sync_lock');
  await db.query("INSERT INTO sync_runs(id,source_commit,normalization_version,status,started_at,finished_at) VALUES('00000000-0000-4000-8000-000000000001',?,1,'complete','2026-09-21','2026-09-21')", [baseline.commit]);
  }
}
try {
  for (const commit of commits) {
    await fetchUpstream({ repo: args.repo, ref: commit, reportDirectory: `${args.output}/${commit}` });
    const snapshot = await loadSnapshot(args.repo, { reportDirectory: `${args.output}/${commit}` });
    const quality = ingestionQuality(snapshot, old);
    const item = { commit, presence: snapshot.presence.length, accepted: snapshot.records.length, quarantined: snapshot.quarantined.length,
      schema_violations: Object.entries(snapshot.report.diagnostics.by_code).filter(([k]) => k.startsWith('schema_')),
      held: quality.held, categories: quality.categories, sync: [] };
    report.snapshots.push(item);
    if (db) {
      let result;
      do {
        result = await syncSnapshot(db, snapshot, { maxProducts: 10000, baselineSource: baseline, reuseComplete: true });
        item.sync.push({ status: result.status, plan_hash: result.plan_hash, added: result.added, updated: result.updated, deleted: result.deleted, retained: result.retained, remaining: result.remaining, sqlite_changes: result.rows_written });
      } while (result.status === 'partial');
      const published = publishedSnapshot(await planForSync(await latestSync(db)));
      // Report the actual fixed baseline for each commit, including resumes.
      item.held = published.applicationPlan.quality.held;
      item.categories = published.applicationPlan.quality.categories;
      item.input_hash = published.applicationPlan.input_hash;
      item.quality_status = published.applicationPlan.quality.status;
      item.source_integrity = await verifySourceCatalog(db, await loadQualityCatalog(db), published); assert(item.source_integrity.pass);
      item.fts = await ftsIntegrity(db); assert(item.fts.pass);
      item.filters = await verifyFilterMetadata(db, { snapshot: published }); assert(item.filters.pass);
      const { fixture: requested, hash } = await loadUXFixture();
      const selection = publicationCases(requested, published); assertPublicationCoverage(selection.coverage, requested);
      const catalog = await loadQualityCatalog(db);
      const search = await evaluateUX(db, catalog, selection.fixture, { fixtureHash: hash, source: sourceCatalog(published, catalog) });
      const failures = qualityFailures(search);
      item.search = { coverage: selection.coverage, cases: search.results.length,
        correctness_failures: failures.filter(f => !/missing (D1 cost|pagination cost) metadata/.test(f)),
        performance: 'not_measured_on_D1', unmeasured_cost_cases: failures.filter(f => /missing (D1 cost|pagination cost) metadata/.test(f)).length };
      await writeFile(`${args.output}/${commit}/search.json`, JSON.stringify(search));
      assert.equal(item.search.correctness_failures.length, 0, 'Local search correctness failed');
      const repeat = await syncSnapshot(db, snapshot, { reuseComplete: true });
      assert(repeat.reused && repeat.added + repeat.updated + repeat.deleted === 0);
      item.no_change = { reused: repeat.reused, product_writes: repeat.added + repeat.updated + repeat.deleted };
    }
    await writeFile(`${args.output}/summary.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ commit, accepted: item.accepted, quarantined: item.quarantined, schema_violations: item.schema_violations, held: item.held, sync: item.sync, source_integrity: item.source_integrity?.pass, fts: item.fts?.pass, filters: item.filters?.pass, search: item.search }));
  }
  report.status = 'passed';
} catch (error) { report.status = 'failed'; throw error; }
finally { if (db) db.sqlite.close(); await writeFile(`${args.output}/summary.json`, JSON.stringify(report, null, 2)); }
