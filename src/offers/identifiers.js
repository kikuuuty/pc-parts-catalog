// Shared GS1 retail barcode check digit. Call only after length/ASCII validation.
function validCheckDigit(code) {
  if (/^0+$/.test(code)) return false;
  let sum = 0;
  for (let i = code.length - 2, weight = 3; i >= 0; i--, weight = 4 - weight) {
    sum += (code.charCodeAt(i) - 48) * weight;
  }
  return (10 - sum % 10) % 10 === code.charCodeAt(code.length - 1) - 48;
}

// Preserve JAN's existing trim-only policy and JAN-8 support.
export function validJan(value) {
  return typeof value === 'string' && /^(?:\d{8}|\d{13})$/.test(value.trim()) && validCheckDigit(value.trim());
}

// EAN fallback is strictly thirteen ASCII digits as stored; no whitespace repair,
// NFKC, numeric coercion, padding or conversion from another canonical type.
export function validEan13(value) {
  return typeof value === 'string' && /^[0-9]{13}$/.test(value) && validCheckDigit(value);
}

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export const MAX_YAHOO_LOOKUP_CANDIDATES = 3;

// Yahoo lookup policy only: never mutate canonical identifier types or values.
// Enumerate all supported codes; the service bounds both cache and external attempts.
export function selectYahooLookupCandidates(identifiers) {
  const candidates = identifiers.filter(i => ['jp', 'all'].includes(i.region)
    && (i.type === 'jan' ? validJan(i.value) : i.type === 'ean' && validEan13(i.value)));
  const local = i => (i.origins ?? [i]).some(o => o.origin === 'local') ? 0 : 1;
  candidates.sort((a, b) => (a.type === 'jan' ? 0 : 1) - (b.type === 'jan' ? 0 : 1)
    || (a.region === 'jp' ? 0 : 1) - (b.region === 'jp' ? 0 : 1)
    || local(a) - local(b) || compare(a.value.trim(), b.value.trim()));
  const seen = new Set();
  return candidates.flatMap(i => {
    const value = i.type === 'jan' ? i.value.trim() : i.value;
    // Identical Yahoo queries, including across types/regions, get the best-ranked provenance.
    if (seen.has(value)) return [];
    seen.add(value);
    return [{ strategy: i.type === 'jan' ? 'jan' : 'ean13_as_jan', identifier_type: i.type, value }];
  });
}

export function selectJan(identifiers) {
  return selectYahooLookupCandidates(identifiers.filter(i => i.type === 'jan'))[0]?.value ?? null;
}
