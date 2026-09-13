import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

export const distribution = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const p = n => sorted.length ? sorted[Math.ceil(n * sorted.length) - 1] : null;
  return { count: sorted.length, p50: p(0.5), p95: p(0.95), max: p(1) };
};
export const popular = [
  ['memory', 'ddr5', 20], ['gpu', 'rtx 5080', 15], ['cpu', 'ryzen 7', 10],
  ['cpu', '14900k', 10], ['storage', '990pro', 10], ['motherboard', 'b650e wifi', 5],
];

// Keep only our bounded application log and runtime timing, not raw tail request headers.
export async function startTail() {
  const events = new Map();
  const child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'tail', '--env', '', '--format', 'json'], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
    env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
  });
  let buffer = '';
  child.stdout.setEncoding('utf8');
  let failure;
  child.on('error', () => { failure = 'Could not start Wrangler tail'; });
  child.stderr.on('data', chunk => { console.error(chunk.toString()); });
  child.stdout.on('data', chunk => {
    buffer += chunk.toString();
    while (true) {
      const start = buffer.indexOf('{');
      if (start < 0) { buffer = ''; break; }
      let depth = 0, quoted = false, escaped = false, end = -1;
      for (let i = start; i < buffer.length; i++) {
        const c = buffer[i];
        if (quoted) {
          if (escaped) escaped = false;
          else if (c === '\\') escaped = true;
          else if (c === '"') quoted = false;
        } else if (c === '"') quoted = true;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) { end = i + 1; break; }
      }
      if (end < 0) break;
      try {
        const trace = JSON.parse(buffer.slice(start, end));
        for (const log of trace.logs ?? []) for (const message of log.message ?? []) {
          let event;
          try { event = typeof message === 'string' ? JSON.parse(message) : message; } catch { continue; }
          if (event?.event === 'catalog_api') events.set(event.request_id, { ...event,
            outcome: trace.outcome, cpu_ms: trace.cpuTime ?? null, wall_ms: trace.wallTime ?? null });
        }
      } catch { /* Wrangler startup text is not a trace. */ }
      buffer = buffer.slice(end);
    }
  });
  return {
    async event(id, timeout = 60_000) {
      const deadline = Date.now() + timeout;
      while (!events.has(id)) {
        if (failure || child.exitCode !== null || Date.now() >= deadline) throw new Error(failure ?? `Missing tail event for request ${id}`);
        await delay(100);
      }
      return events.get(id);
    },
    async ready(origin) {
      for (let i = 0; i < 12; i++) {
        await delay(1000);
        const response = await fetch(new URL('/v1/health', origin), { signal: AbortSignal.timeout(5000) });
        await response.text();
        try { await this.event(response.headers.get('x-request-id'), 1500); return; } catch { /* Wait for connection. */ }
      }
      throw new Error('Tail readiness deadline exceeded');
    },
    async stop() {
      if (!child.pid || child.exitCode !== null) return;
      if (process.platform === 'win32') await promisify(execFile)('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
      else { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* stopped */ } }
    },
  };
}

export async function measure(origin, tail, path, init) {
  const started_at = Date.now();
  const started = performance.now();
  const response = await fetch(new URL(path, origin), { ...init, signal: AbortSignal.timeout(60_000) });
  const text = await response.text();
  const elapsed_ms = performance.now() - started;
  const headers = Object.fromEntries(response.headers);
  const event = await tail.event(headers['x-request-id']);
  assert.equal(event.status, response.status);
  return { started_at, path, method: init?.method ?? 'GET', status: response.status, headers, elapsed_ms,
    event, body: text ? JSON.parse(text) : null };
}

export function summarize(samples) {
  const hits = samples.filter(s => s.headers['x-cache'] === 'HIT');
  const misses = samples.filter(s => s.headers['x-cache'] === 'MISS');
  // Missing metadata is never silently treated as zero.
  assert(samples.every(s => Number.isFinite(s.event.rows_read)));
  const rows_read = samples.reduce((n, s) => n + s.event.rows_read, 0);
  return { requests: samples.length, hits: hits.length, misses: misses.length, hit_rate: hits.length / samples.length,
    rows_read, rows_read_per_request: rows_read / samples.length,
    http_ms: distribution(samples.map(s => s.elapsed_ms)), hit_ms: distribution(hits.map(s => s.elapsed_ms)),
    miss_ms: distribution(misses.map(s => s.elapsed_ms)), worker_ms: distribution(samples.map(s => s.event.elapsed_ms)) };
}
