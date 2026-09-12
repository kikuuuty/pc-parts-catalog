import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultRepo, fetchUpstream, loadSnapshot } from './upstream.js';
import { openDatabase } from './database.js';
import { syncSnapshot } from './sync.js';
import { searchQuery, verifyPlans } from './queries.js';

const { values: args, positionals } = parseArgs({ allowPositionals: true, options: {
  remote: { type: 'boolean', default: false }, repo: { type: 'string', default: defaultRepo }, ref: { type: 'string', default: 'main' },
  'dry-run': { type: 'boolean', default: false }, 'max-products': { type: 'string' }, 'write-budget': { type: 'string' }, 'max-delete-fraction': { type: 'string', default: '0.2' },
  category: { type: 'string' }, keyword: { type: 'string' }, filters: { type: 'string' }, ranges: { type: 'string' }, facets: { type: 'string' },
  identifier: { type: 'string' }, 'identifier-type': { type: 'string' }, limit: { type: 'string' }, order: { type: 'string' }, explain: { type: 'boolean', default: false }, 'query-file': { type: 'string' },
} });
const [command] = positionals;
const print = object => console.log(JSON.stringify(object, null, 2));
const positiveInteger = (value, fallback) => {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('Expected a positive integer limit');
  return n;
};

async function main() {
  await mkdir('.cache', { recursive: true });
  if (command === 'fetch') return fetchUpstream({ repo: args.repo, ref: args.ref });
  if (command === 'migrate') {
    let config = 'wrangler.json';
    if (args.remote) {
      const id = process.env.CLOUDFLARE_D1_DATABASE_ID;
      if (!id || !/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Set CLOUDFLARE_D1_DATABASE_ID to the remote D1 UUID');
      const remote = JSON.parse(await readFile(config, 'utf8'));
      remote.d1_databases[0].database_id = id;
      remote.d1_databases[0].migrations_dir = path.resolve('migrations');
      config = '.cache/wrangler.remote.json';
      await writeFile(config, JSON.stringify(remote, null, 2));
    }
    execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'migrations', 'apply', 'DB', args.remote ? '--remote' : '--local', '--config', config], { stdio: 'inherit', env: { ...process.env, CI: 'true' } });
    return;
  }
  if (command === 'inspect') {
    const snapshot = await loadSnapshot(args.repo);
    print({ commit: snapshot.commit, counts: Object.fromEntries(Object.entries(snapshot.report.categories).map(([k,v]) => [k,v.count])), report: '.cache/inspection.json' });
    return;
  }
  if (!['sync','search','stats','plans'].includes(command)) throw new Error('Commands: fetch, inspect, migrate, sync, search, stats, plans. See README.md');
  // Fetch/validate/normalize the entire snapshot BEFORE opening a write connection.
  const snapshot = command === 'sync' ? await loadSnapshot(args.repo) : null;
  const db = await openDatabase(args.remote);
  try {
    if (command === 'sync') {
      const maxDeleteFraction = Number(args['max-delete-fraction']);
      if (!Number.isFinite(maxDeleteFraction) || maxDeleteFraction < 0 || maxDeleteFraction > 1) throw new Error('max-delete-fraction must be 0–1');
      const result = await syncSnapshot(db, snapshot, {
        dryRun: args['dry-run'], maxProducts: positiveInteger(args['max-products'], args.remote ? 1000 : Infinity),
        writeBudget: positiveInteger(args['write-budget'], args.remote ? 80_000 : Infinity), maxDeleteFraction,
      });
      await writeFile('.cache/sync-report.json', JSON.stringify(result, null, 2));
      print(result);
      if (result.status === 'partial') console.log('Partial sync: rerun with the same --repo snapshot to resume. On Free, wait for the next UTC day when the daily budget is exhausted.');
    } else if (command === 'search') {
      const config = args['query-file'] ? JSON.parse(await readFile(args['query-file'], 'utf8')) : {};
      const query = searchQuery(args.category ?? config.category, {
        keyword: args.keyword ?? config.keyword, filters: args.filters ? JSON.parse(args.filters) : config.filters, ranges: args.ranges ? JSON.parse(args.ranges) : config.ranges, facets: args.facets ? JSON.parse(args.facets) : config.facets,
        identifier: args.identifier ? { value: args.identifier, type: args['identifier-type'] } : config.identifier,
        limit: positiveInteger(args.limit, config.limit ?? 20), orderBy: args.order ?? config.orderBy,
      });
      print(await db.query(args.explain ? `EXPLAIN QUERY PLAN ${query.sql}` : query.sql, query.params));
    } else if (command === 'plans') {
      const reports = await verifyPlans(db);
      await writeFile('.cache/query-plans.json', JSON.stringify(reports, null, 2));
      print(reports.map(r => ({ name: r.name, passed: r.index_check, returned: r.returned, plan: r.plan })));
      if (reports.some(r => !r.index_check)) throw new Error('Expected index missing; inspect .cache/query-plans.json');
    } else {
      const counts = await db.query('SELECT category,active,count(*) AS count FROM products GROUP BY category,active ORDER BY category,active');
      const identifiers = await db.query('SELECT origin,type,count(*) AS count FROM identifiers GROUP BY origin,type');
      const integrity = await db.query('PRAGMA foreign_key_check');
      const lastRun = await db.query('SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 1');
      const stats = { counts: counts.results, identifiers: identifiers.results, foreign_key_errors: integrity.results, size_bytes: counts.meta?.size_after ?? null, last_run: lastRun.results };
      await writeFile('.cache/stats.json', JSON.stringify(stats, null, 2));
      print(stats);
    }
  } finally { await db.close(); }
}
main().catch(error => { console.error(error.stack ?? error.message); process.exitCode = 1; });
