import { models } from './model.js';
import { monitorPorts } from './extended-models.js';
import { identifierKey } from './normalizers/legacy.js';

// Catalog-owned contract. Never derived from the moving upstream schema.
export const INPUT_CONTRACT_VERSION = 1;
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export const limits = { rawBytes: 700000, recordBytes: 1500000, text: 200, name: 1000, url: 2048, array: 256, number: 1e9 };
export class InputIssue extends Error {
  constructor(code, field) { super(code); this.code = code; this.field = field; }
}
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const safeString = (v, max = limits.text) => typeof v === 'string' && v.isWellFormed() && v.trim().length > 0 && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
const safeIdentifier = v => safeString(v) && safeString(identifierKey(v), 1000);
const groups = (text = '', number = '', integer = '', boolean = '', array = '') => Object.fromEntries([
  ...text.split(' ').filter(Boolean).map(p => [p, 'text']), ...number.split(' ').filter(Boolean).map(p => [p, 'number']),
  ...integer.split(' ').filter(Boolean).map(p => [p, 'integer']), ...boolean.split(' ').filter(Boolean).map(p => [p, 'boolean']),
  ...array.split(' ').filter(Boolean).map(p => [p, 'array']),
]);
const legacy = {
  cpu: groups('series socket microarchitecture coreFamily', 'clocks.performance.base clocks.performance.boost specifications.tdp specifications.ppt specifications.memory.maxSupport', 'cores.total cores.threads cores.performance cores.efficiency', 'specifications.includesCooler', 'specifications.memory.types'),
  memory: groups('ram_type form_factor ecc registered', 'capacity modules.capacity_gb speed cas_latency height voltage', 'modules.quantity', '', 'profile_support'),
  motherboard: { ...groups('socket chipset form_factor memory.ram_type', 'memory.max', 'memory.slots storage_devices.sata_6_gb_s storage_devices.sata_3_gb_s', 'back_connect_connectors'), m2_slots: 'objects' },
  gpu: groups('chipset_manufacturer chipset memory_type interface', 'memory length tdp core_boost_clock total_slot_width', 'power_connectors.pcie_6_pin power_connectors.pcie_8_pin power_connectors.pcie_12VHPWR power_connectors.pcie_12V_2x6'),
  storage: groups('storage_type type form_factor interface', 'capacity cache', '', 'nvme'),
  psu: groups('form_factor efficiency_rating modular', 'wattage length', 'connectors.atx_24_pin connectors.eps_8_pin connectors.pcie_12vhpwr connectors.pcie_6_plus_2_pin'),
  case: groups('form_factor', 'max_video_card_length max_cpu_cooler_height max_psu_length dimensions_mm.depth dimensions_mm.width dimensions_mm.height volume', 'expansion_slots', 'supports_rear_connecting_motherboard', 'supported_motherboard_form_factors supported_power_supply_form_factors'),
  case_fan: groups('connector flow_direction', 'size min_airflow max_airflow min_noise_level max_noise_level static_pressure', 'quantity', 'pwm'),
  cpu_cooler: groups('', 'height radiator_size min_noise_level max_noise_level fan_size min_fan_rpm max_fan_rpm', 'fan_quantity', 'water_cooled', 'cpu_sockets'),
};
export function inputFields(category) {
  const m = models[category];
  const fields = { ...groups('metadata.manufacturer metadata.series metadata.variant general_product_information.manufacturer_url', '', 'metadata.releaseYear', '', 'metadata.part_numbers'), ...legacy[category] };
  for (const [field, source] of Object.entries(m.scalarSources ?? {})) fields[source] = m.inputTypes[field];
  for (const source of Object.values(m.facetSources ?? {})) fields[source] = 'array';
  if (category === 'monitor') for (const port of monitorPorts) fields[`video_outputs.${port}`] = 'integer';
  return fields;
}

export function safeInput(category, raw, issue = () => {}) {
  if (!Object.hasOwn(models, category)) throw new InputIssue('unsupported_category', 'category');
  if (!object(raw)) throw new InputIssue('invalid_structure', '');
  if (!UUID.test(raw.opendb_id ?? '')) throw new InputIssue('invalid_identity', 'opendb_id');
  if (!object(raw.metadata) || !safeString(raw.metadata.name, limits.name) || !/[\p{L}\p{N}]/u.test(raw.metadata.name)) throw new InputIssue('invalid_name', 'metadata.name');
  const pending = [[raw,0]]; let nodes = 0;
  while (pending.length) {
    const [value, depth] = pending.pop();
    if (++nodes > 50000 || depth > 32) throw new InputIssue('raw_structure_limit', '');
    if (value && typeof value === 'object') for (const child of Object.values(value)) pending.push([child,depth+1]);
  }
  if (Buffer.byteLength(JSON.stringify(raw)) > limits.rawBytes) throw new InputIssue('raw_size_limit', '');
  const clean = { opendb_id: raw.opendb_id, metadata: { name: raw.metadata.name } };
  const selected = Object.create(null);
  for (const source of ['opendb_id','metadata.name','identifiers',...Object.keys(inputFields(category))]) {
    let node = selected;
    for (const key of source.split('.')) node = node[key] ??= Object.create(null);
  }
  const unmodeled = (value, tree, prefix = '') => {
    if (!object(value)) return;
    for (const key of Object.keys(value)) {
      const field = prefix ? `${prefix}.${key}` : key;
      if (!Object.hasOwn(tree, key)) issue({ code: 'unmodeled_field', field: field.slice(0,200), scope: 'diagnostic' });
      else if (Object.keys(tree[key]).length) unmodeled(value[key],tree[key],field);
    }
  };
  unmodeled(raw,selected);
  const emit = (code, field) => issue({ code, field, scope: 'field' });
  const read = source => {
    let value = raw, prefix = '';
    for (const key of source.split('.')) {
      if (value == null) return value;
      if (!object(value)) { emit('invalid_object', prefix); return null; }
      value = value[key]; prefix = prefix ? `${prefix}.${key}` : key;
    }
    return value;
  };
  const set = (source, value) => {
    const keys = source.split('.'); let node = clean;
    for (const key of keys.slice(0, -1)) node = node[key] ??= {};
    node[keys.at(-1)] = value;
  };
  for (const [source, type] of Object.entries(inputFields(category))) {
    const value = read(source);
    if (value == null) { set(source, null); continue; }
    const max = source.endsWith('manufacturer_url') ? limits.url : limits.text;
    if (type === 'array' || type === 'objects') {
      if (!Array.isArray(value) || value.length > limits.array) { emit('invalid_array', source); set(source, null); continue; }
      if (type === 'objects') {
        // Only the count is used. Invalid elements make that count unknown.
        const valid = value.every(object); if (!valid) emit('invalid_array_element', source);
        set(source, valid ? value.map(() => ({})) : null); continue;
      }
      const values = value.filter((v, i) => {
        if (source === 'metadata.part_numbers' ? safeIdentifier(v) : safeString(v)) return true;
        emit('invalid_array_element', `${source}/${i}`); return false;
      });
      // profile_support determines booleans: an unknown enum is NOT false.
      if (source === 'profile_support' && (values.length !== value.length || values.some(v => !['XMP', 'EXPO'].includes(v)))) {
        emit('unknown_semantic_value', source); set(source, null);
      } else set(source, values);
      continue;
    }
    const valid = (source !== 'metadata.releaseYear' || value <= 9999) && (type === 'text' ? safeString(value, max) : type === 'boolean' ? typeof value === 'boolean'
      : typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= limits.number && (type !== 'integer' || Number.isSafeInteger(value)));
    if (!valid) emit('invalid_value', source);
    set(source, valid ? value : null);
  }
  // DATA_MODEL.md: version is an optimistic-concurrency snapshot counter,
  // NOT a format generation (the documented example is version 3).
  // Only this object/array layout and legacy metadata.part_numbers are supported.
  if (raw.identifiers != null) {
    const ids = raw.identifiers;
    if (!object(ids) || !Number.isSafeInteger(ids.version) || ids.version < 1 || 'schema_version' in ids || 'format_version' in ids || !Array.isArray(ids.identifiers) || ids.identifiers.length > limits.array) emit('unsupported_identifiers', 'identifiers');
    else {
      clean.identifiers = { version: ids.version, identifiers: [] };
      for (const [index, id] of ids.identifiers.entries()) {
        if (!object(id) || !['mpn', 'ean', 'upc', 'jan', 'gtin'].includes(id.type) || !safeIdentifier(id.value) || !safeString(id.region, 32)
          || (id.type !== 'mpn' && !({ ean: /^\d{8}$|^\d{13}$/, upc: /^\d{8}$|^\d{12}$/, jan: /^\d{8}$|^\d{13}$/, gtin: /^\d{8}$|^\d{12,14}$/ }[id.type].test(id.value.trim())))) {
          emit('invalid_identifier', `identifiers.identifiers/${index}`); continue;
        }
        clean.identifiers.identifiers.push({ type: id.type, value: id.value, region: id.region });
      }
    }
  }
  return clean;
}

// Internal failures are invariants/bugs, never InputIssue quarantine.
export function validateNormalized(record) {
  const { product: p, spec, identifiers, facets, raw, search_text } = record;
  const fail = () => { throw new Error('Internal normalized model invariant violated'); };
  if (!Object.hasOwn(models, p.category) || !UUID.test(p.upstream_id) || p.upstream_key !== `${models[p.category].upstream}/${p.upstream_id}` || !safeString(p.name, limits.name)) fail();
  if (!/^[a-f0-9]{64}$/.test(p.content_hash) || !/^[a-f0-9]{40}$/.test(p.source_commit) || !Number.isSafeInteger(p.normalization_version)) fail();
  for (const field of ['manufacturer','series','variant','manufacturer_url']) if (p[field] !== null && !safeString(p[field], field === 'manufacturer_url' ? limits.url : limits.text)) fail();
  if (p.release_year !== null && (!Number.isInteger(p.release_year) || p.release_year < 1 || p.release_year > 9999)) fail();
  if (p.identity_version !== null && (!Number.isSafeInteger(p.identity_version) || p.identity_version < 1)) fail();
  for (const [field, type] of Object.entries(models[p.category].fields)) {
    const v = spec[field];
    if (v === null) continue;
    if (type === 'TEXT' ? !safeString(v) : typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > Number.MAX_SAFE_INTEGER || type === 'INTEGER' && !Number.isSafeInteger(v)) fail();
  }
  for (const i of identifiers) if (!['mpn','ean','upc','jan','gtin'].includes(i.type) || !safeString(i.value) || !safeString(i.value_key, 1000) || !safeString(i.region, 32) || !['identifiers','metadata.part_numbers'].includes(i.origin_field)) fail();
  for (const f of facets) if (!models[p.category].facets.includes(f.attribute) || !safeString(f.value)) fail();
  if (typeof raw !== 'string' || typeof search_text !== 'string' || Buffer.byteLength(JSON.stringify(record)) > limits.recordBytes) fail();
  return record;
}
