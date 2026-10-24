import assert from 'node:assert/strict';
import { models } from '../model.js';

// Only explicit unpublished identities/category holds can exclude a case.
// Never infer exclusions from query results, DB absence, names, or identifiers.
export function publicationCases(fixture, snapshot) {
  const plan = snapshot.applicationPlan;
  if (!plan) return { fixture, coverage: { total: fixture.length, executed: fixture.length, excluded: [] } };
  const published = new Set(snapshot.records.map(r => r.product.upstream_key));
  const quarantine = new Set(plan.quarantined.map(r => r.upstream_key).filter(k => k && !published.has(k)));
  const excluded = [], selected = [];
  for (const item of fixture) {
    let reason;
    if (plan.quality.held[item.category] && plan.counts[item.category] === 0) reason = 'held_without_baseline';
    const expected = item.expected;
    const selectors = expected?.anyOf ?? expected?.upstream_ids?.map(upstream_id => ({ upstream_id })) ?? [expected];
    const keys = selectors.map(s => s?.upstream_key ?? (s?.upstream_id ? `${models[item.category].upstream}/${s.upstream_id}` : null));
    if (['lookup','identifier'].includes(item.intent) && keys.length && keys.every(k => quarantine.has(k))) reason = 'explicit_target_quarantined';
    if (reason) excluded.push({ id: item.id, category: item.category, intent: item.intent, reason }); else selected.push(item);
  }
  return { fixture: selected, coverage: { total: fixture.length, executed: selected.length, excluded } };
}
export function assertPublicationCoverage(coverage, fixture) {
  assert(coverage.executed > 0 && coverage.executed / coverage.total >= .9, 'Publication evaluation coverage below 90%');
  for (const intent of new Set(fixture.map(r => r.intent))) assert(fixture.filter(r => r.intent === intent).length > coverage.excluded.filter(r => r.intent === intent).length, 'Publication intent coverage lost');
}
