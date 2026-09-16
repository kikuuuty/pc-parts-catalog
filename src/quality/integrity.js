import { models } from '../model.js';

// Checks canonical storage against independently normalized source, including
// empty identifier/facet sets. A matching hash alone does not prove row integrity.
export async function verifySourceCatalog(db,catalog,snapshot) {
  const errors=[],stored=new Map(catalog.products.filter(p=>p.active===1).map(p=>[p.upstream_key,p]));
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const sorted=rows=>rows.map(r=>JSON.stringify(r)).sort();
  const expected=new Map(snapshot.records.map(r=>[r.product.upstream_key,r]));
  for(const [key,p] of stored)if(!expected.has(key))errors.push(`${key}: unexpected active product`);
  for(const r of snapshot.records){
    const key=r.product.upstream_key,p=stored.get(key);
    if(!p){errors.push(`${key}: missing active product`);continue;}
    if(Object.entries(r.product).some(([k,v])=>p[k]!==v))errors.push(`${key}: product fields`);
    if(!p.spec||Object.keys(models[p.category].fields).some(k=>p.spec[k]!==r.spec[k]))errors.push(`${key}: specs`);
    const identifiers=p.identifiers.filter(i=>i.origin==='upstream').map(({type,value,value_key,region,origin_field})=>({type,value,value_key,region,origin_field}));
    if(!same(sorted(identifiers),sorted(r.identifiers)))errors.push(`${key}: identifiers`);
    if(!same(sorted(p.facets.map(({attribute,value})=>({attribute,value}))),sorted(r.facets)))errors.push(`${key}: facets`);
  }
  let cursor=0,rawCount=0;
  while(true){
    const rows=(await db.query('SELECT p.id,p.upstream_key,r.raw_json FROM products p LEFT JOIN upstream_raw r ON r.product_id=p.id WHERE p.active=1 AND p.id>? ORDER BY p.id LIMIT 250',[cursor])).results;
    if(!rows.length)break;
    for(const r of rows){rawCount++;if(r.raw_json!==expected.get(r.upstream_key)?.raw)errors.push(`${r.upstream_key}: raw`);}
    cursor=rows.at(-1).id;
  }
  return {pass:errors.length===0,products:stored.size,expected_products:expected.size,raw_checked:rawCount,errors};
}
