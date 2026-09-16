import { models, categories, ftsName } from '../../src/model.js';

export function categoryMigration() {
  const extract = path => `json_extract(new.payload,'$.${path}')`;
  const pid = `(SELECT id FROM products WHERE source='buildcores' AND upstream_key=${extract('product.upstream_key')})`;
  const columns = ['upstream_id','upstream_key','category','manufacturer','name','series','variant','release_year','manufacturer_url','identity_version','content_hash','source_commit','normalization_version'];
  const statements = [
    'DROP TRIGGER ingest_search_fields', 'DROP TRIGGER ingest_product',
    'CREATE TABLE product_search_documents (product_id INTEGER PRIMARY KEY REFERENCES products(id), text TEXT NOT NULL)',
    // Historical corpora are read exactly once during upgrade, never routed at runtime.
    'INSERT INTO product_search_documents SELECT rowid,text FROM product_fts UNION ALL SELECT rowid,text FROM extended_product_fts',
    `CREATE TRIGGER ingest_product AFTER INSERT ON ingest BEGIN
      INSERT INTO products(source,${columns.join(',')}) VALUES('buildcores',${columns.map(c => extract(`product.${c}`)).join(',')})
      ON CONFLICT(source,upstream_key) DO UPDATE SET ${columns.filter(c => c !== 'upstream_key').map(c => `${c}=excluded.${c}`).join(',')},active=1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now');
      INSERT INTO upstream_raw VALUES(${pid},${extract('raw')}) ON CONFLICT(product_id) DO UPDATE SET raw_json=excluded.raw_json;
      DELETE FROM upstream_identifiers WHERE product_id=${pid};
      INSERT INTO upstream_identifiers(product_id,type,value,value_key,region,origin_field)
        SELECT ${pid},json_extract(value,'$.type'),json_extract(value,'$.value'),json_extract(value,'$.value_key'),json_extract(value,'$.region'),json_extract(value,'$.origin_field') FROM json_each(new.payload,'$.identifiers');
      DELETE FROM product_facets WHERE product_id=${pid};
      INSERT INTO product_facets SELECT ${pid},json_extract(value,'$.attribute'),json_extract(value,'$.value') FROM json_each(new.payload,'$.facets');
      DELETE FROM ingest WHERE id=new.id;
    END`,
  ];
  for (const category of categories) {
    const model = models[category], index = ftsName(category), fields = Object.keys(model.fields);
    const projection = id => `SELECT p.id,d.text,v.name,v.manufacturer,v.series,v.variant,v.family
      FROM products p JOIN product_search_documents d ON d.product_id=p.id JOIN product_search_projection v ON v.product_id=p.id
      WHERE p.id=${id} AND p.category='${category}' AND p.active=1`;
    const insert = id => `INSERT INTO ${index}(rowid,text,name,manufacturer,series,variant,family) ${projection(id)};`;
    statements.push(
      `CREATE VIRTUAL TABLE ${index} USING fts5(text,name,manufacturer,series,variant,family,tokenize='unicode61',prefix='2 3 4')`,
      `INSERT INTO ${index}(rowid,text,name,manufacturer,series,variant,family)
        SELECT p.id,d.text,v.name,v.manufacturer,v.series,v.variant,v.family FROM products p
        JOIN product_search_documents d ON d.product_id=p.id JOIN product_search_projection v ON v.product_id=p.id WHERE p.category='${category}' AND p.active=1`,
      `CREATE TRIGGER ${category}_ingest BEFORE DELETE ON ingest WHEN json_extract(old.payload,'$.product.category')='${category}' BEGIN
        INSERT INTO ${model.table}(${['product_id', ...fields].join(',')}) VALUES(${pid.replaceAll('new.payload','old.payload')}${fields.length ? ',' : ''}${fields.map(f => extract(`spec.${f}`).replaceAll('new.payload','old.payload')).join(',')})
          ON CONFLICT(product_id) DO ${fields.length ? `UPDATE SET ${fields.map(f => `${f}=excluded.${f}`).join(',')}` : 'NOTHING'};
        INSERT INTO product_search_documents VALUES(${pid.replaceAll('new.payload','old.payload')},json_extract(old.payload,'$.search_text')) ON CONFLICT(product_id) DO UPDATE SET text=excluded.text;
      END`,
      ...['INSERT','UPDATE'].map(event => `CREATE TRIGGER ${category}_document_${event.toLowerCase()} AFTER ${event} ON product_search_documents
        WHEN (SELECT category FROM products WHERE id=new.product_id)='${category}' BEGIN
        DELETE FROM ${index} WHERE rowid=new.product_id; ${insert('new.product_id')} END`),
      `CREATE TRIGGER ${category}_product_update AFTER UPDATE OF category,active,name,manufacturer,series,variant ON products
        WHEN old.category='${category}' OR new.category='${category}' BEGIN
        DELETE FROM ${index} WHERE rowid=new.id; ${insert('new.id')}
        DELETE FROM ${model.table} WHERE product_id=new.id AND new.category<>'${category}'; END`,
      `CREATE TRIGGER ${category}_product_delete BEFORE DELETE ON products WHEN old.category='${category}' BEGIN
        DELETE FROM ${index} WHERE rowid=old.id; DELETE FROM ${model.table} WHERE product_id=old.id; END`,
    );
  }
  statements.push(`CREATE TRIGGER product_dependencies_delete BEFORE DELETE ON products BEGIN
    ${['upstream_raw','upstream_identifiers','local_identifiers','local_enrichments','product_facets','product_search_documents'].map(t => `DELETE FROM ${t} WHERE product_id=old.id;`).join('\n')}
    END`,
    // A numeric search ID must never be recycled after a hard delete.
    'CREATE TABLE product_id_sequence (singleton INTEGER PRIMARY KEY CHECK(singleton=1), high_water INTEGER NOT NULL)',
    'INSERT INTO product_id_sequence SELECT 1,coalesce(max(id),0) FROM products',
    `CREATE TRIGGER product_id_no_reuse AFTER INSERT ON products BEGIN
      SELECT CASE WHEN new.id<=(SELECT high_water FROM product_id_sequence) THEN RAISE(ABORT,'Product ID reuse prohibited') END;
      UPDATE product_id_sequence SET high_water=new.id; END`,
    'DROP TABLE product_fts', 'DROP TABLE extended_product_fts');
  // Explicit IDs allow normal ingestion after deleting the highest rowid.
  statements[4] = statements[4].replace('INSERT INTO products(source,', 'INSERT INTO products(id,source,')
    .replace("VALUES('buildcores',", "VALUES(coalesce((SELECT id FROM products WHERE source='buildcores' AND upstream_key=json_extract(new.payload,'$.product.upstream_key')),(SELECT high_water+1 FROM product_id_sequence)),'buildcores',");
  const sql = '-- Generated by scripts/generate-schema.js. Category-specific production search.\n' + statements.map(s => s+';').join('\n')+'\n';
  const metrics = { migration_bytes: Buffer.byteLength(sql), statement_count: statements.length,
    max_statement_bytes: Math.max(...statements.map(s => Buffer.byteLength(s+';'))),
    max_create_trigger_bytes: Math.max(...statements.filter(s => s.startsWith('CREATE TRIGGER')).map(s => Buffer.byteLength(s+';'))) };
  if (metrics.max_statement_bytes >= 50000) throw new Error('Migration statement exceeds reviewed 50KB budget');
  return { sql, statements, metrics };
}
