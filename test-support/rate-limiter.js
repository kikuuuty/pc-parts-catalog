import { protectionBindings } from '../src/search-protection.js';

// Deterministic single-location model, NOT a simulation of Cloudflare consistency.
export function fakeLimiters({ now = () => 0, limits = {}, unlimited = false } = {}) {
  return Object.fromEntries(protectionBindings.map(({ name, simple }) => {
    const counters = new Map();
    const calls = [];
    return [name, { calls, async limit({ key }) {
      calls.push(key);
      const window = Math.floor(now() / (simple.period * 1000));
      const previous = counters.get(key);
      const count = previous?.window === window ? previous.count + 1 : 1;
      counters.set(key, { window, count });
      return { success: unlimited || count <= (limits[name] ?? simple.limit) };
    } }];
  }));
}
