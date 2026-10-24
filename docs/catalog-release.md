# Catalog release gates

## Current state

The resilient-ingestion implementation adds normalizer generation 2 and forward
migration 0011. Production application is separate from implementation/local
validation. See [input policy, manifest recovery and rollout](resilient-sync.md).

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
npm ci → check → immutable upstream pin → input contract / schema diagnostics
  → verified baseline / fixed application plan → upload immutable plan artifact
  → migration history / planned counts → product-atomic incremental sync
  → complete sync required → D1 release lease
  → catalog integrity → category FTS integrity → source integrity diagnostics
  → all-category Filter metadata / source oracle / plans / read cost
  → intent quality / plans / cost
  → epoch → Wrangler dry-run → version/tag reconciliation → deploy
  → production smoke / Filter HTTP + source predicates / cache / HTTP-to-direct compiler equivalence
  → state/version recheck → lease release → report artifact
```

Schema migrations are never automatically applied by this pipeline. Migration
history must exactly match the checkout. This prevents a new Worker using tables
not yet created, and an old checkout operating against a newer schema.

## Gate contract

1. Latest sync complete, current normalizer, finished timestamp. No unfinished
   ingest, running writer, residual foreign lease, FK or SQLite integrity error.
2. Active count 20,000–100,000, exact per-category counts from the fixed plan.
   Only an explicit bootstrap category hold permits an empty category.
   Raw/spec/identifier/facet/source identity
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
sync ID only if that same plan has no changes and its complete state verifies. Workflow attempt/time
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

If sync is partial/failed, restore the same pinned commit **and application plan**
and rerun after the lease is free; verified applied chunks are skipped. A missing
plan cannot be rebuilt from the partial DB. Historical failed/partial runs remain as
audit records. An expired lease is recovered by the normal sync protocol.
If quality fails after sync, do not deploy; inspect the reported case/source
judgment, correct implementation or manually review justified fixture changes.

Sync updates the catalog in place. A retained old Worker is not a retained old
snapshot; there is no claim of atomic whole-catalog publication. Keep manual SQL,
migrations and enrichment writes outside the release window. Product-level
ingestion and category moves remain atomic.

### Retry before plan persistence

The workflow now explicitly discovers artifacts on **every attempt**, using
`node scripts/catalog-plan-artifact.js restore`. Only successful, consistent
enumeration of all run-scoped artifact pages can yield `absent`. Permission
errors, 429, 5xx, timeouts, expired/ambiguous artifacts, download/extraction
failures and invalid JSON/hash/commit/run/base identity stop the release; they
are never treated as an unsaved plan. `continue-on-error` is not used.

* **Reuse:** an existing valid plan is restored and validated without changing
  its hash, policy decisions or pinned commit. It is not uploaded again.
* **Create:** an explicitly absent artifact allows the plan CLI to attempt
  recovery with the original same-run pin. Under the writer lease, latest sync
  must equal `pin.base_sync_id`, be complete, and have no subsequent start or
  running writer/unfinished ingest. New pins also bind base plan hash/commit.
  The entire baseline must independently match its previous plan or fixed
  upstream source. With a null base, both sync history and products must be
  empty. No moving-main resolution occurs.
* **Stop:** missing/foreign pin, uncertain retrieval, changed/corrupt baseline,
  or any start of the target sync (running/partial/failed/complete). Even the
  same source commit with a different sync ID/plan is superseded. Missing
  report files/`report_json` are not evidence of no product writes.

`sync_runs` is inserted under writer exclusion **before the first product
write**. The recovery check relies on this order, not on optional reports.
`scripts/lib/plan-artifact.js` is shared by the workflow artifact CLI and
release CLI. `plan` emits `upload_required` only after its DB checks. Any newly
created plan, including attempt 2+, must be uploaded with `overwrite: false`;
the `confirm` command then re-downloads and matches its hash. Only a restored
or confirmed-saved receipt permits the sync CLI and workflow to proceed.
Sync rechecks base/plan/rows under its own lease after the upload interval.

If upload fails or its response is lost, that attempt never starts product
writes. Retry the **failed job of the same workflow run**, preserving artifacts.
A plan saved server-side is restored on retry without overwrite; a genuinely
unsaved plan can be rebuilt only after the complete unstarted-base checks.
After writes start, recover the exact original plan from an artifact/backup;
never regenerate it from the changed DB or delete sync history to bypass guards.
Fix retrieval/permission problems before retrying. Expired artifacts fail closed.

Safe diagnostics are in `.cache/release-plan-artifact.json`
(`absent/restored/saved`, reason, run/base IDs, commit, artifact ID, plan hash),
`release-plan-artifact-report.json` (`stopped`, phase/reason on retrieval failure),
and `release-plan-report.json` (`plan_recovery`, validation/reason). They contain
no plan body, credentials or provider response bodies. All are included in the
existing summary artifact glob. See [local regression results](resilient-sync-retry-validation.md).

### Category deletion holds

New plans compute category deletion candidates before choosing application
rows, from the **verified active baseline minus the complete upstream presence
key set**, not accepted records. Quarantined-but-present keys do not count;
duplicate presence entries cannot inflate counts. Strictly exceeding the same
`maxDeleteFraction` used by the final deletion guards holds that whole category
(`category_delete_fraction`), even if total count is unchanged by replacement.
The exact threshold is permitted; an empty active base has zero candidates/rate.

Held categories preserve old active/inactive rows, IDs, raw, provenance and local
data, suppress new products and perform no update/deletion/reactivation. Other
independently safe categories continue, including partial/resume. The final
global deletion guard and all downstream integrity/Filter/search gates remain.
`quality.categories.<category>.deletion` preserves baseline active count,
pre-hold candidates, rate and threshold even when actual planned deletions are 0.
The decision is fixed in the plan, never recalculated from a partial DB.

Quality policy generation is now 2 for this pre-application category hold.
Plan format 1, input contract 1 and normalizer generation 2 are unchanged.
Saved policy-1 plans are read/resumed unchanged, including hashes, and can serve
as baselines for new plans. No additional migration or mass renormalization is
required by this correction. A safe subsequent snapshot can release the hold
without changing retained product IDs.

## Incremental snapshot provenance and diagnostics

`products.source_commit` is the upstream commit at the **last update of that row**.
Unchanged products deliberately retain it. `sync_runs.source_commit` identifies
the observed snapshot whose **application plan completed**. The plan records actual
row provenance, including unchanged and retained rows. Plan-backed source integrity
checks `source_commit` as well as all other normalized product fields, raw,
typed specs, upstream identifier sets and facet sets. These remain
strictly checked, independent of matching content hashes. Missing/unexpected
active products fail. The release's snapshot-vs-completed-sync equality remains
mandatory. No blanket provenance rewrite is performed.

`searchGate` saves `.cache/release-source-integrity.json` before rejecting source
mismatches, then `.cache/release-filter-metadata.json` before publication can
proceed, followed by `.cache/release-ux-report.json`. The latter's `phases` and
the CLI report's `validation` distinguish `not_run`, `running`, `passed`, `failed`
for `source_integrity`, `filter_metadata`, `search_quality`, `query_plans`.
Source failure leaves search quality `not_run`; legacy `golden`, `deploy` and
`post_deploy` fields are retained for existing report consumers. Partial reports
are saved on exceptions without replacing the original error on save failure.

Normal CI invokes the same gate once on fixed snapshot A (including actual Filter
metadata); its dependent isolated A→B job checks the incremental path and HTTP.
Production invokes it on the caller's DB under the existing release lease before
deploy, then `verifyProduction` checks all 30 Filter endpoints and representative
metadata-derived POST searches, in addition to existing search/Detail/resolve.
Both CI and release always upload `release-*.json`, including failed diagnostics.
See [report formats, measured A→B results and recovery](incremental-release-validation.md).
