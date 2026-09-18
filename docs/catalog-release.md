# Catalog release gates

## Current state

Category FTS generation 8 / cache generation 3 / cursor pagination / stable
Product Reference / batch resolve / Product Detail are production-verified.
The 2026-09-18 [transition report](production-transition.md) records the retained
old D1, promoted D1, deployed version, measurements and recovery procedure.
Promotion commit `b08c5b416cfdd48fc36a13c0a288e39abbe943b9` is published on
default branch `main`. The repository production binding matches the promoted
D1 (`0d64ee1a-6ead-4bfd-9dfd-91535e5b3030`); scheduled and manual releases can
use FTS8 through the existing gates.
Automated quality failures must be resolved before a production release.
Human checks/approvals are never release prerequisites. A measurement command succeeding does not
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
4. All lookup fixtures are automatically checked: exact-model Hit@1, other lookup Hit@3 (explicit
   typo/fallback Hit@5). Identifier Hit@1=100% against normalized source owners,
   including source-derived equivalent sets; identifier requires no human review.
5. browse candidate-window relevant coverage ≥90%, candidate precision ≥80%,
   no unexpected zero results. Huge exhausted windows use attainable coverage;
   exhaustion is a UI refinement state, not failure. Top20 is diagnostic only.
6. browse_filter Recall/Precision=1, FP=FN=0, no out-of-filter product.
   filter_only exact set equality, zero duplicate/missing/extra, independent
   stable sort checks and complete cursor traversal (including changed page size).
7. Product reference resolution preserves order/duplicates and distinguishes
   active/inactive/missing; IDs/status match current catalog. Shared URL and
   changed-ID restoration tests run in `npm run check`.
8. Seven-intent D1 rows_read, SQL duration median/p95, query count and plans.
   No unexpected catalog full scans or missing cost metadata. Official remote-
   measured budgets default to `docs/production-performance-budgets.json`;
   `PERFORMANCE_BUDGET_FILE` can explicitly replace them. Intent max ceilings
   also cover every pagination page. Temp candidate sorts remain visible.
9. Human review files and decisions are not read by release. No pending-review
   blocker or reviewer/rationale requirement exists. Expected sets still come
   from source rather than returned rankings.

See [evaluation definitions](search-evaluation.md). The default benchmark runs
236 search cases: original 120 + extended 102 + UI 14. Low-level rank diagnostics are
not release gates. Product Detail's 30-category indexed-plan/API/cache tests run
in `npm run check`.

Product Detail still counts four SQL statements against `max_query_count=4`.
The Worker performs two D1 binding operations: product `.all()`, then one
`batch()` for spec/identifiers/facets. Runtime `d1_queries` counts statements;
additive `d1_operations` counts binding calls (not provider-internal retries).
`rows_read` and SQL duration sum all statement metadata, including each batch
result. The direct-D1 quality adapter measures statements independently; its
query count is not the Worker's remote round-trip count. See the
[Detail cleanup measurement](product-detail-performance.md).

## Epoch, cache and identity

`sync-<completed sync_runs.id>-fts8-cache3` invalidates both search and Detail
namespaces. Retry compares actual hashes under the lease and reuses a complete
sync ID only if that same commit/normalizer has no changes. Workflow attempt/time
is not an epoch input. Search TTL stays configurable at 60/300/600; Detail is 600.
Out-of-band enrichment edits require the existing completed-sync/epoch release
procedure or become visible after TTL expiry.
Cursor context uses the same epoch and rejects old cursors after publication.
Resolver and cursor requests bypass edge cache. Durable product references do
not contain epoch or runtime ID and survive publication/rebuild.

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

The release command fails on automated quality/integrity/performance violations.
Human checking is optional offline diagnosis, not an approval stage. Artifacts
include the intent report.
`--local` never runs production compile/deploy or changes a production epoch.
`.cache/release-ux-report.json` persists failures and plans before asserting the
gate. See [current local results](category-search-validation.md) and
[budget configuration](search-evaluation.md).

If sync is partial/failed, keep the same pinned commit and rerun after the lease
is free; hashes skip completed chunks. Historical failed/partial runs remain as
audit records. An expired lease is recovered by the normal sync protocol.
If quality fails after sync, do not deploy; inspect the reported case/source
judgment, correct implementation or manually review justified fixture changes.

Sync updates the catalog in place. A retained old Worker is not a retained old
snapshot; there is no claim of atomic whole-catalog publication. Keep manual SQL,
migrations and enrichment writes outside the release window. Product-level
ingestion and category moves remain atomic.
