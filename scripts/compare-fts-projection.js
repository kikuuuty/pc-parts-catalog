import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { openDatabase } from '../src/database.js';
import { captureProjection, compareProjection } from './lib/fts-verification.js';

const { values: args, positionals: [command, left, right] } = parseArgs({ allowPositionals: true, options: {
  remote: { type: 'boolean', default: false }, search: { type: 'boolean', default: false },
  'data-only': { type: 'boolean', default: false }, output: { type: 'string' },
} });
if (!args.output) throw new Error('Specify --output for the verification artifact');
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
  // Scores/order are diagnostic only. Source invariance is an opt-in data check.
  if (args['data-only'] && report.data_changed_tables.length) process.exitCode = 1;
} else throw new Error('Usage: snapshot [--remote] [--search] --output file | compare before.json after.json [--data-only] --output file');
