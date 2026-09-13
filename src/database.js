import { getPlatformProxy } from 'wrangler';
import { readRemoteConfig, remoteCredentials } from './remote-config.js';

export async function openDatabase(remote = false) {
  if (!remote) {
    const proxy = await getPlatformProxy({ configPath: 'wrangler.json', environment: 'local', persist: { path: '.wrangler/state/v3' } });
    return {
      async query(sql, params = []) { return proxy.env.DB.prepare(sql).bind(...params).all(); },
      close: () => proxy.dispose(),
    };
  }
  const { config, database } = await readRemoteConfig();
  const { account, token } = await remoteCredentials(config);
  return {
    async query(sql, params = []) {
      // Do not retry writes blindly: a lost response may have committed. Resume from DB hashes instead.
      const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql, params }), signal: AbortSignal.timeout(60_000),
      });
      const body = await response.json();
      if (!response.ok || !body.success || body.result?.some(r => !r.success)) throw new Error(`D1 request failed (${response.status}): ${JSON.stringify(body.errors ?? body.result)}`);
      const result = body.result[0];
      if (!result) throw new Error('Empty D1 API response');
      return result;
    },
    async close() {},
  };
}

export async function readState(db) {
  const state = new Map();
  let cursor = 0;
  while (true) {
    const { results } = await db.query("SELECT id,upstream_id,upstream_key,category,content_hash,active FROM products WHERE source='buildcores' AND id>? ORDER BY id LIMIT 1000", [cursor]);
    for (const row of results) state.set(row.upstream_key, row);
    if (!results.length) break;
    cursor = results.at(-1).id;
  }
  return state;
}
