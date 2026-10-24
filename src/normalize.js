import { createHash } from 'node:crypto';
import { models, NORMALIZER_VERSION } from './model.js';
import { text, identifierKey, manufacturer, positive, integer } from './normalizers/legacy.js';
import { safeInput, validateNormalized, InputIssue, limits } from './input-contract.js';
export { text, identifierKey, socket, manufacturer, cpuClass, gpuSeries, pcie } from './normalizers/legacy.js';

// Retained v1 reader verifies the last known good baseline without relabeling it.
export function normalizeV1(category, d, commit) { return project(category, d, commit, d, 1); }
export function normalize(category, raw, commit, issue = () => {}) {
  const d = safeInput(category, raw, issue);
  const result = project(category, d, commit, raw, NORMALIZER_VERSION, issue);
  if (Buffer.byteLength(JSON.stringify(result)) > limits.recordBytes) throw new InputIssue('normalized_size_limit', '');
  for (const [field, source] of Object.entries(models[category].scalarSources ?? {})) {
    if (result.spec[field] === null) issue({ code: 'unknown_spec', field: source, scope: 'field' });
  }
  return validateNormalized(result);
}
function project(category, d, commit, original, version, issue = () => {}) {
  if (!Object.hasOwn(models, category)) throw new Error(`Unsupported category: ${category}`);
  const model = models[category];
  const m = d.metadata;
  const spec = {};
  const facets = [];
  const facet = (attribute, values, transform = text) => {
    for (const value of new Set((values ?? []).map(transform).filter(Boolean))) {
      if (version > 1 && category === 'cpu_cooler' && attribute === 'socket' && value.length > limits.text) {
        issue({ code: 'derived_value_limit', field: 'cpu_sockets', scope: 'field' }); continue;
      }
      facets.push({ attribute, value });
    }
  };
  model.normalizer(d, spec, facet);
  if (version > 1) {
    // These established conversions can expand otherwise bounded inputs. Keep
    // their overflow a field issue; unexpected model types still fail validation.
    const numeric = category === 'memory' ? ['capacity_gb'] : ['gpu','storage'].includes(category) ? ['pcie_generation','pcie_lanes'] : [];
    for (const field of numeric) if (typeof spec[field] === 'number' && spec[field] > limits.number) {
      spec[field] = null; issue({ code: 'derived_value_limit', field, scope: 'field' });
    }
    if (['cpu','motherboard'].includes(category) && typeof spec.socket === 'string' && spec.socket.length > limits.text) {
      spec.socket = null; issue({ code: 'derived_value_limit', field: 'socket', scope: 'field' });
    }
  }
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
  const raw = JSON.stringify(original);
  const product = {
    upstream_id: d.opendb_id, upstream_key: `${model.upstream}/${d.opendb_id}`, category, manufacturer: manufacturer(m.manufacturer), name: text(m.name),
    series: text(m.series) ?? (category === 'cpu' ? text(d.series) : null), variant: text(m.variant),
    release_year: positive(integer(m.releaseYear)), manufacturer_url: text(d.general_product_information?.manufacturer_url),
    identity_version: d.identifiers?.version ?? null,
    content_hash: createHash('sha256').update(`${version}:${category}:${raw}`).digest('hex'),
    source_commit: commit, normalization_version: version,
  };
  const search_text = [product.manufacturer, product.name, product.series, product.variant, ...model.searchFields.map(field => spec[field]), ...identifiers.map(i => i.value)].filter(Boolean).join(' ');
  return { product, spec, identifiers, facets, raw, search_text };
}
