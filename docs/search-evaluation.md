# UX search evaluation and release contract

The gate protects finding, filtering, selecting, saving and sharing products.
FTS/BM25 = candidate retrieval; display ordering = a separate concern.
Historical ranks and Top20 precision are not browse release floors.

## Independent source and optional diagnostics

The historical fixture-authoring BuildCores snapshot is
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

The 120 legacy + 102 extended + 14 frontend cases retain the five intents:
lookup, identifier, browse, browse_filter, filter_only. The frozen source files
are retained; `search-ux-overrides.json` supplies UX reclassifications and
declarative current-source rules. Family lookup is an explicit lookup subtype
(`intent: "lookup", class: "family"`), using the existing lookup performance
budget and reporting Hit@1/3/5 and MRR. A broad `class: "family"` query without
that explicit intent remains browse.

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
|exact / normal lookup|Specific product or source-grounded equivalent set: exact_model Hit@1, normal Hit@3, explicit fallback/typo Hit@5. `floors.hit_at` applies to normal/fallback lookup, never relaxes exact_model or identifier. Unexpected zero fails.|
|family lookup (`lookup` + `class: family`)|Required `equivalents.set` from source; keep Hit@3 and additionally require every top-three product to belong to the family, with three returned slots (or the complete family if fewer than three source members). Missing source family fails. No old-SKU rank floor or Hit@5 substitution.|
|identifier|Source-grounded equivalent mapping; Hit@1=100%, no review.|
|browse|Full candidate-window coverage ≥90%, precision ≥80%, no unexpected zero. Optional `floors.candidate_coverage` / `candidate_precision`. Report contamination and exhaustion.|
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

## Source-derived release truth and stale-fixture validation

The responsibilities are intentionally separate:

* `loadSearchFixture` loads the frozen historical benchmark/evidence. The legacy
  benchmark remains a historical ranking diagnostic, not the release oracle.
* `loadUXFixture` overlays `search-ux-overrides.json`, classifies intent and calls
  `prepareUXCase`. Browse and browse_filter must have a declarative `relevant.set`
  (an existing `acceptable.set` or `expected.set` can also supply it). Fixed
  `anyOf` / `upstream_ids` alone fail validation; they are never converted to a
  guessed query rule. Typed-spec/facet/range classes cannot bypass this by
  claiming lookup intent. Exact lookup may still use fixed IDs.
* `loadSnapshot` validates an immutable clean BuildCores checkout and normalizes
  its records. Release `searchGate` runs `sourceIntegrityGate` and filter metadata
  verification before evaluating search. The completed sync commit must match
  the supplied pinned snapshot; last-row-update provenance is not the pin.
* `sourceCatalog` uses DB data only to map source references to local IDs. Names,
  specs, facets and identifiers come from snapshot records. Missing DB products
  retain `missing:` IDs in the denominator. `selectExpectedSet` / `resolveExpected`
  apply evaluation-only predicates to these records, before retrieval.
* `evaluateUX` independently intersects semantic relevance with the actual
  `search.filters`, `search.ranges` and `search.facets`. Filter-only derives the
  **entire** matching source set without a lexical/ID selector. It rejects a
  query, identifier or relevance overlay that would contradict filter-only.
  Direct evaluator callers receive the same fixture validation as the loader.
* Reports retain historical `expected`, the effective `relevant`/`equivalents`
  rule, fixture hash, resolved relevant IDs and returned IDs. Diagnostics use
  these to show missing/extra source products and family top-three failures;
  returned IDs never generate expected membership.

The existing selector language is sufficient; no product-specific evaluator
branches, dynamic query parser or additional intent/budget namespace is needed:

```json
{
  "relevant": { "set": { "nameTokens": ["ASUS"] } },
  "search": { "filters": { "resolution_width": 2560, "resolution_height": 1440 } }
}
```

`nameTokens` is token-boundary AND, `nameContains` is substring AND, and
`nameAnyContains` is substring OR. All supplied predicates combine with AND.
`fields` selects normalized source fields, e.g. `product.manufacturer`,
`product.series`, `spec.chipset`; field arrays are OR. `identifier` selects exact
normalized code/type owners. Source-side typed filter/facet values retain SQL
equality semantics; ranges are inclusive and missing values do not match.

All formerly snapshot-fixed extended browse/browse_filter groups now have
authored rules, including keyboard, mouse, monitor, headphones and the smaller
extended categories. Original `anyOf` lists and authoring evidence stay frozen.
For the ASUS monitor and HyperX groups the original brand token rule is kept;
no manufacturer-field requirement is invented where the authoring rule used
the product name. Thus source enrichment naturally changes membership.

For `gpu-tuf5080` / `gpu-asus-tuf5080`, source equivalence is explicitly
`product.manufacturer = ASUS`, `spec.chipset = GeForce RTX 5080`, and the name
token `TUF`. OC/color/other derivative SKUs can qualify; other chipsets, series
and manufacturers cannot. Exact MPN searches still select only owners of that
MPN and require Hit@1. Family purity is stricter than merely finding one member
at rank 3: even one unrelated top-three result fails. Its diagnostic metrics are
`family_precision_at_3`, `family_top3_count` and `relevant_count`.

The browse precision documentation above corrects the previous 90% text to the
existing evaluator's 80%; this change does not lower the implemented floor.
Filtered equality now also explicitly fails on absent recall/precision/FP/FN
or invalid-filter metrics, instead of allowing incomplete reports to pass.

### Growth regression coverage and observed snapshot

`test/ux-source-growth.test.js` uses random source IDs absent from all frozen
lists. It syncs A→B with a new monitor, typed/facet/range enrichment, new family
derivatives and identifier enrichment. It proves the set grows, valid retrieval
passes, deleted FTS documents remain FN, injected semantic/filter violations
remain FP, source pin mismatch fails, and missing DB rows stay in the denominator.
It also exercises growing browse/filter-only sets, exact SKU Hit@1, and
MPN/EAN/UPC/JAN/GTIN owners/type isolation and Hit@1 despite unrelated results.
Existing tests retain full filter-only cursor traversal beyond 1000 rows,
source integrity, release pin/retry/resume, fail-closed artifacts, budgets and UI.

A separate local correctness replay of both the historical authoring snapshot
(48,134 products) and validated commit
`992dacfa9f516a5251fb01b70c9894bb23ad69d4` (48,288 products) passed all 236 UX
cases, source integrity, filter metadata and 45 representative query plans on
each snapshot:

|Case|Historical → current source set|Observed current correctness|
|---|---:|---|
|gpu-tuf5080|1 → 4|Family rank 1; top-three precision 1|
|gpu-asus-tuf5080|1 → 4|Family rank 1; top-three precision 1|
|ext-monitor-10|72 → 76|Recall=precision=1, FP=FN=0|
|ext-headphones-10|13 → 15|Recall=precision=1, FP=FN=0|
|ext-headphones-11|6 → 8|Recall=precision=1, FP=FN=0|
|ext-headphones-12|13 → 14|Recall=precision=1, FP=FN=0|

This replay used isolated in-memory SQLite, not production D1. Its artifact is
`.cache/ux-source-992dacfa9f516a5251fb01b70c9894bb23ad69d4/report.json`;
the report retains missing-D1-cost failures separately from correctness.
It is not a production performance or deploy authorization result.

Remaining limits: declarative rules still require semantic authoring. New naming
conventions, renamed series/chipsets or an upstream schema change may require a
rule/normalizer review. Validation detects absent dynamic rules, not every
misclassified SKU/family query. Source/filter predicate bugs remain possible,
which is why independent source checks and negative retrieval tests are kept.
Filtered sets exceeding the keyword window still fail rather than waiving recall.

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
