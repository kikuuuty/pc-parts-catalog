// JAN values remain strings. No NFKC, padding, punctuation removal or EAN/GTIN inference.
export function validJan(value) {
  if (typeof value !== 'string') return false;
  const code = value.trim();
  if (!/^(?:\d{8}|\d{13})$/.test(code) || /^0+$/.test(code)) return false;
  let sum = 0;
  for (let i = code.length - 2, weight = 3; i >= 0; i--, weight = 4 - weight) {
    sum += (code.charCodeAt(i) - 48) * weight;
  }
  return (10 - sum % 10) % 10 === code.charCodeAt(code.length - 1) - 48;
}

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export function selectJan(identifiers) {
  const candidates = identifiers.filter(i => i.type === 'jan' && ['jp', 'all'].includes(i.region) && validJan(i.value));
  const local = i => (i.origins ?? [i]).some(o => o.origin === 'local') ? 0 : 1;
  candidates.sort((a, b) => (a.region === 'jp' ? 0 : 1) - (b.region === 'jp' ? 0 : 1)
    || local(a) - local(b) || compare(a.value.trim(), b.value.trim()));
  return candidates[0]?.value.trim() ?? null;
}
