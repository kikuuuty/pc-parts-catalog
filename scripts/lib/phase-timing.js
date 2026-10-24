import { writeFileSync } from 'node:fs';

// Diagnostics only, not phase skipping/checkpoints. Every release reruns gates.
export function phaseTiming(report, save, now = () => Date.now()) {
  report.timings ??= {};
  let pending = Promise.resolve();
  const persist = () => { pending = pending.then(() => save(report)); return pending; };
  const mark = (name, status) => {
    const time = now();
    if (status === 'running') report.timings[name] = { status, started_at: new Date(time).toISOString() };
    else {
      const entry = report.timings[name] ?? { started_at: new Date(time).toISOString() };
      Object.assign(entry, { status, finished_at: new Date(time).toISOString(), elapsed_ms: time - Date.parse(entry.started_at) });
      report.timings[name] = entry;
    }
  };
  return { mark, persist, flush: () => pending,
    async run(name, operation) {
      mark(name, 'running'); await persist();
      try { const value = await operation(); mark(name, 'passed'); await persist(); return value; }
      catch (error) { mark(name, 'failed'); try { await persist(); } catch { /* retain original */ } throw error; }
    },
    interrupt() { for (const [name, entry] of Object.entries(report.timings)) if (entry.status === 'running') mark(name, 'interrupted'); },
  };
}

export function diagnosticHeartbeat(report, timing, file) {
  const started = Date.now(); report.execution_started_at = new Date(started).toISOString();
  const elapsed = () => { report.elapsed_ms = Date.now() - started; };
  const timer = setInterval(() => { elapsed(); void timing.persist().catch(() => {}); }, 30000);
  timer.unref();
  const interrupted = () => {
    elapsed(); timing.interrupt(); report.result = 'interrupted';
    try { writeFileSync(file, JSON.stringify(report, null, 2) + '\n'); } catch { /* best effort on cancellation */ }
    // Do not clear the DB lease manually: the existing expiration protocol owns recovery.
    process.exit(1);
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, interrupted);
  return async () => {
    clearInterval(timer); elapsed();
    for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, interrupted);
    await timing.flush();
  };
}
