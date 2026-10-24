export function diagnostics(sampleLimit = 100) {
  const report = { total: 0, by_code: Object.create(null), by_category: Object.create(null), samples: [], omitted: 0 };
  return { report, add(issue) {
    report.total++;
    report.by_code[issue.code] = (report.by_code[issue.code] ?? 0) + 1;
    const category = report.by_category[issue.category ?? 'snapshot'] ??= Object.create(null);
    const key = `${issue.scope}:${issue.code}:${issue.field ?? ''}`;
    category[key] = (category[key] ?? 0) + 1;
    if (report.samples.length < sampleLimit) report.samples.push(issue); else report.omitted++;
  } };
}
