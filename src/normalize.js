import { createHash } from 'node:crypto';
import { models, NORMALIZER_VERSION } from './model.js';
import { text, identifierKey, manufacturer, positive, integer } from './normalizers/legacy.js';
export { text, identifierKey, socket, manufacturer, cpuClass, gpuSeries, pcie } from './normalizers/legacy.js';

// Common identity/raw normalization is shared by every category. Upstream schema
// validation happens before this boundary; spec functions never infer identity.
export function normalize(category, d, commit) {
  if (!Object.hasOwn(models, category)) throw new Error(`Unsupported category: ${category}`);
  const model = models[category];
  const m = d.metadata;
  const spec = {};
  const facets = [];
  const facet = (attribute, values, transform = text) => {
    for (const value of new Set((values ?? []).map(transform).filter(Boolean))) facets.push({ attribute, value });
  };
  model.normalizer(d, spec, facet);
  for (const field of Object.keys(model.fields)) spec[field] ??= null;
  const identifiers = [];
  const seen = new Set();
  const addIdentifier = (i, origin_field) => {
    if (!i.value.trim()) return;
    const row = { type: i.type, value: i.value, value_key: identifierKey(i.value), region: i.region, origin_field };
    const key = JSON.stringify([row.type, row.value, row.region, origin_field]);
    if (!seen.has(key)) { seen.add(key); identifiers.push(row); }
  };
  for (const i of d.identifiers?.identifiers ?? []) addIdentifier(i, 'identifiers');
  for (const value of m.part_numbers ?? []) addIdentifier({ type: 'mpn', value, region: 'all' }, 'metadata.part_numbers');
  const raw = JSON.stringify(d);
  const product = {
    upstream_id: d.opendb_id, upstream_key: `${model.upstream}/${d.opendb_id}`, category, manufacturer: manufacturer(m.manufacturer), name: text(m.name),
    series: text(m.series) ?? (category === 'cpu' ? text(d.series) : null), variant: text(m.variant),
    release_year: positive(integer(m.releaseYear)), manufacturer_url: text(d.general_product_information?.manufacturer_url),
    identity_version: d.identifiers?.version ?? null,
    content_hash: createHash('sha256').update(`${NORMALIZER_VERSION}:${category}:${raw}`).digest('hex'),
    source_commit: commit, normalization_version: NORMALIZER_VERSION,
  };
  const search_text = [product.manufacturer, product.name, product.series, product.variant, ...model.searchFields.map(field => spec[field]), ...identifiers.map(i => i.value)].filter(Boolean).join(' ');
  return { product, spec, identifiers, facets, raw, search_text };
}
