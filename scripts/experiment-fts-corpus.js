import assert from 'node:assert/strict';
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, readdir, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { getPlatformProxy } from 'wrangler';
import { loadSearchFixture } from '../src/quality/fixtures.js';
import { loadQualityCatalog } from '../src/quality/catalog.js';
import { benchmarkSearch } from '../src/quality/benchmark.js';
import { hasCatalogFullScan } from '../src/queries.js';
import { loadSnapshot } from '../src/upstream.js';
import { syncSnapshot } from '../src/sync.js';
import { categoryIndexes, categoryMigration, experimentQuery, integrity, queryPlans, aggregate, rankChange, compareRuns, hash, quantile } from './lib/corpus-experiment.js';
import { corpusStatistics, storageStatistics } from './lib/corpus-statistics.js';
import { assertGolden } from './lib/release-gates.js';

const {values:args}=parseArgs({options:{stage:{type:'string',default:'all'},directory:{type:'string'},
  'source-location':{type:'string',default:'.cache/all-categories-fresh-location.json'},repeats:{type:'string',default:'5'}}});
assert(['all','prepare','measure','cost'].includes(args.stage));
const repeats=Number(args.repeats); assert(Number.isInteger(repeats) && repeats>=3 && repeats<=20);
const root=path.resolve(args.directory ?? await mkdtemp('.cache/corpus-ab-'));
assert(root.startsWith(path.resolve('.cache')+path.sep),'Experiment output must be inside .cache');
const save=(name,value) => writeFile(path.join(root,name),JSON.stringify(value,null,2)+'\n');
const load=async name => JSON.parse(await readFile(path.join(root,name),'utf8'));
const legacy=await loadSearchFixture();
assert.equal(legacy.hash,'68d4f73da2ba143c06b5307cd84b97cb232db6489fbcee77b94e9974d925bfb7');
assert.equal(legacy.fixture.length,120);
const extended=await loadSearchFixture('test/fixtures/search-extended.json');
const evidence=JSON.parse(await readFile('test/fixtures/search-extended-evidence.json','utf8'));
assert.equal(extended.hash,evidence.fixture_sha256);
const fixture=[...legacy.fixture,...extended.fixture], fixtureHash=hash(JSON.stringify([legacy.hash,extended.hash]));
const implementationHash=hash(JSON.stringify(await Promise.all(['src/queries.js','src/search-intent.js','src/quality/benchmark.js','scripts/lib/corpus-experiment.js'].map(f => readFile(f,'utf8')))));
console.log(`Local-only corpus experiment: ${root}`);

if (['all','prepare'].includes(args.stage)) {
  const snapshot=await loadSnapshot();assert.equal(snapshot.commit,evidence.snapshot_commit);
  const location=JSON.parse(await readFile(args['source-location'],'utf8'));
  const sourceDir=path.join(location.directory,'state/v3/d1/miniflare-D1DatabaseObject');
  const names=(await readdir(sourceDir)).filter(f => f.endsWith('.sqlite') && f!=='metadata.sqlite');
  assert.equal(names.length,1);
  const source=new DatabaseSync(path.join(sourceDir,names[0]),{readOnly:true});
  const sourceConfig=JSON.parse(await readFile(location.configPath,'utf8'));
  const locations={};
  try {
    assert.equal(source.prepare('SELECT count(*) AS n FROM products WHERE active=1').get().n,48134);
    assert.deepEqual(source.prepare('SELECT DISTINCT source_commit FROM products WHERE active=1').all().map(r => r.source_commit),[evidence.snapshot_commit]);
    assert.equal(source.prepare('SELECT count(*) AS n FROM sync_lock WHERE expires_at>unixepoch()').get().n,0);
    const sourceRow=source.prepare('SELECT p.content_hash,r.raw_json FROM products p JOIN upstream_raw r ON r.product_id=p.id WHERE p.upstream_key=? AND p.active=1');
    for (const record of snapshot.records) {
      const row=sourceRow.get(record.product.upstream_key);assert(row,record.product.upstream_key);
      assert.equal(row.content_hash,record.product.content_hash);assert.equal(row.raw_json,record.raw);
    }
    for (const corpus of ['baseline','category']) {
      const directory=path.join(root,corpus), state=path.join(directory,'state');
      const dbdir=path.join(state,'v3/d1/miniflare-D1DatabaseObject'); await mkdir(dbdir,{recursive:true});
      const sqlitePath=path.join(dbdir,names[0]),configPath=path.join(directory,'wrangler.json');
      await backup(source,sqlitePath);
      await writeFile(configPath,JSON.stringify({name:`corpus-experiment-${corpus}`,compatibility_date:sourceConfig.compatibility_date,
        d1_databases:sourceConfig.d1_databases.map(d=>({binding:d.binding,database_name:d.database_name,database_id:d.database_id,remote:false}))},null,2));
      locations[corpus]={directory,state,sqlitePath,configPath};
    }
  } finally {source.close();}
  const schemaReader=new DatabaseSync(locations.category.sqlitePath,{readOnly:true});
  const migration=categoryMigration(schemaReader.prepare("SELECT sql FROM sqlite_schema WHERE name='ingest_product'").get().sql);schemaReader.close();
  await writeFile(path.join(root,'category-fts-experiment.sql'),migration.sql);
  const migrationProxy=await getPlatformProxy({configPath:locations.category.configPath,persist:{path:path.join(locations.category.state,'v3')}});
  let migrationMs,migrationMeta;
  try {
    const start=performance.now();
    const applied=await migrationProxy.env.DB.batch(migration.statements.map(s => migrationProxy.env.DB.prepare(s)));
    migrationMs=performance.now()-start;
    migrationMeta={rows_read:applied.reduce((n,r)=>n+(r.meta.rows_read??0),0),rows_written:applied.reduce((n,r)=>n+(r.meta.rows_written??0),0),sql_duration_ms:applied.reduce((n,r)=>n+(r.meta.duration??0),0)};
  } finally {await migrationProxy.dispose();}
  const a=new DatabaseSync(locations.baseline.sqlitePath),b=new DatabaseSync(locations.category.sqlitePath);
  try {
    // Same compaction/statistics procedure on both independent clones. Report
    // pre-compaction as well; otherwise abandoned pages can obscure the overhead.
    const pre={baseline:storageStatistics(a,'baseline'),category:storageStatistics(b,'category')};
    a.exec('VACUUM; ANALYZE'); b.exec('VACUUM; ANALYZE');
    const storage={baseline:storageStatistics(a,'baseline'),category:storageStatistics(b,'category')};
    assert.deepEqual(storage.baseline.non_fts_tables,storage.category.non_fts_tables,'Non-FTS data changed');
    assert.equal(storage.baseline.fts_projection_sha256,storage.category.fts_projection_sha256,'FTS field projection changed');
    const migrationFiles=(await readdir('migrations')).filter(f => f.endsWith('.sql')).sort();
    const inputs=await Promise.all(migrationFiles.map(f => readFile(path.join('migrations',f),'utf8')));
    const {splitSqlStatements}=await import('./lib/sql-statements.js');
    const baseStatements=inputs.flatMap(splitSqlStatements);
    await save('schema.json',{category_indexes:categoryIndexes,baseline_migrations:{files:migrationFiles,total_bytes:inputs.reduce((n,s) => n+Buffer.byteLength(s),0),max_statement_bytes:Math.max(...baseStatements.map(s => Buffer.byteLength(s)))},
      candidate_migration:{...migration.metrics,local_d1_elapsed_ms:migrationMs,...migrationMeta,atomic_batch:true},pre_compaction:pre,storage,
      non_fts_identical:true,fts_fields_identical:true,db_size_difference_bytes:storage.category.db_size_bytes-storage.baseline.db_size_bytes,
      db_size_difference_percent:100*(storage.category.db_size_bytes/storage.baseline.db_size_bytes-1)});
    await save('corpus-baseline.json',corpusStatistics(a,'baseline',fixture));
    await save('corpus-category.json',corpusStatistics(b,'category',fixture));
  } finally {a.close();b.close();}
  await save('manifest.json',{snapshot:evidence.snapshot_commit,products:48134,fixture_sha256:fixtureHash,legacy_sha256:legacy.hash,extended_sha256:extended.hash,
    implementation_sha256:implementationHash,node:process.version,locations,source_location:args['source-location'],measurement_engine:'local D1/workerd; not remote D1',extended_review_status:evidence.review_status});
  await writeFile('.cache/corpus-ab-latest.json',JSON.stringify({directory:root},null,2)+'\n');
}
const manifest=await load('manifest.json');
assert.equal(manifest.fixture_sha256,fixtureHash); assert.equal(manifest.implementation_sha256,implementationHash);
async function open(corpus) {
  const l=manifest.locations[corpus];
  const proxy=await getPlatformProxy({configPath:l.configPath,persist:{path:path.join(l.state,'v3')}});
  return {query:(sql,params=[]) => proxy.env.DB.prepare(sql).bind(...params).all(),close:()=>proxy.dispose()};
}
if (['all','measure'].includes(args.stage)) {
  const dbs={};
  try {
    for (const corpus of ['baseline','category']) dbs[corpus]=await open(corpus);
    const reports={};
    for (const corpus of ['baseline','category']) {
      const db=dbs[corpus],catalog=await loadQualityCatalog(db),build=experimentQuery(corpus);
      console.log(`${corpus}: ${fixture.length} Golden queries, three rankings`);
      const report=await benchmarkSearch(db,catalog,fixture,{fixtureHash,searchImplementationHash:implementationHash,queryBuilder:build});
      assert(!report.results.some(r => r.status==='EXPECTED_DATA_INVALID'),JSON.stringify(report.results.filter(r => r.status==='EXPECTED_DATA_INVALID').map(r => ({id:r.id,reason:r.reason}))));
      const modes={};
      for (const mode of ['without_bm25','bm25_only']) modes[mode]=await benchmarkSearch(db,catalog,fixture,{fixtureHash,queryBuilder:experimentQuery(corpus,mode)});
      for (const r of report.results) {
        const item=fixture.find(x => x.id===r.id),q=build(item.category,{...item.search,keyword:item.query,limit:20,debug:true});
        const trace=await db.query(q.sql,q.params);
        assert.deepEqual(trace.results.map(p => p.upstream_key),r.top_results.map(p => p.upstream_key),`${r.id}: debug changes top20`);
        r.top_results=trace.results.map((p,i) => ({...r.top_results[i],search_match:p.search_match,search_score:p.search_score,search_fts_relevance:p.search_fts_relevance,
          model_score:p.model_score,spec_score:p.spec_score,manufacturer_score:p.manufacturer_score,freshness_score:p.freshness_score,search_fallback:p.search_fallback}));
        const details=(await db.query(`EXPLAIN QUERY PLAN ${r.sql}`,r.params)).results.map(p => p.detail);
        r.query_plan={details,catalog_full_scan:hasCatalogFullScan(details),temp_b_tree:details.filter(d => d.includes('TEMP B-TREE'))};
        const without=modes.without_bm25.results.find(x => x.id===r.id),only=modes.bm25_only.results.find(x => x.id===r.id);
        const change=rankChange(without.rank,r.rank);
        r.bm25={normal_rank:r.rank,rank_without_bm25:without.rank,rank_bm25_only:only.rank,delta:change.delta,effect:change.regressed?'degraded':change.improved?'improved':'unchanged',
          without_top20:without.top_results,bm25_only_top20:only.top_results};
        r.fallback_used=r.top_results.some(p => p.search_fallback===1);
        r.performance20={samples:[]};
      }
      report.integrity=await integrity(db,corpus); assert(report.integrity.pass);
      report.representative_plans=await queryPlans(db,corpus);
      try {assertGolden({fixture_sha256:legacy.hash,results:report.results.filter(r=>r.suite!=='extended')});report.legacy_floor_gate={pass:true};}
      catch(e) {report.legacy_floor_gate={pass:false,error:e.message};}
      reports[corpus]=report;
      await save(`${corpus}.json`,report);
    }
    // An unrecorded warmup, then paired rounds with alternating A/B order.
    for (let round=-1;round<repeats;round++) {
      console.log(`Paired performance round ${round+1}/${repeats}`);
      for (const item of fixture) for (const corpus of (round%2 ? ['category','baseline']:['baseline','category'])) {
        const q=experimentQuery(corpus)(item.category,{...item.search,keyword:item.query,limit:20});
        const start=performance.now(),result=await dbs[corpus].query(q.sql,q.params),elapsed=performance.now()-start;
        if (round>=0) reports[corpus].results.find(r => r.id===item.id).performance20.samples.push({rows_read:result.meta.rows_read,sql_duration_ms:result.meta.duration,elapsed_ms:elapsed,returned:result.results.length});
      }
    }
    for (const corpus of ['baseline','category']) {
      const report=reports[corpus];
      for (const r of report.results) for (const field of ['rows_read','sql_duration_ms','elapsed_ms']) {
        r.performance20[`${field}_median`]=quantile(r.performance20.samples.map(s => s[field]),.5);
        r.performance20[`${field}_p95`]=quantile(r.performance20.samples.map(s => s[field]),.95);
      }
      report.aggregates=aggregate(report.results);
      report.performance20=aggregate(report.results.map(r => ({...r,rows_read:r.performance20.rows_read_median,sql_duration_ms:r.performance20.sql_duration_ms_median})));
      await save(`${corpus}.json`,report);
    }
    const comparison=compareRuns(reports.baseline,reports.category);
    await save('comparison.json',comparison);
    assert(reports.baseline.legacy_floor_gate.pass,'Baseline fails existing reviewed Golden floors');
    assert(Object.values(reports).every(r=>r.representative_plans.every(p=>p.pass)),'Existing representative query plan gate failed; see saved reports');
    console.log(JSON.stringify({legacy_acceptance:comparison.legacy_acceptance,regressions:comparison.regressions.map(r => ({id:r.id,before:r.baseline_rank,after:r.new_rank})),overlap:comparison.overlap},null,2));
  } finally {for (const db of Object.values(dbs)) await db.close();}
}
if (['all','cost'].includes(args.stage)) {
  const snapshot=await loadSnapshot(); assert.equal(snapshot.commit,manifest.snapshot);
  const costs={};
  try {await copyFile(path.join(root,'sync-cost.json'),path.join(root,`sync-cost-previous-${Date.now()}.json`));}
  catch(e) {if (e.code!=='ENOENT') throw e;}
  for (const corpus of ['baseline','category']) {
    // Cost workload runs on a further clone so reports and baseline stay immutable.
    const source=new DatabaseSync(manifest.locations[corpus].sqlitePath,{readOnly:true});
    const directory=path.join(root,`${corpus}-cost`),state=path.join(directory,'state');
    const dbdir=path.join(state,'v3/d1/miniflare-D1DatabaseObject'); await mkdir(dbdir,{recursive:true});
    const sqlitePath=path.join(dbdir,path.basename(manifest.locations[corpus].sqlitePath));
    try {await backup(source,sqlitePath);} finally {source.close();}
    const configPath=path.join(directory,'wrangler.json'); await copyFile(manifest.locations[corpus].configPath,configPath);
    const proxy=await getPlatformProxy({configPath,persist:{path:path.join(state,'v3')}});
    let totals;
    const db={async query(sql,params=[]) {
      const result=await proxy.env.DB.prepare(sql).bind(...params).all();
      if (totals) {totals.rows_written+=result.meta.rows_written??0;totals.rows_read+=result.meta.rows_read??0;totals.sql_duration_ms+=result.meta.duration??0;totals.executed_statements++;}
      return result;
    }};
    const measuredSync=async options=>{
      totals={rows_written:0,rows_read:0,sql_duration_ms:0,executed_statements:0};
      const start=performance.now(),report=await syncSnapshot(db,snapshot,options);
      const measurement={...report,reported_rows_written:report.rows_written,reported_rows_read:report.rows_read,...totals,duration_ms:performance.now()-start};totals=null;
      return measurement;
    };
    try {
      const noChange=await measuredSync({reuseComplete:true});
      // Force a full update of the IDENTICAL normalized source records, outside
      // timing. Hash invalidation is an isolated experimental workload, not sync.
      await db.query("UPDATE products SET content_hash='experiment-force-refresh'");
      const refresh=await measuredSync();
      costs[corpus]={no_change:noChange,full_refresh:refresh,integrity:await integrity(db,corpus),workload:'48,134 updates of unchanged snapshot; initial insert cost is not inferred from this workload',counter_scope:'All D1 statements issued by syncSnapshot, including final report update and lease release. reported_* retains the narrower syncSnapshot report counters.'};
      assert(costs[corpus].integrity.pass);assert.equal(refresh.updated,48134);assert.equal(refresh.status,'complete');
    } finally {await proxy.dispose();}
    await save('sync-cost.json',costs);
  }
}
console.log(`Reports saved: ${root}`);
