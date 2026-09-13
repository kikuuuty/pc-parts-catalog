import { readFile } from 'node:fs/promises';
import { openDatabase } from '../src/database.js';
import { productionConfig, readiness, safeDatabase } from './lib/release-gates.js';

try {
  productionConfig(JSON.parse(await readFile('wrangler.json', 'utf8')));
  const db = safeDatabase(await openDatabase(true));
  try {
    const { sync, active, cache_epoch } = await readiness(db);
    console.log(JSON.stringify({ ready: true, sync_id: sync.id, completed_at: sync.finished_at, active, cache_epoch }));
  } finally { await db.close(); }
} catch { console.error('Remote readiness failed; check authentication, migrations, sync completion and catalog integrity.'); process.exitCode = 1; }
