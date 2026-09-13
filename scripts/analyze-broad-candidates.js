import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/database.js';
import { searchCTEs } from './lib/broad-workload.js';
import { models } from '../src/model.js';

const before = JSON.parse(await readFile('.cache/broad-read-before.json', 'utf8'));
const after = JSON.parse(await readFile('.cache/broad-read-after.json', 'utf8'));
const canonical = JSON.parse(await readFile('.cache/fts-local-upgraded.json', 'utf8'));
const db = await openDatabase();
const report = { cases: [] };
try {
  for (const q of before.results.filter(r => r.group === 'broad')) {
    const terms = JSON.parse(q.params.find(p => typeof p === 'string' && p.startsWith('{"strict":')));
    const fts = (await db.query('SELECT rowid AS id FROM product_fts WHERE product_fts MATCH ?', [terms.literalPrefix ?? terms.strict.prefix])).results;
    const typedSQL = q.sql.match(/UNION ALL SELECT id,0 FROM \(([\s\S]*?)LIMIT 256\s*\)/)?.[1];
    const typed = typedSQL ? (await db.query(`${searchCTEs(q.sql)}${typedSQL} LIMIT 256`, q.params.slice(0, -2))).results
      : terms.intent.identity ? (await db.query(`SELECT s.product_id AS id FROM ${models[q.category].table} s
        WHERE s.chipset IN (${terms.intent.identity.values.map(() => '?').join(',')})
        ${terms.identityResidual ? 'AND EXISTS (SELECT 1 FROM product_fts WHERE rowid=s.product_id AND product_fts MATCH ?)' : ''}`,
      [...terms.intent.identity.values, ...(terms.identityResidual ? [terms.identityResidual] : [])])).results : [];
    const ftsIds = new Set(fts.map(r => r.id));
    const next = after.results.find(r => r.id === q.id);
    report.cases.push({ id: q.id, fts_hits: fts.length, bounded_spec_seed: typedSQL !== undefined, identity_seed: !!terms.intent.identity,
      typed_count: typed.length, cap_reached: !!typedSQL && typed.length === 256,
      typed_not_in_literal_fts: typed.filter(r => !ftsIds.has(r.id)).length,
      candidates: q.candidates.length, candidate_scores_equal: q.candidates_sha256 === next.candidates_sha256,
      before_materializations: q.plan.filter(r => /MATERIALIZE/.test(r.detail)).map(r => r.detail),
      after_materializations: next.plan.filter(r => /MATERIALIZE/.test(r.detail)).map(r => r.detail),
      before_match_scans: q.plan.filter(r => /product_fts VIRTUAL TABLE INDEX/.test(r.detail)).length,
      after_match_scans: next.plan.filter(r => /product_fts VIRTUAL TABLE INDEX/.test(r.detail)).length });
  }
  // Compare every FTS column with the previously verified canonical local snapshot.
  const hash = createHash('sha256');
  let cursor = 0, count = 0;
  while (true) {
    const rows = (await db.query(`SELECT f.rowid AS id,p.category,p.upstream_key,f.text,f.name,f.manufacturer,f.series,f.variant,f.family
      FROM product_fts f LEFT JOIN products p ON p.id=f.rowid WHERE f.rowid>? ORDER BY f.rowid LIMIT 500`, [cursor])).results;
    if (!rows.length) break;
    for (const r of rows) hash.update(JSON.stringify([r.id, r.category, r.upstream_key, r.text, r.name, r.manufacturer, r.series, r.variant, r.family])).update('\n');
    count += rows.length; cursor = rows.at(-1).id;
  }
  report.fts = { count, sha256: hash.digest('hex') };
  assert.equal(count, canonical.fts.count);
  assert.equal(report.fts.sha256, canonical.fts.sha256);
  report.sort = [before, after].map(data => ({ engine: data.engine_sha256,
    offsets: data.results.filter(r => r.group === 'offset').map(r => ({ offset: r.offset,
      bytecode: r.bytecode.filter(op => ['OpenEphemeral', 'SorterOpen', 'OffsetLimit', 'IfNotZero', 'IdxLE', 'Last', 'Delete', 'Sort'].includes(op.opcode)) })) }));
  await writeFile('.cache/broad-candidate-analysis.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, sort: undefined }, null, 2));
} finally { await db.close(); }
