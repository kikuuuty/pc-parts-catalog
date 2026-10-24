import { categories } from '../model.js';
import { categoryCountDeltaError } from '../../scripts/lib/category-count-guard.js';

// Broad failure signals, separate from schema diagnostics. Thresholds are
// reviewed policy, not per-product exceptions. See docs/resilient-sync.md.
export const QUALITY_POLICY = { version: 1, quarantineFraction: .1, quarantineCount: 5, fieldLossFraction: .2, fieldLossCount: 20, initialMissingFraction: .5, smallCategory: 20 };
export const primaryFields = {
  cpu: ['socket', 'core_count'], memory: ['ram_type', 'capacity_gb'], motherboard: ['socket', 'ram_type'],
  gpu: ['chipset', 'vram_gb'], storage: ['capacity_gb'], psu: ['wattage'], case: ['form_factor'],
  case_fan: ['size_mm'], cpu_cooler: ['water_cooled'], monitor: ['screen_size_inches', 'resolution_width', 'resolution_height'],
  mouse: ['shape'], headphones: ['headphone_type'], keyboard: ['switch_type'], webcam: ['resolution'],
};
// These fields have stable broad coverage in the reviewed normal snapshot.
// Sparse peripheral specs (e.g. Mouse.shape) use baseline deltas, not a floor.
const initialCategories = new Set(['cpu','memory','motherboard','gpu','storage','psu','case','case_fan','cpu_cooler','monitor','webcam']);
export function ingestionQuality(snapshot, baseline, previous = {}) {
  const held = structuredClone(snapshot.heldCategories ?? {}), stats = {};
  const observed = snapshot.presence !== undefined;
  for (const category of categories) {
    const before = baseline.filter(r => r.active && r.record.product.category === category).map(r => r.record);
    const accepted = snapshot.records.filter(r => r.product.category === category);
    const present = snapshot.presence?.filter(r => r.category === category).length ?? accepted.length;
    const quarantined = snapshot.quarantined?.filter(r => r.category === category).length ?? 0;
    const hold = reason => { if (!(held[category] ??= []).includes(reason)) held[category].push(reason); };
    const byKey = new Map(before.map(r => [r.product.upstream_key, r]));
    const fields = {};
    if (observed && before.length && categoryCountDeltaError(category, before.length, present)) hold('category_count_delta');
    if (observed && quarantined && (quarantined === present || quarantined >= QUALITY_POLICY.quarantineCount && quarantined / present > QUALITY_POLICY.quarantineFraction || present <= QUALITY_POLICY.smallCategory && quarantined / present > QUALITY_POLICY.fieldLossFraction)) hold('quarantine_rate');
    const metrics = [...(primaryFields[category] ?? []).map(field => [field, r => r.spec[field] != null]),
      ['identifiers', r => r.identifiers.length > 0],
      ...['mpn','ean','upc','gtin','jan'].map(type => [`identifier_${type}`, r => r.identifiers.some(i => i.type === type)])];
    for (const [field, has] of metrics) {
      const known = accepted.filter(has).length, previousKnown = before.filter(has).length;
      const comparable = accepted.filter(r => byKey.has(r.product.upstream_key) && has(byKey.get(r.product.upstream_key)));
      const lost = comparable.filter(r => !has(r)).length;
      fields[field] = { known, total: accepted.length, rate: accepted.length ? known / accepted.length : null, previous_known: previousKnown, comparable: comparable.length, lost };
      if (!observed) continue;
      const significant = lost >= QUALITY_POLICY.fieldLossCount || before.length <= QUALITY_POLICY.smallCategory && lost > 0;
      if (significant && lost / comparable.length > QUALITY_POLICY.fieldLossFraction) hold(`coverage_loss:${field}`);
      if (!before.length && initialCategories.has(category) && !field.startsWith('identifier') && accepted.length &&
        (accepted.length >= QUALITY_POLICY.fieldLossCount && known / accepted.length < 1 - QUALITY_POLICY.initialMissingFraction || accepted.length <= QUALITY_POLICY.smallCategory && known === 0)) hold(`initial_coverage:${field}`);
    }
    const priorIds = accepted.reduce((n,r) => n + (byKey.get(r.product.upstream_key)?.identifiers.length ?? 0), 0);
    const lostIds = accepted.reduce((n,r) => n + Math.max(0, (byKey.get(r.product.upstream_key)?.identifiers.length ?? 0) - r.identifiers.length), 0);
    if (observed && lostIds > 0 && lostIds / priorIds > QUALITY_POLICY.fieldLossFraction && (lostIds >= QUALITY_POLICY.fieldLossCount || before.length <= QUALITY_POLICY.smallCategory && lostIds === priorIds)) hold('identifier_element_loss');
    const old = previous[category];
    stats[category] = { presence: present, accepted: accepted.length, quarantined, retained: 0, previous_active: before.length,
      fields, invalid_to_unknown: snapshot.report?.categories?.[category]?.invalid_to_unknown ?? 0,
      identifiers: accepted.reduce((n,r) => n + r.identifiers.length, 0),
      previous_identifiers: before.reduce((n,r) => n + r.identifiers.length, 0),
      lost_identifier_elements: lostIds,
      last_good_commit: held[category] || quarantined ? old?.last_good_commit ?? before[0]?.product.source_commit ?? null : snapshot.commit,
      held_since: held[category] || quarantined ? old?.held_since ?? snapshot.observedAt ?? new Date().toISOString() : null,
      reasons: held[category] ?? [] };
  }
  return { policy: QUALITY_POLICY, held, categories: stats };
}
