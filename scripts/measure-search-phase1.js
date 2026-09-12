// Repeatable, read-only measurements on the same local D1 as the CLI.
import { readFile, writeFile } from 'node:fs/promises';
import { openDatabase } from '../src/database.js';
import { searchQuery } from '../src/queries.js';

const label = process.argv[2];
if (!['before','after'].includes(label)) throw new Error('Use before or after');
const cases = [
  ...['14900k','14900ks','9800x3d','285k','ryzen 7'].map(keyword => ['cpu',keyword]),
  ...['990pro','990 pro','sn850x','sn 850x'].map(keyword => ['storage',keyword]),
  ...['rtx5080','rtx 5080','gaming x trio 5080'].map(keyword => ['gpu',keyword]),
];
const db = await openDatabase();
try {
  const results = [];
  for (const [category,keyword] of cases) {
    const q = searchQuery(category, { keyword, limit: 100, debug: true });
    const plan = (await db.query(`EXPLAIN QUERY PLAN ${q.sql}`,q.params)).results.map(r => r.detail);
    const start = performance.now();
    const page = await db.query(q.sql,q.params);
    results.push({ category, keyword, elapsed_ms: performance.now()-start, meta: page.meta, plan,
      results: page.results.map((p,i) => ({ rank:i+1, id:p.id, upstream_id:p.upstream_id, name:p.name, series:p.series, variant:p.variant, score:p.search_score, match:p.search_match })) });
  }
  const size = { bytes: results[0].meta?.size_after ?? null };
  const report = { label, size, results };
  await writeFile(`.cache/search-cases-${label}-phase1.json`, JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({ label, size, cases: results.map(r => ({ query:r.keyword, count:r.results.length, top:r.results.slice(0,3), rows_read:r.meta?.rows_read })) },null,2));
  if (label === 'after') {
    const load = async name => JSON.parse(await readFile(`.cache/${name}`,'utf8'));
    const before = await load('search-before-phase1.json');
    const after = await load('search-after-phase1.json');
    const beforeCases = await load('search-cases-before-phase1.json');
    if (before.catalog.catalog_sha256 !== after.catalog.catalog_sha256 || before.fixture_sha256 !== after.fixture_sha256) {
      throw new Error('Before/after catalog or Golden fixture fingerprints differ');
    }
    const stats = values => {
      const sorted = values.toSorted((a,b) => a-b);
      return { sum:values.reduce((a,b) => a+b,0), median:(sorted[Math.floor((sorted.length-1)/2)]+sorted[Math.floor(sorted.length/2)])/2, max:sorted.at(-1) };
    };
    const comparison = {
      catalog_sha256: after.catalog.catalog_sha256, fixture_sha256:after.fixture_sha256,
      implementation_sha256:after.search_implementation_sha256,
      before:before.summary, after:after.summary,
      ranks:after.results.map((r,i) => ({ query:r.query,before:before.results[i].rank,after:r.rank })),
      benchmark_elapsed_ms:{before:stats(before.results.map(r => r.elapsed_ms)),after:stats(after.results.map(r => r.elapsed_ms))},
      benchmark_rows_read:{before:stats(before.results.map(r => r.rows_read)),after:stats(after.results.map(r => r.rows_read))},
      case_sql_duration_ms:{before:stats(beforeCases.results.map(r => r.meta.duration)),after:stats(results.map(r => r.meta.duration))},
      case_rows_read:results.map((r,i) => ({query:r.keyword,before:beforeCases.results[i].meta.rows_read,after:r.meta.rows_read})),
      size_bytes:{before:beforeCases.size.bytes,after:size.bytes,delta:size.bytes-beforeCases.size.bytes},
      catalog_full_scans:results.filter(r => r.plan.some(d => /^SCAN (?:p|s)(?:$| USING)/.test(d))).map(r => r.keyword),
    };
    await writeFile('.cache/search-phase1-comparison.json',JSON.stringify(comparison,null,2)+'\n');
    console.log(JSON.stringify(comparison,null,2));
  }
} finally { await db.close(); }
