const percent = n => n === null ? 'N/A' : `${(100*n).toFixed(1)}%`;
function fieldTable(entries) {
  return ['Field'.padEnd(38) + 'Present / Total'.padStart(20) + 'Missing'.padStart(10) + 'Coverage'.padStart(12) + 'Missing %'.padStart(12),
    ...Object.entries(entries).map(([name,v]) => name.padEnd(38) + `${v.present} / ${v.total}`.padStart(20) + String(v.missing).padStart(10) + percent(v.coverage).padStart(12) + percent(v.missing_rate).padStart(12))];
}
export function formatCompleteness(report) {
  const lines = ['Catalog completeness', `Denominator: ${report.scope.include_inactive ? 'all scoped products' : 'active scoped products'}`, `Catalog: ${report.catalog.catalog_sha256}`];
  for (const category of report.categories) {
    lines.push('', `${category.label} — total ${category.total_products}, active ${category.active_products}, evaluated ${category.evaluated_products}`, `Unknown release_year: ${category.unknown_release_year}; missing spec rows: ${category.missing_spec_rows}`, ...fieldTable(category.fields), 'Identifiers (distinct products)', ...fieldTable(category.identifiers));
    if (report.field && category.manufacturers) {
      lines.push('', 'By manufacturer', ...fieldTable(Object.fromEntries(category.manufacturers.flatMap(g => Object.entries(g.fields).map(([k,v]) => [`${g.manufacturer ?? '(missing)'} / ${k}`,v])))));
      continue;
    }
    for (const group of category.manufacturers ?? []) {
      lines.push('', `${category.label} / ${group.manufacturer ?? '(missing manufacturer)'} — total ${group.total_products}, active ${group.active_products}, evaluated ${group.evaluated_products}`, ...fieldTable(group.fields), ...fieldTable(Object.fromEntries(Object.entries(group.identifiers).map(([k,v]) => [`identifier.${k}`,v]))));
    }
  }
  return lines.join('\n');
}
export function formatDuplicates(report, { verbose = false, limit = 10 } = {}) {
  const lines = ['Duplicate candidates (not confirmed duplicates)', ...Object.entries(report.summary).filter(([,v]) => typeof v === 'number').map(([k,v]) => `${k}: ${v}`)];
  for (const [title,groups] of [['Identifier conflicts',report.identifier_conflicts], ['Possible duplicate names',report.possible_name_duplicates]]) {
    const shown = verbose ? groups : groups.slice(0,limit);
    lines.push('', `${title}: showing ${shown.length}/${groups.length} groups`);
    for (const group of shown) {
      lines.push('', `${group.classification}: ${group.type ?? group.category} / ${group.manufacturer_key ?? '(unspecified)'} / ${group.value_key ?? group.name_key} (${group.product_count} products)`);
      const members = verbose ? group.products : group.products.slice(0,5);
      for (const p of members) lines.push(`  Product ${p.id} [${p.upstream_key}] ${p.manufacturer ?? '?'} | ${p.name}`);
      if (members.length < group.products.length) lines.push(`  ... ${group.products.length-members.length} more (use --verbose or --json)`);
    }
  }
  return lines.join('\n');
}
export function formatBenchmark(report, { verbose = false, summaryOnly = false } = {}) {
  const s = report.summary;
  const lines = ['Search benchmark', `Queries: ${s.query_count} (scored: ${s.scored_query_count})`, `Hit@1: ${percent(s.hit_at_1)}  Hit@5: ${percent(s.hit_at_5)}  Hit@10: ${percent(s.hit_at_10)}`, `MRR: ${s.mrr === null ? 'N/A' : s.mrr.toFixed(4)}`, `Zero results: ${s.zero_result_count}  Failed queries: ${s.failed_query_count}`, ...Object.entries(s.failures).map(([k,v]) => `${k}: ${v}`)];
  if (s.missing_expected_target_count) lines.push(`Missing expected target references (including anyOf members): ${s.missing_expected_target_count}`);
  if (s.precision_query_count) lines.push(`Precision@5: ${percent(s.precision_at_5)}  Precision@10: ${percent(s.precision_at_10)} (${s.precision_query_count} cases; fixed K denominator)`);
  for (const [label,groups] of [['Suite',report.by_suite],['Class',report.by_class]]) {
    for (const [name,m] of Object.entries(groups ?? {})) lines.push(`${label} ${name}: n=${m.query_count}, Hit@1=${percent(m.hit_at_1)}, Hit@5=${percent(m.hit_at_5)}, MRR=${m.mrr?.toFixed(4) ?? 'N/A'}`);
  }
  if (summaryOnly) return lines.join('\n');
  for (const r of report.results) {
    if (r.status === 'HIT' && !verbose) continue;
    lines.push('', `${r.status === 'HIT' ? 'PASS' : 'FAIL'} ${r.id} [${r.status}]`, `query: ${r.query}`, `expected: ${JSON.stringify(r.expected)}`, `rank: ${r.rank ?? 'not found'}; pages: ${r.executed_pages}`, ...(r.reason ? [`reason: ${r.reason}`] : []), 'Top results:', ...r.top_results.map(p => `${p.rank}. [${p.upstream_key}] ${p.name}`));
  }
  return lines.join('\n');
}
