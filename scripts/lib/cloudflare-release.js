import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { remoteCredentials } from '../../src/remote-config.js';

export async function wrangler(args) {
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args], {
      encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
    });
    return stdout;
  } catch { throw new Error('Wrangler command failed or timed out; reconcile current deployment before retry'); }
}

export async function cloudflareRelease(config) {
  const { account, token } = await remoteCredentials(config);
  async function get(suffix) {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${config.name}/${suffix}`, {
          headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60000),
        });
        const body = await response.json();
        if (!response.ok || !body.success) throw new Error('Management read failed');
        return body.result;
      } catch {
        if (attempt === 2) throw new Error('Cloudflare deployment state unavailable');
        await delay(2000 * 2 ** attempt);
      }
    }
  }
  return { async current() {
    const result = await get('deployments');
    const latest = [...result.deployments].sort((a, b) => b.created_on.localeCompare(a.created_on))[0];
    assert(latest?.versions.length === 1 && latest.versions[0].percentage === 100, 'Expected one production Worker version at 100%');
    const id = latest.versions[0].version_id;
    const version = await get(`versions/${id}`);
    return { id, tag: version.annotations?.['workers/tag'], bindings: version.resources?.bindings ?? [] };
  } };
}

export function assertDeployedVars(current, vars) {
  for (const [name, value] of Object.entries(vars)) {
    const binding = current.bindings.find(b => b.name === name);
    assert(binding && (binding.text ?? binding.json) === value, 'Deployed vars differ from release config');
  }
}
