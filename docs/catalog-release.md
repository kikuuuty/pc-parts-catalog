# Catalog release gates

## Current state

Category FTS generation 8 / cache generation 2 / Product Detail are implemented
and tested locally. Production migration, sync and deploy are a separate phase.
The extended fixture's human review and outstanding quality failures must be
resolved before a production release. A measurement command succeeding does not
mean the release gate passed.

## Pipeline

`.github/workflows/sync.yml` retains weekly Monday 03:17 UTC and manual dispatch.
`catalog-production-sync` concurrency serializes the whole release without
cancelling an active writer. Production credentials execute only the reviewed
default branch.

```text
npm ci → check → immutable upstream pin → full source validation
  → migration history / count envelope → atomic incremental sync
  → complete sync required → D1 release lease
  → catalog integrity → category FTS integrity → intent quality / plans / cost
  → epoch → Wrangler dry-run → version/tag reconciliation → deploy
  → production smoke / cache / HTTP-to-direct compiler equivalence
  → state/version recheck → lease release → report artifact
```

Schema migrations are never automatically applied by this pipeline. Migration
history must exactly match the checkout. This prevents a new Worker using tables
not yet created, and an old checkout operating against a newer schema.

## Gate contract

1. Latest sync complete, current normalizer, finished timestamp. No unfinished
   ingest, running writer, residual foreign lease, FK or SQLite integrity error.
2. Active count 20,000–100,000, all 30 categories nonempty, exact per-category
   counts from the validated source. Raw/spec/identifier/facet/source identity
   and active state are validated independently of search results.
3. All active products occur exactly once in their own category FTS; missing,
   duplicate, wrong-category and inactive/deleted orphan counts are zero.
   Canonical field projection and durable search document agree.
4. lookup exact-model Hit@1; other lookup Hit@3 (explicit typo fallback Hit@5).
   identifier Hit@1=100%, or an explicit equivalent SKU set.
5. browse Recall@20 ≥90% of its attainable maximum, Precision@20 ≥0.9,
   no unexpected zero results. No expected-rank equality requirement.
6. browse_filter Recall/Precision=1, FP=FN=0, no out-of-filter product.
   filter_only exact set equality and deterministic, complete pagination.
7. Per-case D1 read/duration budgets; query plan checks with no unexpected catalog
   full scans. Temp B-trees over candidate sets are visible, not hidden.
8. Pending human-review fixtures block release. Expected sets are not rewritten
   automatically, and improved cases cannot conceal failing cases.

See [evaluation definitions](search-evaluation.md). The default benchmark runs
233 cases: original 120 + extended 102 + UI 11. Low-level rank diagnostics are
not release gates. Product Detail's 30-category indexed-plan/API/cache tests run
in `npm run check`.

## Epoch, cache and identity

`sync-<completed sync_runs.id>-fts8-cache2` invalidates both search and Detail
namespaces. Retry compares actual hashes under the lease and reuses a complete
sync ID only if that same commit/normalizer has no changes. Workflow attempt/time
is not an epoch input. Search TTL stays configurable at 60/300/600; Detail is 600.
Out-of-band enrichment edits require the existing completed-sync/epoch release
procedure or become visible after TTL expiry.

The temporary production Wrangler config is a complete copy with the derived
epoch; it is ignored by Git and removed in `finally`. `release-<sha256>` tags
cover effective config, `src/`, and lockfile. Matching deployed version/config
can skip duplicate upload but still runs post-release verification.

## Credentials and budgets

|Setting|Purpose|
|---|---|
|`CLOUDFLARE_API_TOKEN` secret|D1 Edit, Workers Scripts Edit, version/deployment reads|
|`CLOUDFLARE_ACCOUNT_ID` secret|Must match production config|
|`CLOUDFLARE_D1_DATABASE_ID` variable|Optional; must match production DB binding|
|`GITHUB_TOKEN`|contents/actions read for immutable pin artifacts|

The Worker only receives D1/rate-limit bindings, not administrative credentials.
Manual inputs retain `upstream_ref`, `max_products=10000`,
`write_budget=2000000`. The ordinary remote sync CLI retains 1000/80000 defaults.
Budgets are conservative chunk controls, not a guarantee of billed daily totals.
The per-category deletion guard and immutable pin survive retries.

## Local verification and recovery

```sh
npm run check
npm run verify:catalog
npm run benchmark:search -- --output .cache/search-ux.json
npm run release:verify -- --local
```

The release command intentionally fails while review/quality issues remain.
CI retains those release gates rather than converting pending evidence into a
successful production approval. Artifacts include the intent report.

If sync is partial/failed, keep the same pinned commit and rerun after the lease
is free; hashes skip completed chunks. Historical failed/partial runs remain as
audit records. An expired lease is recovered by the normal sync protocol.
If quality fails after sync, do not deploy; inspect the reported case/source
judgment, correct implementation or manually review justified fixture changes.

Sync updates the catalog in place. A retained old Worker is not a retained old
snapshot; there is no claim of atomic whole-catalog publication. Keep manual SQL,
migrations and enrichment writes outside the release window. Product-level
ingestion and category moves remain atomic.
