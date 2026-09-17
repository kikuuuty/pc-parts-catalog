export const KEYWORD_WINDOW = 1000;
export const searchWindow = input => input.keyword === undefined ? null : KEYWORD_WINDOW;
export const DISPLAY_ORDER = 'display-v1';

// Canonical query context deliberately excludes page size and expansions.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical).sort((a,b) => {
    const x=JSON.stringify(a),y=JSON.stringify(b);
    return x<y?-1:x>y?1:0;
  });
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k,canonical(value[k])]));
  return value;
}
const encode = text => btoa(String.fromCharCode(...new TextEncoder().encode(text))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
const digest = async text => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))), b => b.toString(16).padStart(2,'0')).join('');
export async function cursorContext(input, epoch = 'unversioned') {
  return { category:input.category, order:input.orderBy && input.orderBy!=='relevance' ? input.orderBy : DISPLAY_ORDER,
    epoch, fingerprint:await digest(JSON.stringify(canonical({filters:input.filters??{},ranges:input.ranges??{},facets:input.facets??{},identifier:input.identifier??null}))) };
}
export async function encodeCursor(context, values) {
  const payload=JSON.stringify({v:1,...context,last:values});
  return encode(JSON.stringify({payload,checksum:await digest(payload)}));
}
export async function decodeCursor(token, context) {
  try {
    if(typeof token!=='string'||token.length>3000||!/^[A-Za-z0-9_-]+$/.test(token)) throw Error();
    const envelope=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(token.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0))));
    if(typeof envelope.payload!=='string'||envelope.checksum!==await digest(envelope.payload)) throw Error();
    const c=JSON.parse(envelope.payload);
    if(c.v!==1||Object.keys(context).some(k=>c[k]!==context[k])) throw Error();
    validateSortValues(c.last,context.order!==DISPLAY_ORDER);
    return c.last;
  } catch { throw new Error('Invalid cursor'); }
}
export function validateSortValues(values, custom = false) {
  const last=custom ? values?.slice(2) : values;
  const text=v=>typeof v==='string'&&v.length<=1000&&!/[\u0000-\u001f]/.test(v);
  if(!Array.isArray(values)||values.length!==(custom?7:5)||!text(last[0])||![0,1].includes(last[1])||!text(last[2])||!text(last[3])||!Number.isSafeInteger(last[4])||last[4]<1||last[1]===1&&last[2]!=='') throw Error('Invalid cursor values');
  if(custom&&(![0,1].includes(values[0])||!(text(values[1])||typeof values[1]==='number'&&Number.isFinite(values[1])))) throw Error('Invalid cursor values');
}

// Empty series sorts as an empty string; only SQL NULL sorts last. NOCASE is
// SQLite's ASCII case folding, matching the index and seek predicate exactly.
export function displayTerms(alias = 'p', prefix = '') {
  const col=k=>`${alias}.${prefix}${k}`;
  return [`coalesce(${col('manufacturer')},'') COLLATE NOCASE`,`${col('series')} IS NULL`,`coalesce(${col('series')},'') COLLATE NOCASE`,`coalesce(${col('name')},'') COLLATE NOCASE`,col('id')];
}
