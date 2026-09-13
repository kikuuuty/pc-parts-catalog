import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { openDatabase } from '../src/database.js';
import { captureProjection, compareProjection } from './lib/fts-verification.js';

const { values: args, positionals: [command, left, right] } = parseArgs({ allowPositionals: true, options: {
  remote: { type: 'boolean', default: false }, search: { type: 'boolean', default: false },
  'data-only': { type: 'boolean', default: false }, output: { type: 'string' },
  'order-only': { type: 'boolean', default: false },
} });
if (!args.output) throw new Error('Specify --output for the verification artifact');
if (args['data-only'] && args['order-only']) throw new Error('Choose data-only or order-only, not both');
if (command === 'snapshot') {
  const db = await openDatabase(args.remote);
  try {
    const report = await captureProjection(db, { search: args.search });
    await writeFile(args.output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ output: args.output, count: report.fts.count, sha256: report.fts.sha256,
      categories: report.fts.categories, counts: report.counts, tables: Object.fromEntries(Object.entries(report.tables).map(([k,v]) => [k,v.count])),
      foreign_key_errors: report.foreign_key_errors, size_bytes: report.size_bytes, queries: report.ranking.length, sync: report.sync }, null, 2));
  } finally { await db.close(); }
} else if (command === 'compare') {
  const reports = await Promise.all([left, right].map(file => readFile(file, 'utf8').then(JSON.parse)));
  const report = compareProjection(...reports);
  await writeFile(args.output, JSON.stringify(report, null, 2) + '\n');
  const { fts_differences, ...summary } = report;
  console.log(JSON.stringify(summary, null, 2));
  // Order-only still reports EVERY exact numeric discrepancy; it changes only
  // the exit criterion for cross-runtime diagnostics, never values or ranking.
  if (args['data-only'] ? report.data_changed_tables.length : report.fts_difference_count || report.ranking_changes.length || (!args['order-only'] && report.score_changes.length)) process.exitCode = 1;
} else throw new Error('Usage: snapshot [--remote] [--search] --output file | compare before.json after.json [--data-only|--order-only] --output file');
