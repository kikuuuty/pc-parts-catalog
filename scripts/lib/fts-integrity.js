import { categories, ftsName } from '../../src/model.js';

export async function ftsIntegrity(db) {
  const products = new Map();
  let cursor = 0;
  while (true) {
    const rows = (await db.query('SELECT id,category,active FROM products WHERE id>? ORDER BY id LIMIT 500', [cursor])).results;
    if (!rows.length) break;
    for (const p of rows) products.set(p.id, { ...p, documents: 0, correct: 0 });
    cursor = rows.at(-1).id;
  }
  let wrong = 0, orphan = 0, projectionDrift = 0;
  const counts = {};
  const schemaErrors=[];
  for (const category of categories) {
    const index = ftsName(category); cursor = 0; counts[index] = 0;
    const fields=(await db.query(`PRAGMA table_info(${index})`)).results.map(r=>r.name);
    if(JSON.stringify(fields)!==JSON.stringify(['text','name','manufacturer','series','variant','family']))schemaErrors.push(index);
    while (true) {
      const rows = (await db.query(`SELECT rowid AS id FROM ${index} WHERE rowid>? ORDER BY rowid LIMIT 500`, [cursor])).results;
      if (!rows.length) break;
      for (const row of rows) {
        counts[index]++;
        const p = products.get(row.id);
        if (!p || p.active !== 1) orphan++;
        if (p) { p.documents++; if (p.category === category) p.correct++; else wrong++; }
      }
      cursor = rows.at(-1).id;
    }
    projectionDrift += (await db.query(`SELECT count(*) AS n FROM ${index} f
      JOIN product_search_projection v ON v.product_id=f.rowid JOIN product_search_documents d ON d.product_id=f.rowid
      WHERE (f.text,f.name,f.manufacturer,f.series,f.variant,f.family) IS NOT (d.text,v.name,v.manufacturer,v.series,v.variant,v.family)`)).results[0].n;
  }
  const active = [...products.values()].filter(p => p.active === 1);
  const missingDocuments=(await db.query('SELECT count(*) n FROM products p LEFT JOIN product_search_documents d ON d.product_id=p.id WHERE p.active=1 AND d.product_id IS NULL')).results[0].n;
  const result = { active_products: active.length, counts,
    missing_fts_row: active.filter(p => p.correct === 0).length,
    duplicate_fts_row: [...products.values()].reduce((n,p) => n+Math.max(0,p.documents-1),0),
    wrong_category_row: wrong, inactive_orphan: orphan, projection_drift: projectionDrift,missing_search_documents:missingDocuments,schema_errors:schemaErrors };
  return { ...result, pass: ![result.missing_fts_row,result.duplicate_fts_row,wrong,orphan,projectionDrift,missingDocuments,schemaErrors.length].some(Boolean) };
}
