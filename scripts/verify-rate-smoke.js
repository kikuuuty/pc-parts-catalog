import { writeFile } from 'node:fs/promises';
import { startTail, measure } from './lib/cache-measurement.js';
import { runRateSmoke } from './lib/rate-smoke.js';

// Production Rate Limiting contract smoke: allowed/denied HTTP + telemetry
// contracts and D1 pre-admission protection, not fixed SQL costs or result counts.
// At most 24 cheap Search POSTs, paced 300ms apart; never extend to force a denial.
// Exact thresholds belong in deterministic fake-limiter tests: production is
// colo-local/eventually consistent and shares window state with other traffic.
// A valid d1_miss denial stops the probe. Passing still requires an observed
// expensive_miss 429; global-only protection is reported as inconclusive.
// Do not run concurrently with broad-query measurements or Golden verification.
const origin = 'https://pc-parts-catalog.kikuuuty.workers.dev';
const tail = await startTail();
const samples = [];
let report = { contract: 'failed', exit_code: 1 };
try {
  await tail.ready(origin);
  report = await runRateSmoke({ samples, request: () => measure(origin, tail, '/v1/search', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ category: 'cpu', keyword: '14900k' }),
  }) });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.exit_code;
  if (report.message) console.error(report.message);
} finally {
  try { await writeFile('.cache/rate-production-429.json', JSON.stringify({ generated_at: new Date().toISOString(), ...report, samples }, null, 2) + '\n'); }
  finally { await tail.stop(); }
}
