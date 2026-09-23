import { readFile } from 'node:fs/promises';
import { remoteCredentials } from '../src/remote-config.js';
import { protectionBindings, localProtectionBindings, validateProtectionConfig } from '../src/search-protection.js';

// Read-only inventory of current account Worker settings. Never print bindings'
// values or auth headers; only names of namespace conflicts are reported.
const config = JSON.parse(await readFile('wrangler.json', 'utf8'));
validateProtectionConfig(config);
const bindings = [...protectionBindings, ...localProtectionBindings];
const { account, token } = await remoteCredentials(config);
const get = async path => {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/${path}`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json();
  if (!response.ok || !body.success) throw new Error(`Worker inventory failed (${response.status})`);
  return body.result;
};
const workers = await get('scripts');
const conflicts = [];
for (const worker of workers) {
  const settings = await get(`scripts/${encodeURIComponent(worker.id)}/settings`);
  for (const binding of settings.bindings ?? []) {
    if (binding.type !== 'ratelimit') continue;
    const expected = bindings.find(b => b.namespace_id === String(binding.namespace_id));
    const owner = localProtectionBindings.includes(expected) ? config.env.local.name ?? `${config.name}-local` : config.name;
    if (expected && (worker.id !== owner || binding.name !== expected.name)) conflicts.push({ worker: worker.id, binding: binding.name, namespace_id: binding.namespace_id });
  }
}
console.log(JSON.stringify({ current_workers_checked: workers.length, namespaces: bindings.map(b => b.namespace_id), conflicts }, null, 2));
if (conflicts.length) throw new Error('Rate limit namespace is already used by another binding');
