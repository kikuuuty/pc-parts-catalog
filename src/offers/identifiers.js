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
function selectIdentifier(identifiers, type, valid) {
  const candidates = identifiers.filter(i => i.type === type && ['jp', 'all'].includes(i.region) && valid(i.value));
  const local = i => (i.origins ?? [i]).some(o => o.origin === 'local') ? 0 : 1;
  candidates.sort((a, b) => (a.region === 'jp' ? 0 : 1) - (b.region === 'jp' ? 0 : 1)
    || local(a) - local(b) || compare(a.value.trim(), b.value.trim()));
  return candidates[0]?.value.trim() ?? null;
}

export function selectJan(identifiers) {
  return selectIdentifier(identifiers, 'jan', validJan);
}

// Yahoo lookup policy only: never mutate canonical identifier types or values.
export function selectYahooLookup(identifiers) {
  const jan = selectJan(identifiers);
  if (jan !== null) return { strategy: 'jan', identifier_type: 'jan', value: jan };
  const ean = selectIdentifier(identifiers, 'ean', validEan13);
  return ean === null ? null : { strategy: 'ean13_as_jan', identifier_type: 'ean', value: ean };
}
