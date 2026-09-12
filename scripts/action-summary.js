import { appendFile, readFile } from 'node:fs/promises';

if (process.env.GITHUB_STEP_SUMMARY) {
  let text = '## Catalog synchronization\n\n';
  try {
    const report = JSON.parse(await readFile('.cache/sync-report.json', 'utf8'));
    text += `Status: **${report.status}**\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`;
    if (report.status === 'partial') text += '\nImport is incomplete. Resume workflow_dispatch with the same upstream commit after the Free quota resets (00:00 UTC), or with the remaining daily budget. Deletion is deferred until all changed products are applied.\n';
  } catch { text += 'Sync did not complete. Inspect the failed step, D1 sync_runs, and the inspection artifact.\n'; }
  await appendFile(process.env.GITHUB_STEP_SUMMARY, text);
}
