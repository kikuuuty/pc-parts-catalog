import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, appendFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readPlan, savePlan } from '../src/application-plan.js';
import { githubPlanAdapter, restorePlanArtifact, confirmPlanArtifact, PLAN_ARTIFACT } from './lib/plan-artifact.js';

const command = process.argv[2];
let phase = 'pin';
try {
  assert(['restore', 'confirm'].includes(command), 'plan_artifact_invalid_command');
  const pin = JSON.parse(await readFile('.cache/release-pin.json', 'utf8'));
  const runId = process.env.GITHUB_RUN_ID;
  const adapter = githubPlanAdapter({ repository: process.env.GITHUB_REPOSITORY, runId,
    request: url => fetch(url, { headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(60000) }),
    async download() {
      await mkdir('.cache', { recursive: true });
      const directory = await mkdtemp('.cache/plan-download-');
      try {
        await promisify(execFile)('gh', ['run', 'download', runId, '--repo', process.env.GITHUB_REPOSITORY, '--name', PLAN_ARTIFACT, '--dir', directory]);
        return await readPlan(`${directory}/release-plan.json`);
      } finally { await rm(directory, { recursive: true, force: true }); }
    },
  });
  phase = command;
  let receipt;
  if (command === 'restore') {
    const restored = await restorePlanArtifact(adapter, pin, runId);
    receipt = restored.receipt;
    if (restored.plan) await savePlan(restored.plan, '.cache/release-plan.json');
  } else {
    receipt = await confirmPlanArtifact(adapter, pin, runId, await readPlan('.cache/release-plan.json'), JSON.parse(await readFile('.cache/release-plan-artifact.json', 'utf8')));
  }
  await writeFile('.cache/release-plan-artifact.json', JSON.stringify(receipt) + '\n');
  console.log(JSON.stringify(receipt));
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `state=${receipt.state}\n`);
} catch (error) {
  const label = error.message.split('\n')[0];
  const reason = /^(plan_[a-z_]+)$/.test(label) ? label : 'plan_artifact_validation_failed';
  const diagnostic = { phase: `plan_artifact_${phase}`, state: 'stopped', reason };
  await mkdir('.cache', { recursive: true });
  await writeFile('.cache/release-plan-artifact-report.json', JSON.stringify(diagnostic) + '\n');
  console.error(JSON.stringify(diagnostic));
  process.exitCode = 1;
}
