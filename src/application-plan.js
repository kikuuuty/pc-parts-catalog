import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { models, NORMALIZER_VERSION } from './model.js';
import { normalize, normalizeV1 } from './normalize.js';
import { INPUT_CONTRACT_VERSION, validateNormalized } from './input-contract.js';
import { loadQualityCatalog } from './quality/catalog.js';
import { ingestionQuality, DEFAULT_MAX_DELETE_FRACTION } from './quality/ingestion.js';

export const PLAN_DIRECTORY = '.cache/application-plans';
const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k,v[k]])) : v);
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
// Binary order, not locale collation (which can equate distinct zero-width or
// accented identifiers). Hashes must be independent of input/SQL row order.
const sorted = rows => [...rows].sort((a,b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0);
export const recordDigest = r => digest({ ...r, identifiers: sorted(r.identifiers), facets: sorted(r.facets) });
const productFields = ['upstream_id','upstream_key','category','manufacturer','name','series','variant','release_year','manufacturer_url','identity_version','content_hash','source_commit','normalization_version'];
export async function latestSync(db) { return (await db.query('SELECT * FROM sync_runs ORDER BY started_at DESC,id DESC LIMIT 1')).results[0] ?? null; }

// Called only while holding the writer lease, before auto-resume or planning.
// Every writer records sync_runs BEFORE its first product write. Therefore an
// unchanged completed base (or no history AND no products) proves no start.
export async function assertUnstartedBase(db, latest, pin) {
  assert.equal(latest?.id ?? null, pin.base_sync_id, 'plan_recovery_base_changed');
  assert(!latest || latest.status === 'complete', 'plan_recovery_base_not_complete');
  if (Object.hasOwn(pin, 'base_plan_hash')) assert.equal(latest?.plan_hash ?? null, pin.base_plan_hash, 'plan_recovery_base_plan_changed');
  if (Object.hasOwn(pin, 'base_source_commit')) assert.equal(latest?.source_commit ?? null, pin.base_source_commit, 'plan_recovery_base_commit_changed');
  const others = latest
    ? await db.query("SELECT count(*) n FROM sync_runs WHERE id<>? AND (started_at>=? OR status='running')", [latest.id, latest.started_at])
    : await db.query('SELECT count(*) n FROM sync_runs');
  assert.equal(others.results[0].n, 0, 'plan_recovery_sync_already_started');
  if (!latest) assert.equal((await db.query('SELECT count(*) n FROM products')).results[0].n, 0, 'plan_recovery_initial_products_exist');
  assert.equal((await db.query('SELECT count(*) n FROM ingest')).results[0].n, 0, 'plan_recovery_unfinished_ingest');
}

// Paged reads; no per-product D1 requests. Called under the writer lease.
export async function storedCatalog(db) {
  const catalog = await loadQualityCatalog(db), raw = new Map(), local = new Map();
  let cursor = 0;
  while (true) {
    const rows = (await db.query('SELECT p.id,r.raw_json,d.text FROM products p LEFT JOIN upstream_raw r ON r.product_id=p.id LEFT JOIN product_search_documents d ON d.product_id=p.id WHERE p.id>? ORDER BY p.id LIMIT 250', [cursor])).results;
    if (!rows.length) break;
    for (const r of rows) raw.set(r.id, r);
    const enrichments = (await db.query('SELECT * FROM local_enrichments WHERE product_id>? AND product_id<=? ORDER BY product_id,namespace,key', [cursor,rows.at(-1).id])).results;
    for (const e of enrichments) { if (!local.has(e.product_id)) local.set(e.product_id, []); local.get(e.product_id).push(e); }
    cursor = rows.at(-1).id;
  }
  return catalog.products.map(p => {
    assert.equal(p.source, 'buildcores', 'Unexpected source in baseline');
    const record = { product: Object.fromEntries(productFields.map(k => [k,p[k]])),
      spec: Object.fromEntries(Object.keys(models[p.category].fields).map(k => [k,p.spec?.[k]])),
      identifiers: p.identifiers.filter(i => i.origin === 'upstream').map(({type,value,value_key,region,origin_field}) => ({type,value,value_key,region,origin_field})),
      facets: p.facets.map(({attribute,value}) => ({attribute,value})), raw: raw.get(p.id)?.raw_json, search_text: raw.get(p.id)?.text };
    return { id: p.id, active: p.active, created_at: p.created_at, updated_at: p.updated_at, record,
      local_hash: digest({ identifiers: p.identifiers.filter(i => i.origin === 'local'), enrichments: local.get(p.id) ?? [] }) };
  });
}

export function validateBaseline(rows, source) {
  const byKey = source && new Map(source.records.map(r => [r.product.upstream_key, r]));
  for (const row of rows) {
    const r = row.record, v = r.product.normalization_version;
    assert.match(r.product.source_commit, /^[a-f0-9]{40}$/, 'Invalid baseline provenance');
    assert([1, NORMALIZER_VERSION].includes(v), 'Unsupported baseline normalization generation');
    // Never make the DB its own oracle: reconstruct from raw and verify its
    // independently stored hash AND every normalized field/projection.
    const expected = (v === 1 ? normalizeV1 : normalize)(r.product.category, JSON.parse(r.raw), r.product.source_commit);
    if (recordDigest(r) !== recordDigest(expected)) {
      const fields = [...Object.keys(r.product).filter(k => r.product[k] !== expected.product[k]).map(k => `product.${k}`),
        ...Object.keys(r.spec).filter(k => r.spec[k] !== expected.spec[k]).map(k => `spec.${k}`),
        ...['raw','search_text'].filter(k => r[k] !== expected[k]),
        ...['identifiers','facets'].filter(k => digest(sorted(r[k])) !== digest(sorted(expected[k])))];
      throw new Error(`Baseline source integrity failed: ${r.product.upstream_key} (${fields.join(',')})`);
    }
    if (byKey && row.active) {
      const independent = byKey.get(r.product.upstream_key);
      assert(independent, 'Baseline product missing from fixed source');
      const original = (v === 1 ? normalizeV1 : normalize)(r.product.category, JSON.parse(independent.raw), r.product.source_commit);
      assert.equal(recordDigest(r), recordDigest(original), 'Baseline differs from fixed upstream source');
    }
  }
  if (byKey) assert.equal(rows.filter(r => r.active).length, byKey.size, 'Baseline source count differs');
}

export function makeApplicationPlan(snapshot, baseline, base, { maxDeleteFraction = DEFAULT_MAX_DELETE_FRACTION, baselineSource, baselinePlan, workflowRunId } = {}) {
  assert(Number.isFinite(maxDeleteFraction) && maxDeleteFraction >= 0 && maxDeleteFraction <= 1, 'Invalid deletion threshold');
  assert(!base || base.status === 'complete', 'Missing plan: partial/failed DB cannot become a normal baseline');
  assert(base || baseline.length === 0, 'Baseline has no completed sync');
  if (snapshot.presence) assert.equal(snapshot.complete, true, 'Snapshot inventory is incomplete');
  if (base?.plan_hash) {
    assert.equal(baselinePlan?.hash, base.plan_hash, 'Previous complete application plan is required');
    verifyPlanState(baselinePlan, baseline, { complete: true, allowLocalChanges: true });
  } else if (baseline.length) {
    assert.equal(baselineSource?.commit, base?.source_commit, 'Legacy baseline requires its fixed upstream source');
  }
  validateBaseline(baseline, base?.plan_hash ? undefined : baselineSource);
  const accepted = new Map();
  for (const r of snapshot.records) {
    validateNormalized(r);
    assert(!accepted.has(r.product.upstream_key), 'Identity collision in normalized input');
    accepted.set(r.product.upstream_key, r);
  }
  const presence = new Set(snapshot.presence?.map(p => p.upstream_key).filter(Boolean) ?? accepted.keys());
  for (const key of accepted.keys()) assert(presence.has(key), 'Accepted identity missing from inventory');
  const previous = { ...Object.fromEntries([...new Set(baseline.filter(r => r.active).map(r => r.record.product.category))].map(c => [c, { last_good_commit: base?.source_commit ?? null }])),
    ...(base?.report_json ? JSON.parse(base.report_json).quality?.categories ?? {} : {}) };
  const quality = ingestionQuality(snapshot, baseline, previous, { maxDeleteFraction });
  const previousRows = new Map(baselinePlan?.rows.map(r => [r.key,r]) ?? []);
  const rows = [], deletions = [], retained = [];
  const oldKeys = new Set();
  for (const old of baseline) {
    const key = old.record.product.upstream_key, category = old.record.product.category;
    oldKeys.add(key);
    const incoming = accepted.get(key), held = quality.held[category];
    let record = old.record, active = old.active, mode = 'inactive';
    if (held || presence.has(key) && !incoming) { mode = 'retained'; retained.push(key); quality.categories[category].retained++; }
    else if (incoming) {
      mode = 'accepted'; active = 1;
      if (old.record.product.content_hash === incoming.product.content_hash) {
        assert.equal(recordDigest(old.record), recordDigest({ ...incoming, product: { ...incoming.product, source_commit: old.record.product.source_commit } }), 'Equal content hash has different normalization output; review generation');
      }
      // Unchanged rows retain their actual source commit, including after a
      // later no-change observation. Reappearance applies the new provenance.
      record = old.active && old.record.product.content_hash === incoming.product.content_hash ? old.record : incoming;
    } else if (old.active) { mode = 'deleted'; active = 0; record = { ...old.record, product: { ...old.record.product, source_commit: snapshot.commit } }; deletions.push(key); }
    rows.push({ key, id: old.id, active, mode, record, local_hash: old.local_hash, created_at: old.created_at,
      retained_updated_at: mode === 'retained' ? old.updated_at : null,
      retained_since: mode === 'retained' ? previousRows.get(key)?.retained_since ?? new Date().toISOString() : null,
      reasons: mode === 'retained' ? held ?? snapshot.quarantined?.filter(r => r.upstream_key === key).map(r => r.code) ?? ['unaccepted_presence'] : [],
      baseline: { digest: recordDigest(old.record), active: old.active } });
  }
  let nextId = baseline.reduce((max,r) => Math.max(max,r.id), 0);
  for (const [key, record] of accepted) if (!oldKeys.has(key) && !quality.held[record.product.category]) rows.push({ key, id: ++nextId, active: 1, mode: 'accepted', record, baseline: null });
  for (const category of new Set(baseline.map(r => r.record.product.category))) {
    const active = baseline.filter(r => r.active && r.record.product.category === category).length;
    const removed = rows.filter(r => r.mode === 'deleted' && r.record.product.category === category).length;
    assert(!active || removed / active <= maxDeleteFraction, `Deletion fraction for ${category} exceeds protection`);
  }
  const active = baseline.filter(r => r.active).length;
  assert(!active || deletions.length / active <= maxDeleteFraction, 'Global deletion fraction exceeds protection');
  const counts = Object.fromEntries(Object.keys(models).map(c => [c, rows.filter(r => r.active && r.record.product.category === c).length]));
  for (const [category, stats] of Object.entries(quality.categories)) {
    stats.published = counts[category]; stats.source_commits = {};
    for (const row of rows) if (row.active && row.record.product.category === category) {
      const commit = row.record.product.source_commit;
      stats.source_commits[commit] = (stats.source_commits[commit] ?? 0) + 1;
    }
  }
  quality.status = retained.length || Object.keys(quality.held).length || snapshot.quarantined?.length ? 'held' : snapshot.report?.diagnostics?.total ? 'warnings' : 'clean';
  const plan = { version: 1, commit: snapshot.commit, contract_version: INPUT_CONTRACT_VERSION, normalization_version: NORMALIZER_VERSION,
    ...(workflowRunId ? { workflow_run_id: workflowRunId } : {}),
    max_delete_fraction: maxDeleteFraction,
    base_sync_id: base?.id ?? null, base_plan_hash: base?.plan_hash ?? null, baseline_hash: digest(baseline.map(r => [r.id, r.active, recordDigest(r.record), r.local_hash])),
    input_hash: snapshotDigest(snapshot), created_at: new Date().toISOString(), presence: snapshot.presence ?? [...presence].map(upstream_key => ({ upstream_key })),
    quarantined: snapshot.quarantined ?? [], retained, deletions, counts, quality, diagnostics: snapshot.report?.diagnostics ?? null, rows };
  return { ...plan, hash: digest(plan) };
}
export const snapshotDigest = snapshot => digest({ commit: snapshot.commit, records: snapshot.records, presence: snapshot.presence, quarantined: snapshot.quarantined, heldCategories: snapshot.heldCategories });
export function assertPlan(plan) {
  const { hash, ...body } = plan;
  assert.equal(digest(body), hash, 'Application plan hash mismatch');
  assert.equal(plan.version, 1, 'Application plan format differs');
  assert.equal(plan.contract_version, INPUT_CONTRACT_VERSION, 'Input contract generation differs');
  assert.equal(plan.normalization_version, NORMALIZER_VERSION, 'Normalizer generation differs');
  assert.equal(new Set(plan.rows.map(r => r.key)).size, plan.rows.length, 'Application plan identity collision');
  return plan;
}
export async function savePlan(plan, file = path.join(PLAN_DIRECTORY, `${plan.hash}.json`)) {
  assertPlan(plan); await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(plan)); await rename(temporary, file);
  return file;
}
export async function readPlan(file) { return assertPlan(JSON.parse(await readFile(file, 'utf8'))); }
export async function planForSync(sync, file) {
  assert(sync?.plan_hash, 'Completed sync has no application plan; create a reviewed plan first');
  const plan = await readPlan(file ?? path.join(PLAN_DIRECTORY, `${sync.plan_hash}.json`));
  assert.equal(plan.hash, sync.plan_hash, 'Application plan does not match sync');
  assert.equal(plan.commit, sync.source_commit, 'Application plan commit differs');
  return plan;
}
export function publishedSnapshot(plan) {
  assertPlan(plan);
  return { commit: plan.commit, records: plan.rows.filter(r => r.active).map(r => r.record), applicationPlan: plan };
}

export function assertPlanBase(plan, latest) {
  assert((latest?.id ?? null) === plan.base_sync_id || latest?.plan_hash === plan.hash && latest.source_commit === plan.commit, 'Application plan superseded by another sync');
  if ((latest?.id ?? null) === plan.base_sync_id) {
    assert(!latest || latest.status === 'complete', 'Application plan baseline is no longer complete');
    assert.equal(latest?.plan_hash ?? null, plan.base_plan_hash, 'Application plan baseline generation changed');
  }
}
export function verifyPlanState(plan, actual, { complete = false, allowLocalChanges = false, baselineOnly = false } = {}) {
  assertPlan(plan);
  const expected = new Map(plan.rows.map(r => [r.key, r])), seen = new Set();
  for (const row of actual) {
    const key = row.record.product.upstream_key, target = expected.get(key);
    assert(target, 'Unexpected product outside application plan'); seen.add(key);
    assert.equal(row.id, target.id, 'Persistent product ID changed');
    if (target.baseline) {
      assert.equal(row.created_at, target.created_at, 'Product creation provenance changed');
      if (!allowLocalChanges) assert.equal(row.local_hash, target.local_hash, 'Local data changed since application plan');
    } else if (!allowLocalChanges) assert.equal(row.local_hash, digest({identifiers:[],enrichments:[]}), 'New product local data changed during application');
    const hash = recordDigest(row.record);
    const matchesTarget = row.active === target.active && hash === recordDigest(target.record);
    const matchesBase = target.baseline && row.active === target.baseline.active && hash === target.baseline.digest;
    assert(baselineOnly ? matchesBase : matchesTarget || !complete && matchesBase, 'Product differs from fixed baseline and application plan');
    if (target.mode === 'retained') assert.equal(row.updated_at, target.retained_updated_at, 'Retained provenance changed');
  }
  for (const row of plan.rows) assert(seen.has(row.key) || !complete && !row.baseline, 'Missing planned product');
  return true;
}
