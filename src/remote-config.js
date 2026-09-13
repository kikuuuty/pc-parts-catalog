import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export function remoteDatabaseId(config, override) {
  const bindings = config.d1_databases?.filter(db => db.binding === 'DB') ?? [];
  if (bindings.length !== 1 || bindings[0].database_name !== 'pc-parts-catalog') throw new Error('Expected one DB binding to pc-parts-catalog');
  const id = override || bindings[0].database_id;
  if (typeof id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id) || /^00000000-0000-0000-0000-/i.test(id)) {
    throw new Error('Configure the real remote D1 UUID in wrangler.json (or CLOUDFLARE_D1_DATABASE_ID for the management CLI)');
  }
  return id;
}

export async function readRemoteConfig() {
  const config = JSON.parse(await readFile('wrangler.json', 'utf8'));
  return { config, database: remoteDatabaseId(config, process.env.CLOUDFLARE_D1_DATABASE_ID) };
}

export async function remoteCredentials(config, env = process.env, loadToken = wranglerToken) {
  const account = env.CLOUDFLARE_ACCOUNT_ID || config.account_id;
  if (!account || !/^[a-f0-9]{32}$/i.test(account)) throw new Error('Set CLOUDFLARE_ACCOUNT_ID or account_id in wrangler.json');
  const token = env.CLOUDFLARE_API_TOKEN || await loadToken();
  if (typeof token !== 'string' || !token.trim()) throw new Error('Cloudflare authentication required. Command: npx wrangler login');
  return { account, token };
}

async function wranglerToken() {
  // Official Wrangler command refreshes OAuth if needed. Capture credentials only
  // in memory, never inherit stdout/stderr or include child-process errors in logs.
  try {
    const { stdout } = await promisify(execFile)(process.execPath,
      ['node_modules/wrangler/bin/wrangler.js', 'auth', 'token', '--json'],
      { encoding: 'utf8', timeout: 60_000, windowsHide: true, env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' } });
    const auth = JSON.parse(stdout);
    if (!['oauth', 'api_token'].includes(auth.type)) throw new Error('Unsupported credentials');
    return auth.token;
  } catch { throw new Error('Cloudflare authentication required. Command: npx wrangler login (or configure CLOUDFLARE_API_TOKEN)'); }
}
