import { readFile,writeFile } from 'node:fs/promises';

export const failureDecisions=()=>readFile(new URL('../../docs/search-failure-decisions.json',import.meta.url),'utf8').then(JSON.parse);
const pct=v=>Number.isFinite(v)?`${(v*100).toFixed(2)}%`:'—';
const code=value=>'```json\n'+JSON.stringify(value,null,2)+'\n```';
export async function writeFailureReport(report,output) {
  const decisions=await failureDecisions();
  for(const r of report.diagnostics)Object.assign(r,decisions[r.id]??{classification:null,reason:'New failure: inspect source evidence',proposed_action:r.diagnostic_command});
  await writeFile(output,JSON.stringify(report,null,2)+'\n');
  const text=['# Search failure diagnostic evidence',
    'Local read-only measurement. Classification is diagnostic documentation, never an approval/gate input.',
    `Snapshot: ${report.catalog.last_sync.source_commit}. Complete product/spec/identifier/FP/FN evidence: ${output}.`,
    code({measurement:report.measurement,release_failures:report.release_failures,by_intent:report.by_intent})];
  for(const r of report.diagnostics) {
    text.push(`## ${r.id}`,`Classification **${r.classification??'not diagnosed'}** — ${r.reason}`,`Proposed action: ${r.proposed_action}`,
      `\`${r.diagnostic_command}\``,code({intent:r.intent,category:r.category,query:r.query,filters:r.search?.filters??{},ranges:r.search?.ranges??{},facets:r.search?.facets??{},expected:r.expected,equivalents:r.equivalents,relevant:r.relevant}),
      `Returned candidates: ${r.returned}; relevant set: ${r.relevant_ids.length}; relevant returned: ${r.relevant_returned.length}; FP: ${r.false_positive_count??'lookup: not scored'}; FN: ${r.false_negative_count??'lookup: not scored'}; coverage: ${pct(r.relevant_coverage)}; precision: ${pct(r.precision)}.`,
      `Required: ${r.required??'candidate set (no rank gate)'}; rank: ${r.rank??'—'}; window exhausted: ${r.window_exhausted}; rows_read: ${r.rows_read}; SQL: ${r.sql_duration_ms}ms.`,
      '<details><summary>Query plan</summary>\n\n```text\n'+r.query_plan.join('\n')+'\n```\n</details>',
      '<details><summary>Top10 / source condition / identifiers / scores</summary>\n\n'+code(r.top_results)+'\n</details>',
      '<details><summary>False negatives (complete names/references)</summary>\n\n'+code(r.false_negatives.map(p=>({name:p.name,upstream_key:p.upstream_key})))+'\n</details>',
      '<details><summary>Missing row traces (up to ten)</summary>\n\n'+code(r.missing_traces)+'\n</details>');
  }
  await writeFile(output.replace(/\.json$/,'.md'),text.join('\n\n')+'\n');
}
