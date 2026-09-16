// Verify that a complete refresh produces exactly the same FTS projection as the
// migration/backfill, and that sync preserves every non-timestamp source table.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { storageStatistics } from './lib/corpus-statistics.js';
const {values:args}=parseArgs({options:{directory:{type:'string'}}});
const root=path.resolve(args.directory ?? JSON.parse(await readFile('.cache/corpus-ab-latest.json','utf8')).directory);
const manifest=JSON.parse(await readFile(path.join(root,'manifest.json'),'utf8'));
const before=JSON.parse(await readFile(path.join(root,'schema.json'),'utf8'));
const report={};
for (const corpus of ['baseline','category']) {
  const file=path.join(root,`${corpus}-cost/state/v3/d1/miniflare-D1DatabaseObject`,path.basename(manifest.locations[corpus].sqlitePath));
  const sqlite=new DatabaseSync(file,{readOnly:true});
  try {
    const after=storageStatistics(sqlite,corpus),initial=before.storage[corpus];
    assert.equal(after.fts_projection_sha256,initial.fts_projection_sha256);
    const changes=Object.keys(initial.non_fts_tables).filter(t=>JSON.stringify(initial.non_fts_tables[t])!==JSON.stringify(after.non_fts_tables[t]));
    assert.deepEqual(changes.sort(),['products','sync_runs']);
    const original=new DatabaseSync(manifest.locations[corpus].sqlitePath,{readOnly:true});
    let verified=0;
    try {
      const lookup=original.prepare('SELECT * FROM products WHERE id=?');
      for (const row of sqlite.prepare('SELECT * FROM products ORDER BY id').iterate()) {
        const old=lookup.get(row.id);
        for (const key of Object.keys(row).filter(k=>k!=='updated_at')) assert.equal(row[key],old[key],`${row.id}.${key}`);
        verified++;
      }
    } finally {original.close();}
    assert.equal(verified,48134);
    report[corpus]={pass:true,products_verified:verified,fts_projection_sha256:after.fts_projection_sha256,
      changed_tables:changes,products_change:'updated_at only; all identities, content hashes and metadata checked',other_tables_identical:true};
  } finally {sqlite.close();}
}
await writeFile(path.join(root,'sync-integrity.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
