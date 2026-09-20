import { models } from '../model.js';

// Checks canonical storage against independently normalized source, including
// empty identifier/facet sets. A matching hash alone does not prove row integrity.
export async function verifySourceCatalog(db,catalog,snapshot, { sampleLimit = 50 } = {}) {
  if (!Number.isInteger(sampleLimit) || sampleLimit < 0 || sampleLimit > 200) throw new Error('Invalid integrity sample limit');
  const stored=new Map(catalog.products.filter(p=>p.active===1).map(p=>[p.upstream_key,p]));
  const report = { schema_version: 2, snapshot_commit: snapshot.commit, sync: catalog.metadata.last_sync,
    status: 'running', pass: false, products: stored.size, expected_products: snapshot.records.length,
    products_checked: 0, raw_checked: 0, mismatch_count: 0, by_kind: {}, product_fields: {},
    sample_limit: sampleLimit, details: [], errors: [], omitted: 0, truncated: false };
  // Values (especially raw/provider data) never enter diagnostics. Count every
  // mismatch independently of the bounded sample; sampleLimit=0 cannot hide failure.
  const mismatch = (key, kind, field = null) => {
    report.mismatch_count++;
    report.by_kind[kind] = (report.by_kind[kind] ?? 0) + 1;
    if (kind === 'product_field') report.product_fields[field] = (report.product_fields[field] ?? 0) + 1;
    if (report.details.length < sampleLimit) {
      const upstream_key = String(key).replace(/[\r\n\t]/g, ' ').slice(0, 200);
      report.details.push({ upstream_key, kind, field });
      report.errors.push(`${upstream_key}: ${kind}${field ? `.${field}` : ''}`);
    } else { report.omitted++; report.truncated = true; }
  };
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const sorted=rows=>rows.map(r=>JSON.stringify(r)).sort();
  const expected=new Map(snapshot.records.map(r=>[r.product.upstream_key,r]));
  try {
  for(const key of stored.keys())if(!expected.has(key))mismatch(key,'unexpected_active');
  for(const r of snapshot.records){
    const key=r.product.upstream_key,p=stored.get(key);
    if(!p){mismatch(key,'missing_active');continue;}
    report.products_checked++;
    // Product provenance is the last row update, NOT the completed catalog
    // snapshot. Unchanged hashes deliberately retain their previous commit.
    // Only source_commit is excluded; the release gate checks sync_runs separately.
    for (const [field, value] of Object.entries(r.product)) if (field !== 'source_commit' && p[field] !== value) mismatch(key, 'product_field', field);
    if(!p.spec)mismatch(key,'specs');
    else for (const field of Object.keys(models[r.product.category].fields)) if(p.spec[field]!==r.spec[field])mismatch(key,'specs',field);
    const identifiers=p.identifiers.filter(i=>i.origin==='upstream').map(({type,value,value_key,region,origin_field})=>({type,value,value_key,region,origin_field}));
    if(!same(sorted(identifiers),sorted(r.identifiers)))mismatch(key,'identifiers');
    if(!same(sorted(p.facets.map(({attribute,value})=>({attribute,value}))),sorted(r.facets)))mismatch(key,'facets');
  }
  let cursor=0;
  while(true){
    const rows=(await db.query('SELECT p.id,p.upstream_key,r.raw_json FROM products p LEFT JOIN upstream_raw r ON r.product_id=p.id WHERE p.active=1 AND p.id>? ORDER BY p.id LIMIT 250',[cursor])).results;
    if(!rows.length)break;
    for(const r of rows){report.raw_checked++;if(r.raw_json!==expected.get(r.upstream_key)?.raw)mismatch(r.upstream_key,'raw');}
    cursor=rows.at(-1).id;
  }
  report.pass = report.mismatch_count === 0;
  report.status = report.pass ? 'passed' : 'failed';
  return report;
  } catch (error) {
    report.status = 'failed'; report.failure = 'Source verification interrupted';
    error.sourceIntegrityReport = report;
    throw error;
  }
}
