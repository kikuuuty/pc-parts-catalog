import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { models } from './model.js';
import { normalize } from './normalize.js';

export const UPSTREAM_URL = 'https://github.com/buildcores/buildcores-open-db.git';
export const defaultRepo = path.resolve('.cache/upstream');
const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
export async function fetchUpstream({ repo = defaultRepo, ref = 'main' } = {}) {
  if (ref.startsWith('-') || !/^[\w./-]+$/.test(ref)) throw new Error('Invalid upstream ref');
  try { await access(path.join(repo, '.git')); }
  catch {
    await mkdir(path.dirname(repo), { recursive: true });
    execFileSync('git', ['clone', '--depth', '1', '--filter=blob:none', '--sparse', UPSTREAM_URL, repo], { stdio: 'inherit' });
  }
  if (git(repo, ['remote', 'get-url', 'origin']) !== UPSTREAM_URL) throw new Error('Unexpected upstream origin');
  if (git(repo, ['status', '--porcelain'])) throw new Error('Upstream checkout has changes; use a clean checkout');
  git(repo, ['sparse-checkout', 'set', 'schemas', 'docs', ...Object.values(models).map(m => `open-db/${m.upstream}`)]);
  git(repo, ['fetch', '--depth', '1', 'origin', ref]);
  git(repo, ['checkout', '--detach', 'FETCH_HEAD']);
  const commit = git(repo, ['rev-parse', 'HEAD']);
  console.log(`BuildCores snapshot: ${commit} (${repo})`);
  return commit;
}

export async function loadSnapshot(repo = defaultRepo) {
  if (git(repo, ['remote', 'get-url', 'origin']) !== UPSTREAM_URL) throw new Error('Expected the BuildCores upstream origin');
  const commit = git(repo, ['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Expected an immutable Git commit');
  if (git(repo, ['status', '--porcelain'])) throw new Error('Upstream checkout is not clean');
  const tracked = new Set(git(repo, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n'));
  for (const required of ['README.md', 'LICENSE.txt', 'docs/DATA_MODEL.md']) {
    if (!tracked.has(required)) throw new Error(`Upstream document missing: ${required}`);
    await readFile(path.join(repo, required), 'utf8');
  }
  // Preserve upstream notices unchanged with the fetched snapshot and inspection reports.
  const noticeDir = path.resolve('.cache/notices', commit);
  await mkdir(noticeDir, { recursive: true });
  for (const name of ['LICENSE.txt', 'README.md']) await writeFile(path.join(noticeDir, name), await readFile(path.join(repo, name)));
  const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true, validateFormats: true });
  addFormats(ajv);
  const records = [];
  const seen = new Map();
  const report = { commit, categories: {}, invalid: [], cross_category_ids: [], samples: {} };
  for (const [category, model] of Object.entries(models)) {
    const schemaPath = `schemas/${model.upstream}.schema.json`;
    if (!tracked.has(schemaPath)) throw new Error(`Missing schema: ${schemaPath}`);
    const schema = JSON.parse(await readFile(path.join(repo, schemaPath), 'utf8'));
    const validate = ajv.compile(schema);
    const prefix = `open-db/${model.upstream}/`;
    const expected = [...tracked].filter(p => p.startsWith(prefix) && p.endsWith('.json')).sort();
    if (!expected.length) throw new Error(`Empty upstream category: ${category}`);
    const actual = (await readdir(path.join(repo, prefix))).filter(p => p.endsWith('.json')).map(p => prefix + p).sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error(`Incomplete snapshot: ${category}`);
    const coverage = Object.fromEntries(Object.keys(model.fields).map(k => [k, 0]));
    report.categories[category] = { count: expected.length, fields_present: coverage };
    report.samples[category] = [];
    for (const file of expected) {
      try {
        const d = JSON.parse(await readFile(path.join(repo, file), 'utf8'));
        if (!validate(d)) throw new Error(ajv.errorsText(validate.errors, { separator: '; ' }));
        if (!d || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(d.opendb_id) || path.basename(file, '.json') !== d.opendb_id) throw new Error('UUID v4 / filename mismatch');
        if (!d.metadata?.name?.trim()) throw new Error('A searchable product needs a nonempty metadata.name');
        if (seen.has(d.opendb_id)) report.cross_category_ids.push({ upstream_id: d.opendb_id, files: [seen.get(d.opendb_id), file] });
        seen.set(d.opendb_id, file);
        const normalized = normalize(category, d, commit);
        if (Buffer.byteLength(JSON.stringify(normalized)) > 1_500_000) throw new Error('Normalized product exceeds D1 row/parameter safety limit');
        records.push(normalized);
        for (const [k, v] of Object.entries(normalized.spec)) if (v !== null) coverage[k]++;
        if (report.samples[category].length < 3) report.samples[category].push({ file, metadata: d.metadata, spec: normalized.spec, identifiers: normalized.identifiers });
      } catch (error) { report.invalid.push({ file, error: error.message }); }
    }
  }
  if (git(repo, ['rev-parse', 'HEAD']) !== commit || git(repo, ['status', '--porcelain'])) {
    report.invalid.push({ file: '<checkout>', error: 'Upstream checkout changed while reading the snapshot' });
  }
  await mkdir('.cache', { recursive: true });
  await writeFile('.cache/inspection.json', JSON.stringify(report, null, 2));
  if (report.invalid.length) throw new Error(`${report.invalid.length} invalid upstream records. No D1 writes performed. See .cache/inspection.json`);
  return { commit, records, report };
}
