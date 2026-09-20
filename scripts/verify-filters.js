import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { openDatabase } from '../src/database.js';
import { defaultRepo, loadSnapshot } from '../src/upstream.js';
import { verifyFilterMetadata } from './lib/filter-verification.js';
import { verifyFilterSmoke } from './lib/filter-smoke.js';
import { pacedRequests } from './lib/production-smoke.js';
import { saveValidationReport } from './lib/validation-report.js';

const { values: args } = parseArgs({ options: { url: { type: 'string' }, repo: { type: 'string', default: defaultRepo }, output: { type: 'string', default: '.cache/filter-verification.json' } } });
if (args.url) assert(['http://127.0.0.1:8787', 'http://localhost:8787'].includes(args.url), 'Use the local Worker (comparison DB is local)');
const snapshot = await loadSnapshot(args.repo);
const db = await openDatabase();
let report;
try {
  report = await verifyFilterMetadata(db, { snapshot, output: args.output, measurement: 'local D1/workerd; query adapter, not Worker batch' });
  if (args.url) {
    report.http = {};
    await verifyFilterSmoke(pacedRequests(args.url), snapshot, { local: true, report: report.http });
    await saveValidationReport(args.output, report);
  }
  console.log(JSON.stringify({ output: args.output, status: report.status, categories: report.categories.length, sql_statements: report.sql_statements, rows_read: report.rows_read }));
} catch (error) {
  if (report) { report.status = 'failed'; report.pass = false; await saveValidationReport(args.output, report, error); }
  console.error('Filter verification failed; inspect the diagnostic report'); process.exitCode = 1;
} finally { await db.close(); }
