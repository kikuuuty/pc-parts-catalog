import { categories, models } from '../model.js';
import { auditScope, envelope, inScope, isMissing, manufacturerKey, nameKey, normalizedIdentifier, productSummary, validIdentifiers } from './catalog.js';

export function coverage(present, total) {
  if (!Number.isInteger(present) || !Number.isInteger(total) || present < 0 || total < present) throw new Error('Invalid coverage counts');
  return { total, present, missing: total - present, coverage: total ? present / total : null, missing_rate: total ? (total - present) / total : null };
}
function fieldsFor(catalog, category) {
  return [
    ...catalog.productFields.map(f => ({ ...f, key: `product.${f.name}`, value: p => p[f.name] })),
    ...Object.entries(models[category].fields).map(([name, type]) => ({ name, type, key: `spec.${name}`, value: p => p.spec?.[name] })),
  ];
}
function summarize(catalog, category, all, scope, selectedFields) {
  const selected = all.filter(p => inScope(p, scope));
  const fieldResults = Object.fromEntries(selectedFields.map(f => [f.key, {
    type: f.type, ...coverage(selected.filter(p => !isMissing(f.value(p))).length, selected.length),
  }]));
  const identifierResults = {};
  for (const type of ['any', ...catalog.identifierTypes]) {
    identifierResults[type] = coverage(selected.filter(p => validIdentifiers(p).some(i => type === 'any' || i.type === type)).length, selected.length);
  }
  return {
    category, label: models[category].label, total_products: all.length,
    active_products: all.filter(p => p.active === 1).length, evaluated_products: selected.length,
    unknown_release_year: selected.filter(p => isMissing(p.release_year)).length,
    missing_spec_rows: selected.filter(p => !p.spec).length,
    fields: fieldResults, identifiers: identifierResults,
  };
}
export function auditCompleteness(catalog, options = {}) {
  const scope = auditScope(options);
  const requested = scope.category ? [scope.category] : categories;
  const field = options.field;
  if (field !== undefined && (typeof field !== 'string' || !requested.some(c => fieldsFor(catalog, c).some(f => f.name === field || f.key === field)))) throw new Error(`Unknown field in selected categories: ${field}`);
  const reports = [];
  for (const category of requested) {
    const selectedFields = fieldsFor(catalog, category).filter(f => field === undefined || f.key === field || f.name === field);
    if (!selectedFields.length) continue;
    const all = catalog.products.filter(p => p.category === category && inScope(p, scope, false));
    const report = summarize(catalog, category, all, scope, selectedFields);
    if (options.byManufacturer) {
      const groups = new Map();
      for (const p of all) {
        const key = manufacturerKey(p.manufacturer);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(p);
      }
      report.manufacturers = [...groups].sort(([a],[b]) => (a ?? '').localeCompare(b ?? '', 'en')).map(([key, rows]) => ({
        manufacturer: key === null ? null : rows[0].manufacturer, manufacturer_key: key,
        ...summarize(catalog, category, rows, scope, selectedFields),
      }));
    }
    reports.push(report);
  }
  const total = reports.reduce((sum,c) => sum+c.evaluated_products,0);
  return {
    ...envelope('completeness', catalog, scope), field: field ?? null,
    summary: {
      total_products: reports.reduce((sum,c) => sum+c.total_products,0),
      active_products: reports.reduce((sum,c) => sum+c.active_products,0), evaluated_products: total,
      unknown_release_year: reports.reduce((sum,c) => sum+c.unknown_release_year,0),
      identifiers: Object.fromEntries(['any',...catalog.identifierTypes].map(type => [type,coverage(reports.reduce((sum,c) => sum+c.identifiers[type].present,0),total)])),
    },
    categories: reports,
  };
}

export function auditDuplicates(catalog, options = {}) {
  const scope = auditScope(options);
  const products = catalog.products.filter(p => inScope(p, scope));
  const identifierGroups = new Map();
  const nameGroups = new Map();
  let invalidIdentifiers = 0;
  let keyMismatches = 0;
  for (const p of products) {
    const identifiers = validIdentifiers(p);
    invalidIdentifiers += p.identifiers.length - identifiers.length;
    for (const i of identifiers) {
      const valueKey = normalizedIdentifier(i);
      if (valueKey !== i.value_key) keyMismatches++;
      const vendor = i.type === 'mpn' ? manufacturerKey(p.manufacturer) : null;
      const key = JSON.stringify([i.type, vendor, valueKey]);
      if (!identifierGroups.has(key)) identifierGroups.set(key, { type: i.type, value_key: valueKey, manufacturer_key: vendor, members: new Map() });
      const group = identifierGroups.get(key);
      if (!group.members.has(p.id)) group.members.set(p.id, { ...productSummary(p), evidence: [] });
      group.members.get(p.id).evidence.push({ value: i.value, region: i.region, origin: i.origin, origin_field: i.origin_field });
    }
    const normalizedName = nameKey(p.name);
    if (normalizedName) {
      const key = JSON.stringify([p.category, manufacturerKey(p.manufacturer), normalizedName]);
      if (!nameGroups.has(key)) nameGroups.set(key, { category: p.category, manufacturer_key: manufacturerKey(p.manufacturer), name_key: normalizedName, products: [] });
      nameGroups.get(key).products.push({ ...productSummary(p), has_identifier: identifiers.length > 0 });
    }
  }
  const conflicts = [...identifierGroups.values()].filter(g => g.members.size > 1).map(g => ({
    classification: 'IDENTIFIER_CONFLICT', type: g.type, value_key: g.value_key,
    manufacturer_key: g.manufacturer_key, manufacturer_missing: g.type === 'mpn' && g.manufacturer_key === null,
    product_count: g.members.size, products: [...g.members.values()].sort((a,b) => a.id-b.id),
  })).sort((a,b) => b.product_count-a.product_count || JSON.stringify([a.type,a.manufacturer_key,a.value_key]).localeCompare(JSON.stringify([b.type,b.manufacturer_key,b.value_key]), 'en'));
  const names = [...nameGroups.values()].filter(g => g.products.length > 1).map(g => ({
    classification: 'POSSIBLE_DUPLICATE_NAME', ...g, product_count: g.products.length,
    products_without_identifiers: g.products.filter(p => !p.has_identifier).length,
  })).sort((a,b) => b.product_count-a.product_count || JSON.stringify([a.category,a.manufacturer_key,a.name_key]).localeCompare(JSON.stringify([b.category,b.manufacturer_key,b.name_key]), 'en'));
  return {
    ...envelope('duplicates', catalog, scope),
    summary: {
      evaluated_products: products.length, products_without_identifiers: products.filter(p => !validIdentifiers(p).length).length,
      identifier_conflict_groups: conflicts.length,
      identifier_conflict_products: new Set(conflicts.flatMap(g => g.products.map(p => p.id))).size,
      identifier_conflicts_by_type: Object.fromEntries(catalog.identifierTypes.map(type => [type, conflicts.filter(g => g.type === type).length])),
      possible_name_duplicate_groups: names.length,
      possible_name_duplicate_products: new Set(names.flatMap(g => g.products.map(p => p.id))).size,
      name_groups_including_identifierless_products: names.filter(g => g.products_without_identifiers > 0).length,
      invalid_identifier_rows: invalidIdentifiers, identifier_key_mismatch_rows: keyMismatches,
    },
    identifier_conflicts: conflicts, possible_name_duplicates: names,
  };
}
