import { spawn, execFile } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

// A bounded foreground verification job, not a detached long-lived shell.
// Reuse an existing catalog server; only stop the process tree we started.
const origin = 'http://127.0.0.1:8787';
const listening = () => new Promise(resolve => {
  const socket = createConnection({ host: '127.0.0.1', port: 8787 });
  const done = value => { socket.destroy(); resolve(value); };
  socket.once('connect', () => done(true));
  socket.once('error', () => done(false));
  socket.setTimeout(2000, () => done(false));
});
const healthy = async () => {
  try {
    const response = await fetch(`${origin}/v1/health`, { signal: AbortSignal.timeout(2000) });
    const body = await response.json();
    return response.ok && body.ok === true && body.database === 'available';
  } catch { return false; }
};
async function stop(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await promisify(execFile)('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already stopped. */ }
    await delay(500);
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already stopped. */ }
  }
}
let worker;
let verification;
let interrupted = false;
const interrupt = () => { interrupted = true; void stop(verification); void stop(worker); };
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
const fds = [];
try {
  if (await listening()) {
    if (!await healthy()) throw new Error('Port 8787 is occupied but catalog health is unavailable; inspect the existing process');
    console.log(`Reusing existing Worker at ${origin}; it will be left running.`);
  } else {
    await mkdir('.cache', { recursive: true });
    fds.push(openSync('.cache/worker-dev.stdout.log', 'w'), openSync('.cache/worker-dev.stderr.log', 'w'));
    console.log('Starting local Worker; readiness deadline 60s. Logs: .cache/worker-dev.{stdout,stderr}.log');
    worker = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--local', '--env', 'local', '--persist-to', '.wrangler/state',
      '--ip', '127.0.0.1', '--port', '8787', '--inspector-port', '0'], {
      stdio: ['ignore', ...fds], windowsHide: true, detached: process.platform !== 'win32',
      env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
    });
    let spawnError;
    worker.once('error', error => { spawnError = error; });
    const deadline = Date.now() + 60_000;
    while (!await healthy()) {
      if (interrupted || spawnError || worker.exitCode !== null || Date.now() >= deadline) throw new Error('Worker readiness failed; inspect .cache/worker-dev.stdout.log and .cache/worker-dev.stderr.log');
      await delay(500);
    }
  }
  if (interrupted) throw new Error('Verification interrupted');
  console.log('Worker ready. Running paced HTTP/direct-D1 comparison including all 120 Golden Queries (deadline 600s).');
  verification = spawn(process.execPath, ['scripts/verify-api.js', '--url', origin, '--golden', '--paced', '--output', '.cache/api-local-production.json'], {
    stdio: 'inherit', windowsHide: true, detached: process.platform !== 'win32',
  });
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { void stop(verification); reject(new Error('HTTP verification exceeded 600s')); }, 600_000);
    verification.once('error', error => { clearTimeout(timer); reject(error); });
    verification.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  if (exit !== 0 || interrupted) throw new Error(`HTTP verification failed (exit ${exit})`);
} finally {
  await stop(verification);
  await stop(worker);
  for (const fd of fds) closeSync(fd);
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
  if (worker) console.log('Stopped the local Worker process tree started by this verification job.');
}
