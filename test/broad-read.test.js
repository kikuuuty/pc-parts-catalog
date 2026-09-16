import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { database } from '../test-support/database.js';
import { searchQuery } from '../src/queries.js';
import { normalize } from '../src/normalize.js';
import { syncSnapshot } from '../src/sync.js';
import { addLocalIdentifier } from '../src/enrichment.js';
import { searchCTEs, broadQueries, exactQueries } from '../scripts/lib/broad-workload.js';

async function setup(t) {
  const db = database(); t.after(() => db.sqlite.close());
  const commit = 'b'.repeat(40);
  const row = (category, name, data = {}, metadata = {}) => normalize(category, { opendb_id: randomUUID(), ...data,
    metadata: { manufacturer: 'Example', part_numbers: [], ...metadata, name } }, commit);
  await syncSnapshot(db, { commit, records: [
    ...Array.from({ length: 310 }, (_, i) => row('memory', i % 2 ? `Unlabelled kit ${i}` : `DDR5 32GB 6000 kit ${i}`,
      { ram_type: 'DDR5', capacity: 32, speed: 6000, cas_latency: 30 }, { manufacturer: i === 309 ? 'Late vendor' : 'Example' })),
    // Give typed index probes a realistic alternative to scanning a one-row table.
    ...Array.from({ length: 40 }, (_, i) => row('psu', `Other unit ${i}`, { wattage: 300 + i * 20 })),
    ...Array.from({ length: 40 }, (_, i) => row('storage', `Other drive ${i}`, { capacity: 100 + i * 50 })),
    ...Array.from({ length: 40 }, (_, i) => row('cpu_cooler', `Other cooler ${i}`, { water_cooled: true, radiator_size: 120 + i })),
    ...Array.from({ length: 40 }, (_, i) => row('case_fan', `Other fan ${i}`, { size: 40 + i })),
    row('memory', 'DDR5 missing specs'), row('memory', 'DDR5 contradictory specs', { ram_type: 'DDR4', capacity: 64 }),
    row('memory', 'DDR5 missing typed row'), row('memory', 'DDR5 inactive'),
    row('motherboard', 'DDR5 B650E WIFI', { chipset: 'AMD B650E', socket: 'AM5' }),
    row('motherboard', 'B650-E WIFI', { chipset: 'AMD B650' }),
    row('gpu', 'MSI RTX 5080 GAMING TRIO', { length: 300 }, { manufacturer: 'MSI' }),
    row('gpu', 'Other RTX 5080 GAMING X TRIO', { length: 350 }, { manufacturer: 'Other' }),
    row('cpu', 'AMD Ryzen 7 9800X3D', {}, { manufacturer: 'AMD', series: 'Ryzen 7', releaseYear: 2024 }),
    row('cpu', 'AMD Ryzen 7 1700X', {}, { manufacturer: 'AMD', series: 'Ryzen 7', releaseYear: 2017 }),
    row('cpu', 'AMD Ryzen 7 unknown year', {}, { manufacturer: 'AMD', series: 'Ryzen 7' }),
    row('cpu', 'Intel Core 14900K', {}, { manufacturer: 'Intel', part_numbers: ['BX14900K'] }),
    row('storage', 'Samsung 990 PRO 2TB', { capacity: 2000, nvme: true }),
    row('storage', 'Samsung 990 PRO unknown'), row('storage', 'SN850X 2TB', { capacity: 2000 }),
    row('psu', 'Unnamed unit', { wattage: 850, efficiency_rating: '80+ Gold' }),
    row('cpu_cooler', 'Unnamed cooler', { water_cooled: true, radiator_size: 360, cpu_sockets: ['AM5'] }),
    row('case_fan', 'Quiet PWM fan', { size: 120, pwm: true }),
  ] });
  await db.query("DELETE FROM memory WHERE product_id=(SELECT id FROM products WHERE name='DDR5 missing typed row')");
  await db.query("UPDATE products SET active=0 WHERE name='DDR5 inactive'");
  await db.query("UPDATE cpu SET manufacturer='Typed vendor' WHERE product_id=(SELECT id FROM products WHERE name='Intel Core 14900K')");
  for (const value of ['DDR5 LOCAL', 'DDR5 32GB']) await addLocalIdentifier(db, { productId: 1, type: 'mpn', value, evidence: 'Synthetic test' });
  await addLocalIdentifier(db, { productId: 1, type: 'jan', value: '0012345678901', evidence: 'Synthetic test' });
  return db;
}

test('public and debug retrieval preserve candidate sets, NULLs, duplicate sources and fallback', async t => {
  const db = await setup(t);
  const cases = [...broadQueries, ...exactQueries,
    { category: 'memory', keyword: 'ddr5 6000 cl30 32gb', filters: { manufacturer: 'Late vendor' } },
    { category: 'memory', keyword: 'example ddr5 32gb' },
    { category: 'memory', keyword: 'example' },
    { category: 'memory', keyword: '32gb 64gb' },
    { category: 'memory', keyword: '0012345678901' },
    { category: 'gpu', keyword: 'gaming x trio 5080', filters: { manufacturer: 'MSI' }, ranges: { length_mm: { max: 320 } } },
    { category: 'gpu', keyword: 'gaming x trio 5080' },
    { category: 'cpu', keyword: 'BX14900K', identifier: { type: 'mpn', value: 'BX14900K' } },
    { category: 'cpu_cooler', keyword: '360mm aio', facets: { socket: 'AM5' } },
  ];
  for (const item of cases) {
    const left = searchQuery(item.category, { ...item, debug: false });
    const right = searchQuery(item.category, { ...item, debug: true });
    const full = q => db.query(`${searchCTEs(q.sql)}SELECT id,relevance,fallback,tier,spec_score,manufacturer_score,freshness_score,score,match_type FROM scored ORDER BY id`, q.params.slice(0, -1));
    assert.deepEqual((await full(right)).results, (await full(left)).results, JSON.stringify(item));
    for (const offset of [0, 20, 100]) {
      const plain = searchQuery(item.category, { ...item, limit: 21, debug:false });
      const debug = searchQuery(item.category, { ...item, limit: 21, debug:true });
      const diagnostics=['search_score','search_match','search_fts_relevance','model_score','spec_score','manufacturer_score','freshness_score','search_fallback'];
      const rows=(await db.query(`${debug.sql} OFFSET ?`, [...debug.params, offset])).results
        .map(row=>Object.fromEntries(Object.entries(row).filter(([key])=>!diagnostics.includes(key))));
      assert.deepEqual(rows,(await db.query(`${plain.sql} OFFSET ?`, [...plain.params, offset])).results.map(row=>({...row})), `${item.keyword}: ${offset}`);
    }
  }
});

test('explicit display ordering is deterministic with ID ties and preserves the 100-bind contract', async t => {
  const db = await setup(t);
  for (const [category, keyword, orderBy] of [['cpu', '14900k', 'manufacturer'], ['cpu', 'ryzen 7', 'release_year'],
    ['memory', 'ddr5', 'capacity_gb'], ['gpu', 'rtx5080', 'length_mm']]) {
    const options = { keyword, orderBy, debug: true, limit: 21 };
    const q = searchQuery(category, options);
    const rows=(await db.query(q.sql,q.params)).results;
    const compare=(a,b)=>a[orderBy]===b[orderBy] ? a.id-b.id : a[orderBy]==null ? -1 : b[orderBy]==null ? 1 : a[orderBy]<b[orderBy] ? -1 : 1;
    assert.deepEqual(rows,[...rows].sort(compare));
  }
  const values = Array(20).fill('Example');
  const options = { keyword: 'ddr5 6000 cl30 32gb', filters: { manufacturer: values, series: values, variant: values, ecc: values, registered: values.slice(0, 16) } };
   const next = searchQuery('memory', options);
  assert.equal(next.params.length, 100);
  assert.equal((await db.query(next.sql, next.params)).results.length,0);
  assert.throws(() => searchQuery('memory', { ...options, filters: { ...options.filters, registered: values.slice(0, 17) } }), /100 bound/);
});

test('broad plans use FTS and typed indexes, PK probes, and stream public ranking without a result rejoin', async t => {
  const db = await setup(t);
  for (const item of broadQueries) {
    const q = searchQuery(item.category, item);
    const plan = (await db.query(`EXPLAIN QUERY PLAN ${q.sql}`, q.params)).results.map(r => r.detail);
    assert(!plan.some(d => /^SCAN (?:p|s)(?:$| USING)/.test(d)), `${item.keyword}: ${plan.join('; ')}`);
    assert(plan.some(d => d.includes(`${item.category}_fts VIRTUAL TABLE INDEX`)));
    assert(!plan.some(d => /MATERIALIZE (?:ranked|strict_fts)/.test(d)));
    assert(!q.sql.includes('scored r CROSS JOIN products'));
  }
});
