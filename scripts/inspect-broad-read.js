import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/database.js';
import { searchCTEs } from './lib/broad-workload.js';

const baseline = JSON.parse(await readFile('.cache/broad-read-before.json', 'utf8'));
const cases = baseline.results.filter(r => ['broad:memory:ddr5', 'broad:cpu:ryzen 7', 'broad:case:atx', 'exact:14900k'].includes(r.id));
const db = await openDatabase();
const report = [];
try {
  for (const q of cases) {
    const phases = [];
    for (const phase of ['strict_fts', 'strict', 'ranked', 'scored']) {
      const result = await db.query(`${searchCTEs(q.sql)}SELECT * FROM ${phase}`, q.params.slice(0, -2));
      phases.push({ phase, rows: result.results.length, reads: result.meta.rows_read, sql_ms: result.meta.duration });
    }
    const variants = [];
    for (const names of [['strict_fts'], ['strict'], ['ranked'], ['strict_fts', 'strict', 'ranked']]) {
      const sql = names.reduce((sql, name) => sql.replace(`${name} AS MATERIALIZED`, `${name} AS NOT MATERIALIZED`), q.sql);
      try {
        const result = await db.query(sql, q.params);
        assert.deepEqual(result.results, q.rows);
        variants.push({ names, reads: result.meta.rows_read, plan: (await db.query(`EXPLAIN QUERY PLAN ${sql}`, q.params)).results });
      } catch (error) { variants.push({ names, error: error.message }); }
    }
    report.push({ id: q.id, before: q.meta.rows_read, phases, plan: q.plan, bytecode: q.bytecode, variants });
  }
  await writeFile('.cache/broad-read-analysis.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report.map(r => ({ ...r, plan: undefined, bytecode: undefined, variants: r.variants.map(v => ({ ...v, plan: undefined })) })), null, 2));
} finally { await db.close(); }
