import { validateReferences } from '../src/product-reference.js';

// Browser-ready adapter for shared URLs, localStorage and export/import. Store
// only durable references; runtime IDs/status are obtained again on restoration.
export function serializeBuild(products) {
  const refs=products.map(({source,upstream_key})=>({source,upstream_key}));
  validateReferences({products:refs});
  return JSON.stringify({version:1,products:refs});
}
export function parseBuild(text) {
  if(typeof text!=='string'||text.length>16384)throw Error('Invalid saved build');
  const build=JSON.parse(text);
  if(build.version!==1)throw Error('Unsupported saved build version');
  return validateReferences({products:build.products});
}
export function buildURL(base,products) {
  const url=new URL(base);
  url.hash=new URLSearchParams({build:serializeBuild(products)}).toString();
  return url.toString();
}
export function referencesFromURL(url) {
  return parseBuild(new URLSearchParams(new URL(url).hash.slice(1)).get('build'));
}
export async function restoreBuild(api,refs,fetcher=fetch) {
  validateReferences({products:refs});
  const response=await fetcher(new URL('/v1/products/resolve',api),{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({products:refs}),
  });
  if(!response.ok)throw Error(`Product resolution failed (${response.status})`);
  return (await response.json()).products;
}
