import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { remoteDatabaseId } from '../src/remote-config.js';

// Fail closed on placeholder/mismatched bindings and partial initial imports.
// Uses Wrangler authentication; no management token is installed in the Worker.
const config = JSON.parse(await readFile('wrangler.json', 'utf8'));
const id = remoteDatabaseId(config);
if (process.env.CLOUDFLARE_D1_DATABASE_ID && process.env.CLOUDFLARE_D1_DATABASE_ID !== id) throw new Error('CLI database override differs from Worker DB binding');
const command = 'SELECT name FROM d1_migrations ORDER BY id; SELECT status,source_commit FROM sync_runs ORDER BY started_at DESC,id DESC LIMIT 1; SELECT count(*) AS active FROM products WHERE active=1; PRAGMA foreign_key_check; SELECT count(*) AS leases FROM sync_lock WHERE expires_at>unixepoch();';
let results;
try {
  results = JSON.parse(execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'DB', '--remote', '--env', '', '--json', '--command', command], {
    encoding: 'utf8', env: { ...process.env, CI: 'true' }, stdio: ['ignore', 'pipe', 'inherit'],
  }));
} catch { throw new Error('Remote readiness check failed; authenticate with npx wrangler login and verify the DB binding'); }
const migrations = (await readdir('migrations')).filter(f => f.endsWith('.sql')).sort();
if (results.length !== 5 || results.some(r => r.success === false)) throw new Error('Incomplete D1 readiness response');
if (migrations.some(name => !results[0].results.some(r => r.name === name))) throw new Error('Remote migrations are not complete');
if (results[1].results[0]?.status !== 'complete' || !(results[2].results[0]?.active > 0)) throw new Error('Remote catalog sync must be complete before deploy');
if (results[3].results.length || results[4].results[0]?.leases !== 0) throw new Error('Foreign key errors or active sync lease; defer deployment');
console.log(JSON.stringify({ ready: true, worker: config.name, binding: 'DB', database: 'pc-parts-catalog', database_id: id, active: results[2].results[0].active, sync: results[1].results[0] }, null, 2));
