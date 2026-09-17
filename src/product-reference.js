export const MAX_RESOLVE_PRODUCTS = 64;
export function validateReferences(input) {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>k!=='products')||!Array.isArray(input.products)||input.products.length<1||input.products.length>MAX_RESOLVE_PRODUCTS) throw Error('products must contain 1–64 references');
  for(const ref of input.products) {
    if(!ref||typeof ref!=='object'||Array.isArray(ref)||Object.keys(ref).length!==2||typeof ref.source!=='string'||!/^[a-z][a-z0-9_-]{0,63}$/.test(ref.source)||typeof ref.upstream_key!=='string'||ref.upstream_key.length>200||!/^[-A-Za-z0-9_]+\/[-A-Za-z0-9_.]+$/.test(ref.upstream_key)) throw Error('Invalid product reference');
  }
  return input.products;
}
// One JSON bind, one indexed LEFT JOIN. Duplicate input and order are preserved.
export function resolveQuery(refs) {
  return { sql:`SELECT json_extract(j.value,'$.source') AS source,json_extract(j.value,'$.upstream_key') AS upstream_key,
    p.id,p.category,p.name,p.active FROM json_each(?) j LEFT JOIN products p
    ON p.source=json_extract(j.value,'$.source') AND p.upstream_key=json_extract(j.value,'$.upstream_key') ORDER BY CAST(j.key AS INTEGER)`,params:[JSON.stringify(refs)] };
}
export async function resolveProducts(execute, refs) {
  const q=resolveQuery(refs);
  return {products:(await execute(q.sql,q.params)).map(p=>({...p,active:p.id===null?null:p.active===1,status:p.id===null?'missing':p.active===1?'active':'inactive'}))};
}
