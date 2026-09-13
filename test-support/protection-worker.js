import { createWorker } from '../src/worker.js';
import { fakeLimiters } from './rate-limiter.js';

export function protectionWorker({ limits, unlimited = false, rowsRead = 35963, blockedDB, cacheFailure } = {}) {
  let clock = 0;
  const entries = new Map(), logs = [], statements = [];
  let writes = 0;
  const cache = {
    async match(key) { if (cacheFailure === 'match') throw new Error('cache unavailable'); return entries.get(key.url)?.clone(); },
    async put(key, response) { if (cacheFailure === 'put') throw new Error('cache unavailable'); writes++; entries.set(key.url, response.clone()); },
  };
  const env = { ...fakeLimiters({ limits, unlimited, now: () => clock }), CATALOG_CACHE_EPOCH: 'test', SEARCH_CACHE_TTL_SECONDS: '300',
    DB: { prepare: sql => ({ bind: (...params) => ({ all: async () => {
      statements.push({ sql, params });
      if (blockedDB) await blockedDB;
      return { success: true, results: [], meta: { rows_read: rowsRead, rows_written: 0, duration: 1 } };
    } }) }) },
  };
  const worker = createWorker({ cache, log: event => logs.push(event), now: () => clock });
  return { env, logs, statements, entries, cache, get writes() { return writes; },
    advance(ms) { clock += ms; },
    request(input = { category: 'cpu', keyword: '14900k' }, method = 'GET', headers) {
      const params = new URLSearchParams(Object.entries(input).map(([k, v]) => [k === 'keyword' ? 'q' : k, String(v)]));
      return worker.fetch(new Request(`https://catalog.example/v1/search${method === 'GET' ? `?${params}` : ''}`, method === 'GET' ? { headers } : {
        method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(input),
      }), env);
    },
    fetch(path, init) { return worker.fetch(new Request(`https://catalog.example${path}`, init), env); },
  };
}
