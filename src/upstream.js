import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { models } from './model.js';
import { normalize } from './normalize.js';
import { InputIssue, UUID, limits } from './input-contract.js';
import { diagnostics } from './diagnostics.js';

export const UPSTREAM_URL = 'https://github.com/buildcores/buildcores-open-db.git';
export const defaultRepo = path.resolve('.cache/upstream');
const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
export function categoryCoverage(directories, schemas, registry = models) {
  const defined = Object.values(registry).map(m => m.upstream).sort();
  const upstream = [...new Set([...directories, ...schemas])].sort();
  return {
    upstream_count: upstream.length, supported_count: defined.length,
    supported: upstream.filter(name => defined.includes(name)),
    unsupported: upstream.filter(name => !defined.includes(name)),
    missing_directories: upstream.filter(name => !directories.includes(name)),
    missing_schemas: upstream.filter(name => !schemas.includes(name)),
    missing_upstream: defined.filter(name => !upstream.includes(name)),
  };
}
export async function inspectCategories(repo = defaultRepo, { reportDirectory = '.cache' } = {}) {
  // Inspect Git's complete tree, never just the sparse worktree. A new category
  // must be visible even before it is included in our explicit checkout list.
  const files = git(repo, ['ls-tree', '-r', '--name-only', '-z', 'HEAD']).split('\0').filter(Boolean);
  const directories = [...new Set(files.filter(p => p.startsWith('open-db/')).map(p => p.split('/')[1]))];
  if (!directories.length) throw new Error('Incomplete snapshot: open-db tree missing');
  const schemas = files.filter(p => /^schemas\/[^/]+\.schema\.json$/.test(p)).map(p => p.slice(8, -12));
  const coverage = categoryCoverage(directories, schemas);
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(path.join(reportDirectory, 'upstream-categories.json'), JSON.stringify({ commit: git(repo, ['rev-parse', 'HEAD']), ...coverage }, null, 2));
  return coverage;
}
export function assertModelSchema(model, schema) {
  for (const source of Object.values(model.scalarSources ?? {})) {
    const field = source.split('.').reduce((node, key) => node?.properties?.[key], schema);
    if (!field) throw new Error(`${model.upstream}: modeled field missing from upstream schema: ${source}`);
  }
  for (const source of Object.values(model.facetSources ?? {})) {
    const field = source.split('.').reduce((node, key) => node?.properties?.[key], schema);
    if (![field?.type].flat().includes('array')) throw new Error(`${model.upstream}: facet is not an upstream array: ${source}`);
  }
}
export async function fetchUpstream({ repo = defaultRepo, ref = 'main', reportDirectory = '.cache' } = {}) {
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
  await inspectCategories(repo, { reportDirectory });
  const commit = git(repo, ['rev-parse', 'HEAD']);
  console.log(`BuildCores snapshot: ${commit} (${repo})`);
  return commit;
}

export async function loadSnapshot(repo = defaultRepo, { reportDirectory = '.cache' } = {}) {
  if (git(repo, ['remote', 'get-url', 'origin']) !== UPSTREAM_URL) throw new Error('Expected the BuildCores upstream origin');
  const commit = git(repo, ['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Expected an immutable Git commit');
  if (git(repo, ['status', '--porcelain'])) throw new Error('Upstream checkout is not clean');
  const coverage = await inspectCategories(repo, { reportDirectory });
  const tree = git(repo, ['ls-tree', '-r', '-z', 'HEAD']).split('\0').filter(Boolean).map(line => {
    const [header, file] = line.split('\t'); const [mode, type, hash] = header.split(' ');
    return { mode, type, hash, file };
  });
  const tracked = new Set(tree.map(e => e.file));
  for (const required of ['README.md', 'LICENSE.txt', 'docs/DATA_MODEL.md']) {
    if (!tracked.has(required)) throw new Error(`Upstream document missing: ${required}`);
    if (tree.find(e => e.file === required)?.mode !== '100644') throw new Error('Upstream document is not a regular Git blob');
    await readFile(path.join(repo, required), 'utf8');
  }
  // Preserve upstream notices unchanged with the fetched snapshot and inspection reports.
  const noticeDir = path.resolve(reportDirectory, 'notices', commit);
  await mkdir(noticeDir, { recursive: true });
  for (const name of ['LICENSE.txt', 'README.md']) await writeFile(path.join(noticeDir, name), await readFile(path.join(repo, name)));
  const issues = diagnostics();
  let schemaCategory;
  const schemaWarning = () => issues.add({ code: 'schema_compiler_warning', category: schemaCategory, scope: 'diagnostic' });
  const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true, validateFormats: true,
    logger: { log: schemaWarning, warn: schemaWarning, error: schemaWarning } });
  addFormats(ajv);
  const records = [], presence = [], quarantined = [], heldCategories = {};
  const seen = new Map();
  const report = { commit, coverage, categories: {}, diagnostics: issues.report, cross_category_ids: [], samples: {} };
  for (const name of coverage.unsupported) issues.add({ code: 'unsupported_category', category: name, scope: 'diagnostic' });
  for (const [category, model] of Object.entries(models)) {
    schemaCategory = category;
    const schemaPath = `schemas/${model.upstream}.schema.json`;
    let validate;
    if (tree.find(e => e.file === schemaPath)?.mode === '100644') {
      // File I/O failure means an incomplete checkout, not bad product data.
      const schemaText = await readFile(path.join(repo, schemaPath), 'utf8');
      try { validate = ajv.compile(JSON.parse(schemaText)); }
      catch { issues.add({ code: 'schema_unavailable', category, scope: 'diagnostic' }); }
    } else issues.add({ code: 'schema_missing', category, scope: 'diagnostic' });
    const prefix = `open-db/${model.upstream}/`;
    const entries = tree.filter(e => e.file.startsWith(prefix));
    const expected = entries.filter(e => e.file.endsWith('.json')).sort((a,b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
    if (!expected.length) heldCategories[category] = ['category_missing_or_empty'];
    if (entries.some(e => e.mode !== '100644' || !/^.*\/[a-f0-9-]+\.json$/i.test(e.file) || e.file.slice(prefix.length).includes('/'))) heldCategories[category] = ['unsupported_layout'];
    const coverage = Object.fromEntries(Object.keys(model.fields).map(k => [k, 0]));
    const stats = report.categories[category] = { count: expected.length, validated: 0, accepted: 0, quarantined: 0, fields_present: coverage, identifiers: 0, identified_products: 0, invalid_to_unknown: 0 };
    report.samples[category] = [];
    const identities = new Set();
    for (const { file, mode } of expected) {
      if (mode !== '100644') throw new Error('Incomplete snapshot: product is not a regular Git blob');
      const filename = path.basename(file, '.json');
      const key = UUID.test(filename) && !file.slice(prefix.length).includes('/') ? `${model.upstream}/${filename}` : null;
      presence.push({ category, file, upstream_key: key, evidence: 'complete_git_tree_uuid_filename' });
      if (!key) heldCategories[category] = ['ambiguous_identity'];
      const source = await readFile(path.join(repo, file), 'utf8');
      const add = item => {
        issues.add({ ...item, category, upstream_key: key });
        if (item.scope === 'field' && item.code !== 'unknown_spec') stats.invalid_to_unknown++;
      };
      try {
        if (Buffer.byteLength(source) > limits.rawBytes) throw new InputIssue('raw_size_limit', '');
        let d;
        try { d = JSON.parse(source); } catch (e) { if (!(e instanceof SyntaxError)) throw e; throw new InputIssue('invalid_json', ''); }
        if (validate) {
          if (validate(d)) stats.validated++;
          else for (const error of validate.errors) add({ code: `schema_${error.keyword}`, field: error.instancePath, scope: 'diagnostic' });
        }
        if (d?.opendb_id !== filename || !key) {
          const ambiguous = !key || typeof d?.opendb_id === 'string' && UUID.test(d.opendb_id);
          if (ambiguous) heldCategories[category] = ['ambiguous_identity'];
          throw new InputIssue(ambiguous ? 'identity_path_mismatch' : 'invalid_identity', 'opendb_id');
        }
        if (identities.has(d.opendb_id.toLowerCase())) {
          heldCategories[category] = ['identity_collision']; throw new InputIssue('identity_collision', 'opendb_id');
        }
        identities.add(d.opendb_id.toLowerCase());
        if (seen.has(d.opendb_id)) report.cross_category_ids.push({ upstream_id: d.opendb_id, files: [seen.get(d.opendb_id), file] });
        seen.set(d.opendb_id, file);
        const normalized = normalize(category, d, commit, add);
        records.push(normalized);
        stats.accepted++; stats.identifiers += normalized.identifiers.length; stats.identified_products += Number(normalized.identifiers.length > 0);
        for (const [k, v] of Object.entries(normalized.spec)) if (v !== null) coverage[k]++;
      } catch (error) {
        if (!(error instanceof InputIssue)) throw error;
        const item = { category, upstream_key: key, file, code: error.code, field: error.field, scope: 'product' };
        quarantined.push(item); stats.quarantined++; add(item);
      }
    }
  }
  if (git(repo, ['rev-parse', 'HEAD']) !== commit || git(repo, ['status', '--porcelain'])) {
    throw new Error('Upstream checkout changed while reading the snapshot');
  }
  report.held_categories = heldCategories;
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(path.join(reportDirectory, 'inspection.json'), JSON.stringify(report, null, 2));
  return { commit, records, presence, quarantined, heldCategories, complete: true, report };
}
