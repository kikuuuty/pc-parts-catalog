import assert from 'node:assert/strict';
import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import { publicationInputs, releaseRequest, selectPublicationSource, restorePublication, githubPublicationAdapter, publicationDirectory } from './lib/publication-source.js';
import { savePlan } from '../src/application-plan.js';
import { openDatabase } from '../src/database.js';
import { productionConfig, safeDatabase } from './lib/release-gates.js';
import { publishCatalog } from './lib/catalog-publication.js';
import { saveValidationReport } from './lib/validation-report.js';
import { phaseTiming, diagnosticHeartbeat } from './lib/phase-timing.js';

const command = process.argv[2] ?? 'publish';
const output = `.cache/release-${command === 'validate' ? 'request' : 'publish'}-report.json`;
const report = { result: 'running', phase: 'validate_request', deploy: 'not run', post_deploy: 'not run', golden: 'not run',
  validation: { source_integrity: 'not_run', filter_metadata: 'not_run', search_quality: 'not_run', query_plans: 'not_run' } };
const timing = phaseTiming(report, () => saveValidationReport(output, report));
let failure, stopDiagnostics;
try {
  await mkdir('.cache', { recursive: true });
  stopDiagnostics = diagnosticHeartbeat(report, timing, output);
  assert(['validate', 'publish'].includes(command), 'publication_command_invalid');
  const request = releaseRequest(process.env); report.mode = request.mode;
  if (command === 'validate') {
    if (process.env.GITHUB_OUTPUT) for (const [key, value] of Object.entries(request)) await appendFile(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  } else {
    const expected = selectPublicationSource(request, process.env.SYNC_JOB_RESULT, process.env);
    // No upstream_ref/max_products/write_budget is read on this path.
    publicationInputs(process.env);
    const directory = await publicationDirectory();
    const context = { repository: process.env.GITHUB_REPOSITORY, runId: process.env.GITHUB_RUN_ID, codeSha: process.env.GITHUB_SHA };
    report.phase = 'restore_source_artifacts';
    const target = await timing.run('restore_source_artifacts', () => restorePublication(githubPublicationAdapter({ repository: context.repository,
      runId: expected.source_run_id, directory }), expected, context));
    report.source = target.source; report.expected = target.expected;
    await savePlan(target.plan); // Local immutable file ONLY; no DB/plan creation.
    await writeFile('.cache/release-publication-source.json', JSON.stringify({ source: target.source, expected: target.expected, snapshot: target.snapshot }, null, 2));
    const config = productionConfig(JSON.parse(await readFile('wrangler.json', 'utf8')));
    const db = safeDatabase(await openDatabase(true));
    try { await publishCatalog({ db, config, target, report, timing, stage(value) {
      report.phase = value; console.log(`Publication phase: ${value}`);
    } }); } finally { await db.close(); }
  }
  report.result = 'success';
} catch (error) {
  failure = error; report.result = 'failed';
  if (report.post_deploy === 'running') report.post_deploy = 'failed';
  if (error.code === 'ERR_ASSERTION') report.reason = error.message.split('\n')[0].slice(0, 180);
  console.error('Catalog publication stopped; inspect safe reports. No ingestion fallback is permitted.');
  process.exitCode = 1;
} finally {
  if (stopDiagnostics) { try { await stopDiagnostics(); } catch (error) { if (!failure) { failure = error; report.result = 'failed'; process.exitCode = 1; } } }
  await saveValidationReport(output, report, failure);
  console.log(JSON.stringify(report));
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Catalog ${command}\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`);
}
