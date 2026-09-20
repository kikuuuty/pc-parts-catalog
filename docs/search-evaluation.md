# UX search evaluation and release contract

The gate protects finding, filtering, selecting, saving and sharing products.
FTS/BM25 = candidate retrieval; display ordering = a separate concern.
Historical ranks and Top20 precision are not browse release floors.

## Independent source and optional diagnostics

The pinned BuildCores snapshot is
`eec0df175504ebd15f0f3e3a8249a18a22f00940` (48,134 products).
Normalized source records, not search results, supply relevant sets. Missing DB
products remain in the denominator. Source verification checks raw data, product
fields, category, active state, typed specs, identifiers and facets.

Release evaluation uses the validated snapshot matching the completed sync, not
always that historical fixture-authoring snapshot. Product `source_commit` is
last-row-update provenance and is the sole excluded canonical field; completed
`sync_runs.source_commit` must still equal the evaluation snapshot.

`ext-keyboard-12` retains the original `aula` + polling_rate_hz >= 1000 search and
exact filtered-set floor. Its UX relevance overlay now expresses the original
source rule as `nameTokens: ["AULA"]`, intersected with the existing range, rather
than freezing the 19 IDs from snapshot A. Snapshot B legitimately fills polling
rate for five AULA F75 MAX variants, giving 24 source matches. The frozen extended
fixture/evidence stays intact; no ID whitelist for B, skipped case, ranking change
or reduced floor is introduced. A regression test covers enrichment entering the
set and still detects a missing FTS document. Details/evidence are in
[incremental release validation](incremental-release-validation.md).

The 120 legacy + 102 extended + 11 frontend cases retain the five intents:
lookup, identifier, browse, browse_filter, filter_only. The frozen source files
are retained; `search-ux-overrides.json` describes the ten UX reclassifications.

**Human review is optional and never a release gate.** There is no reviewer,
rationale, checklist or completion quota. All 111 lookup fixtures are machine
evaluated regardless of any human judgment. The fixture loader does not read
`search-reviews.json`; old approval files cannot block release, even when missing
or stale. Per-case fixture hashes remain provenance, not approval requirements.

When something looks wrong, `npm run diagnose:search` opens a loopback-only
[diagnostic UI](search-diagnostics.md). Enter any category/query, optionally add
typed filters, inspect actual results, and expand scores/plans only as needed.
No judgments or diagnostic interactions are sent to the release gate.

Identifier needs no review. The query's normalized code (NFKC, trim, ASCII upper;
preserve leading zeros, punctuation and internal spaces), optional type and
category select owners directly from source identifiers. All source owners form
the equivalent set, even when the code belongs to multiple products. A missing
mapping fails; search must put a member at rank 1. Search results never define
acceptable products. MPN/EAN/UPC/GTIN/JAN follow the same rule; identifier type is
not silently converted to another barcode type.

## Gates and metrics

|Intent|Release requirement|
|---|---|
|lookup|Automatically evaluate every case: exact_model Hit@1, normal Hit@3, explicit fallback/typo Hit@5; optional `floors.hit_at` override. Unexpected zero fails. Report Hit@1/3/5 and MRR.|
|identifier|Source-grounded equivalent mapping; Hit@1=100%, no review.|
|browse|Full candidate-window coverage ≥90%, precision ≥90%, no unexpected zero. Optional `floors.candidate_coverage` / `candidate_precision`. Report contamination and exhaustion.|
|browse_filter|Independent relevant set intersected with source-side filters/ranges/facets: recall=precision=1, FP=FN=invalid_filter_products=0.|
|filter_only|Every source match, exact set equality, no duplicates, no missing/extra, complete cursor traversal, alternate page size and stable order.|
|product reference|Batch order/duplicates and current IDs; active/inactive/missing distinct; Detail identity matches source.|

Coverage = relevant returned / all independent relevant products. Precision =
relevant returned / returned products. Empty source + empty result is correct;
nonempty source + empty result fails. Top10/20 remain diagnostics only.

For huge browse sets, a full keyword window means **more filtering required**.
The attainable coverage is `min(1000,N)/N` only when the window is exhausted and
N>1000; the coverage gate requires 90% of that attainable value, plus the same
precision floor. Raw full-set coverage and FN remain visible. Thus 1000 relevant
out of 2677 passes with `window_exhausted=true`; 80 relevant out of 84 returned
for an 80-product source set also passes. Exhaustion alone never fails browse.
Browse_filter still requires full equality: refine an overly broad fixture/UI
flow rather than waive missing results.

## Ten old browse failures: frontend operation rationale

These changes were authored from supported UI controls and source predicates,
not returned rankings. There is no application UI in this repository; the API
and `examples/shared-build.js` supply the consumer integration contract.

|Case|Before (free text / browse)|After|UX reason|
|---|---|---|---|
|p2-storage-990-2tb|990 pro 2tb|browse_filter: `990 pro`, capacity_gb=2000, manufacturer=Samsung|Model box + capacity/manufacturer selectors|
|p2-storage-sn850-2tb|sn850x 2tb|browse_filter: `sn850x`, capacity_gb=2000|Model box + total capacity selector|
|p2-storage-sn850-4tb|sn850x 4tb|browse_filter: `sn850x`, capacity_gb=4000|Same control, 4TB selection|
|p2-storage-990-1tb|990 pro 1tb|browse_filter: `990 pro`, capacity_gb=1000, manufacturer=Samsung|Same control, 1TB selection|
|p2-storage-sata1tb|sata 1tb|browse_filter: `sata`, capacity_gb=1000, nvme=0, storage_type=SSD|Capacity/device-type controls; retain SATA lexical requirement, since non-NVMe alone does not mean SATA|
|p2-board-b650e-wifi|b650e wifi|browse_filter: `wifi`, chipset=AMD B650E|Chipset selector exists; Wi-Fi facet does **not** exist in the current typed model, so Wi-Fi remains lexical|
|p2-case-meshify|meshify c|browse, unchanged lexical query|No typed Meshify C model control; do not invent a filter or broaden relevant products to hide contamination|
|p2-case-matx|micro atx case|filter_only: form_factor in Micro ATX Mini Tower / Micro ATX Mid Tower|Case category + chassis-format selector|
|p2-case-itx|mini itx case|filter_only: form_factor=Mini ITX Tower|Case category + chassis-format selector|
|p2-cooler-freezer360|liquid freezer 360|browse_filter: `liquid freezer`, water_cooled=1, radiator_size_mm=360|Family box + cooler-type/radiator controls|

## Pagination and performance

Keyword retrieval has a 1000-result UI window. Keyword-free evaluation traverses
the [cursor API semantics](pagination.md), with 50-row pages and an independent
37-row traversal. There is no filter-only window or deep OFFSET evaluation.

All seven performance intents report rows_read median/p95, SQL duration
median/p95, query count and catalog full scans. Search costs describe the first
51-row SQL operation (50 + lookahead); all-page costs/counts are separate.
Detail costs sum four queries. Resolve samples use 1/12/32/64 references, one
query each. EXPLAIN and source-audit queries are diagnostic overhead and excluded
from UI cost. Plans include first/seek search pages and detail/resolve queries.
Missing metadata is null and fails the gate, never converted to zero.

Before remote measurements, no catalog full scans, complete metadata and the
500,000 rows / 250ms **extreme per-operation safety ceiling** are required.
This is not a production latency SLO. Candidate sorting temp B-trees are reported.

Remote budgets are optional JSON keyed by the seven intents. Supported positive
numeric fields are `max_rows_read`, `max_sql_duration_ms`, `rows_read_p95`,
`sql_duration_ms_p95`, `max_query_count`. Unknown budget fields/intents fail.
No official remote budget has been set from local results.

```sh
npm run benchmark:ux
npm run release:verify -- --local
node scripts/report-ux.js
# Future, separately authorized read-only remote measurement:
npm run benchmark:ux -- --remote --output .cache/search-ux-remote.json
# After measuring/reviewing budgets:
npm run benchmark:ux -- --remote --budgets path/to/intent-budgets.json
```

Release uses the same budgets via `PERFORMANCE_BUDGET_FILE`.
`.cache/release-ux-report.json` is written before quality assertions, including
failures, source integrity and 45 representative plans. Local verification is
read-only after migrations and does not compile/deploy production configuration.
Benchmark success means measurement completed, not that release passed.
