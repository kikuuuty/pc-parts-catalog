// Local D1 only. Clone a pinned local snapshot; never load credentials or remote bindings.
import assert from 'node:assert/strict';
import { DatabaseSync, backup } from 'node:sqlite';
import { readFile,writeFile,readdir,mkdir,mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { getPlatformProxy } from 'wrangler';
import { loadSnapshot } from '../src/upstream.js';
import { loadQualityCatalog } from '../src/quality/catalog.js';
import { loadUXFixture,evaluateUX,sourceCatalog,qualityFailures } from '../src/quality/ux.js';
import { syncSnapshot } from '../src/sync.js';
import { verifyPlans,hasCatalogFullScan } from '../src/queries.js';
import { detailProductQuery,detailQueries } from '../src/product-detail.js';
import { categories } from '../src/model.js';
import { categoryMigration } from './lib/category-migration.js';
import { ftsIntegrity } from './lib/fts-integrity.js';
import { storageStatistics,corpusStatistics } from './lib/corpus-statistics.js';
import { captureProjection,compareProjection } from './lib/fts-verification.js';
import { createWorker } from '../src/worker.js';
import { fakeLimiters } from '../test-support/rate-limiter.js';
import { verifySourceCatalog } from '../src/quality/integrity.js';
import { readiness } from './lib/release-gates.js';

const {values:args}=parseArgs({options:{'source-location':{type:'string',default:'.cache/all-categories-fresh-location.json'},directory:{type:'string'}}});
await mkdir('.cache',{recursive:true});
const root=path.resolve(args.directory??await mkdtemp('.cache/category-release-'));
assert(root.startsWith(path.resolve('.cache')+path.sep));
await mkdir(root,{recursive:true});
const save=(name,value)=>writeFile(path.join(root,name),JSON.stringify(value,null,2)+'\n');
const snapshot=await loadSnapshot();
assert.equal(snapshot.commit,'eec0df175504ebd15f0f3e3a8249a18a22f00940');assert.equal(snapshot.records.length,48134);
const manifestFile=path.join(root,'manifest.json');
let manifest;
try {manifest=JSON.parse(await readFile(manifestFile,'utf8'));} catch(error) {if(error.code!=='ENOENT') throw error;}
if(!manifest){
  const sourceLocation=JSON.parse(await readFile(args['source-location'],'utf8'));
  const sourceDir=path.join(sourceLocation.directory,'state/v3/d1/miniflare-D1DatabaseObject');
  const names=(await readdir(sourceDir)).filter(n=>n.endsWith('.sqlite')&&n!=='metadata.sqlite');assert.equal(names.length,1);
  const dbdir=path.join(root,'state/v3/d1/miniflare-D1DatabaseObject');await mkdir(dbdir,{recursive:true});
  const sqlitePath=path.join(dbdir,names[0]),configPath=path.join(root,'wrangler.json');
  const original=new DatabaseSync(path.join(sourceDir,names[0]),{readOnly:true});
  try {assert.equal(original.prepare('SELECT count(*) n FROM products WHERE active=1').get().n,48134);await backup(original,sqlitePath);}finally{original.close();}
  const config=JSON.parse(await readFile(sourceLocation.configPath,'utf8'));
  await writeFile(configPath,JSON.stringify({name:'category-search-local',compatibility_date:config.compatibility_date,
    d1_databases:config.d1_databases.map(d=>({...d,remote:false}))}));
  manifest={root,sqlitePath,configPath,snapshot:snapshot.commit,engine:'local D1/workerd (not remote D1)'};
  await save('manifest.json',manifest);
}
await writeFile('.cache/category-release-latest.json',JSON.stringify({directory:root},null,2));
console.log(`Local verification: ${root}`);
const proxy=await getPlatformProxy({configPath:manifest.configPath,persist:{path:path.join(root,'state/v3')}});
const db={query:(sql,params=[])=>proxy.env.DB.prepare(sql).bind(...params).all()};
let fixture;
try {
  const migrated=(await db.query("SELECT name FROM sqlite_schema WHERE name='cpu_fts'")).results.length;
  if(!migrated){
    const migration=categoryMigration(),start=performance.now();
    const result=await proxy.env.DB.batch([...migration.statements.map(sql=>proxy.env.DB.prepare(sql)),
      proxy.env.DB.prepare("INSERT INTO d1_migrations(name) VALUES('0008_category_fts.sql')")]);
    await save('migration.json',{...migration.metrics,elapsed_ms:performance.now()-start,
      rows_read:result.reduce((n,r)=>n+r.meta.rows_read,0),rows_written:result.reduce((n,r)=>n+r.meta.rows_written,0),
      sql_duration_ms:result.reduce((n,r)=>n+r.meta.duration,0),atomic_batch:true});
  }
  if(!(await db.query("SELECT 1 FROM d1_migrations WHERE name='0009_display_order.sql'")).results.length) {
    const sql=await readFile('migrations/0009_display_order.sql','utf8');
    const statements=sql.replace(/^--.*$/gm,'').split(';').map(s=>s.trim()).filter(Boolean);
    await proxy.env.DB.batch([...statements.map(s=>proxy.env.DB.prepare(s)),proxy.env.DB.prepare("INSERT INTO d1_migrations(name) VALUES('0009_display_order.sql')")]);
  }
  const integrity=await ftsIntegrity(db);assert(integrity.pass);assert.equal(integrity.active_products,48134);await save('integrity.json',integrity);
  await save('readiness.json',await readiness(db,{commit:snapshot.commit,expectedCounts:Object.fromEntries(Object.entries(snapshot.report.categories).map(([c,r])=>[c,r.count]))}));
  const catalog=await loadQualityCatalog(db), expected=sourceCatalog(snapshot,catalog);
  const catalogIntegrity=await verifySourceCatalog(db,catalog,snapshot);assert(catalogIntegrity.pass);
  await save('catalog-integrity.json',catalogIntegrity);
  const input=await loadUXFixture();fixture=input.fixture;const hash=input.hash;
  const quality=await evaluateUX(db,catalog,fixture,{fixtureHash:hash,source:expected});
  quality.release_failures=qualityFailures(quality);
  await save('quality.json',quality);console.log(JSON.stringify({by_intent:quality.by_intent,quality_failures:quality.release_failures},null,2));
  const plans=await verifyPlans(db);await save('plans.json',plans);
  assert(plans.every(p=>p.index_check),'Representative query-plan gate failed');
  const detailPlans=[];
  for(const category of categories){const id=catalog.products.find(p=>p.category===category&&p.active===1).id;
    for(const [kind,sql] of Object.entries({product:detailProductQuery.sql,...detailQueries(category)})) {
      const details=(await db.query(`EXPLAIN QUERY PLAN ${sql}`,[id])).results.map(r=>r.detail);
      const fullScan=hasCatalogFullScan(details)||details.some(d=>/^SCAN (?:upstream_identifiers|local_identifiers|product_facets)(?: |$)/.test(d));
      assert(!fullScan);detailPlans.push({category,kind,details,catalog_full_scan:fullScan});
    }}
  await save('detail-plans.json',detailPlans);
  const logs=[],cacheEntries=new Map();
  const worker=createWorker({log:e=>logs.push(e),cache:{async match(key){return cacheEntries.get(key.url)?.clone();},async put(key,r){cacheEntries.set(key.url,r.clone());}}});
  const env={DB:proxy.env.DB,...fakeLimiters({unlimited:true}),CATALOG_CACHE_EPOCH:'local-detail-validation'};
  const detailResponses=[];
  for(const category of categories){const p=catalog.products.find(p=>p.category===category&&p.active===1);
    const req=new Request(`https://local.catalog/v1/products/${p.id}`),response=await worker.fetch(req,env);assert.equal(response.status,200);
    const detail=await response.json();assert.equal(detail.id,p.id);assert.equal(detail.category,category);
    const hit=await worker.fetch(req,env);assert.equal(hit.headers.get('X-Cache'),'HIT');assert.equal(logs.at(-1).d1_queries,0);
    detailResponses.push({category,detail,miss:logs.at(-2),hit:logs.at(-1)});}
  assert.equal((await worker.fetch(new Request('https://local.catalog/v1/products/999999999'),env)).status,404);
  await save('detail-api.json',detailResponses);
  const before=await captureProjection(db),start=performance.now();
  const sync=await syncSnapshot(db,snapshot);const elapsed=performance.now()-start;
  const after=await captureProjection(db),diff=compareProjection(before,after);
  assert.equal(sync.unchanged,48134);assert.equal(diff.fts_difference_count,0);assert.deepEqual(diff.data_changed_tables.filter(t=>t!=='sync_runs'),[]);
  await save('sync-noop.json',{...sync,elapsed_ms:elapsed,integrity:await ftsIntegrity(db)});
} finally {await proxy.dispose();}
const sqlite=new DatabaseSync(manifest.sqlitePath);
try {await save('storage.json',storageStatistics(sqlite));await save('bm25-corpus.json',corpusStatistics(sqlite,fixture));}finally{sqlite.close();}
console.log(`Reports written to ${root}`);
