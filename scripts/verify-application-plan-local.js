// Recheck saved local replay evidence with the current implementation. No D1 API.
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { database } from '../test-support/database.js';
import { fetchUpstream, loadSnapshot } from '../src/upstream.js';
import { latestSync, planForSync, publishedSnapshot, snapshotDigest } from '../src/application-plan.js';
import { readiness } from './lib/release-gates.js';
import { verifyPlans } from '../src/queries.js';
import { loadQualityCatalog } from '../src/quality/catalog.js';
import { verifySourceCatalog } from '../src/quality/integrity.js';
import { syncSnapshot } from '../src/sync.js';

const { values: args } = parseArgs({ options: { directory: {type:'string',default:'.cache/resilient-final'}, repo:{type:'string',default:'.cache/resilient-source'} } });
const summary = JSON.parse(await readFile(`${args.directory}/summary.json`,'utf8'));
const db = database({filename:`${args.directory}/catalog.sqlite`});
const report = { measurement: 'local Node SQLite; production D1 cost and HTTP not measured', snapshots: [], status: 'running' };
let lastSnapshot;
try {
  // The replay adapter applies every SQL migration directly. Record that local
  // history so the ordinary readiness gate can also verify the schema list.
  await db.query('CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY,name TEXT UNIQUE NOT NULL)');
  for (const name of (await readdir('migrations')).filter(n=>n.endsWith('.sql'))) await db.query('INSERT OR IGNORE INTO d1_migrations(name) VALUES(?)',[name]);
  for (const item of summary.snapshots) {
    const hash = item.sync.at(-1).plan_hash;
    const completed = (await db.query("SELECT * FROM sync_runs WHERE plan_hash=? AND status='complete' ORDER BY started_at DESC LIMIT 1",[hash])).results[0];
    assert.equal(completed?.source_commit,item.commit);
    const plan = await planForSync(completed);
    await fetchUpstream({repo:args.repo,ref:item.commit,reportDirectory:`${args.directory}/current-code/${item.commit}`});
    const snapshot = await loadSnapshot(args.repo,{reportDirectory:`${args.directory}/current-code/${item.commit}`});
    lastSnapshot = snapshot;
    const actual = snapshotDigest(snapshot);
    report.snapshots.push({commit:item.commit,plan_hash:hash,input_hash:actual,expected_input_hash:plan.input_hash,input_hash_matches:actual===plan.input_hash,accepted:snapshot.records.length,quarantined:snapshot.quarantined.length,diagnostics:snapshot.report.diagnostics.by_code});
    assert.equal(actual,plan.input_hash,'Current implementation differs from the replayed input contract');
  }
  report.latest_code_no_change_sync = await syncSnapshot(db,lastSnapshot,{reuseComplete:true});
  assert(report.latest_code_no_change_sync.reused);
  assert.equal(report.latest_code_no_change_sync.added+report.latest_code_no_change_sync.updated+report.latest_code_no_change_sync.reactivated+report.latest_code_no_change_sync.deleted,0);
  report.readiness = await readiness(db);
  const snapshot = publishedSnapshot(await planForSync(await latestSync(db)));
  report.source_integrity = await verifySourceCatalog(db,await loadQualityCatalog(db),snapshot); assert(report.source_integrity.pass);
  const plans = await verifyPlans(db);
  report.query_plans = {total:plans.length,passed:plans.filter(p=>p.index_check).length,failures:plans.filter(p=>!p.index_check).map(p=>p.name)};
  assert.equal(report.query_plans.failures.length,0);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; throw error; }
finally {
  report.node = process.version;
  report.peak_rss_mb = process.resourceUsage().maxRSS / 1024 || null;
  await writeFile(`${args.directory}/current-code-verification.json`,JSON.stringify(report,null,2)); db.sqlite.close();
}
console.log(JSON.stringify({status:report.status,snapshots:report.snapshots,query_plans:report.query_plans,active:report.readiness.active}));
