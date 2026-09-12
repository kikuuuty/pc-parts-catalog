import { models } from '../model.js';
import { nameKey } from './catalog.js';

// Evaluation-only predicates. These never become search filters or ranking inputs.
export function selectExpectedSet(catalog, category, selector) {
  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!object(selector) || Object.keys(selector).length !== 1 || !object(selector.set)) throw new Error('Invalid set selector');
  const { fields = {}, nameContains = [], nameTokens = [] } = selector.set;
  if (Object.keys(selector.set).some(k => !['fields','nameContains','nameTokens'].includes(k)) || !object(fields) ||
      !Array.isArray(nameContains) || nameContains.some(v => typeof v !== 'string' || !v.trim()) ||
      !Array.isArray(nameTokens) || nameTokens.some(v => typeof v !== 'string' || !/^[\p{L}\p{N}]+$/u.test(v)) ||
      !Object.keys(fields).length && !nameContains.length && !nameTokens.length) throw new Error('Set needs nonempty fields/nameContains/nameTokens');
  const types = Object.fromEntries([
    ...catalog.productFields.map(f => [`product.${f.name}`,f.type]),
    ...Object.entries(models[category].fields).map(([k,v]) => [`spec.${k}`,v]),
  ]);
  for (const [field,raw] of Object.entries(fields)) {
    if (!Object.hasOwn(types,field)) throw new Error(`Unknown expected field: ${field}`);
    const values = Array.isArray(raw) ? raw : [raw];
    if (!values.length || values.length > 20 || values.some(v => types[field] === 'TEXT'
      ? typeof v !== 'string' || !v.trim() : typeof v !== 'number' || !Number.isFinite(v))) throw new Error(`Invalid expected value: ${field}`);
  }
  return catalog.products.filter(p => p.category === category && p.active === 1 &&
    Object.entries(fields).every(([field,raw]) => {
      const [scope,key] = field.split('.');
      const actual = scope === 'product' ? p[key] : p.spec?.[key];
      if (actual == null) return false;
      return (Array.isArray(raw) ? raw : [raw]).some(v => types[field] === 'TEXT' ? nameKey(actual) === nameKey(v) : actual === v);
    }) && nameContains.every(v => nameKey(p.name)?.includes(nameKey(v))) &&
    nameTokens.every(v => (nameKey(p.name)?.match(/[\p{L}\p{N}]+/gu) ?? []).includes(nameKey(v))));
}
