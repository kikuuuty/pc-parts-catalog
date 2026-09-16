# UX search evaluation contract

The evaluation question is whether users can retrieve a relevant candidate set,
apply typed filters, and select a product. It is not whether a broad query's
previously expected SKU moved from rank 4 to rank 6.

## Fixture provenance

`loadSearchFixture` retains the frozen legacy 40 + Phase-2 80 input cases.
`loadUXFixture` reuses all 120 plus extended 102, adding 11 UI cases. It maps
class + request shape to lookup / identifier / browse / browse_filter /
filter_only. A fixture may explicitly supply `intent`.

- lookup uses expected IDs/selectors, optionally an explicit `equivalents` set.
- identifier uses expected/equivalent SKU IDs and requires Hit@1.
- browse uses existing source-grounded acceptable/set selectors, or source name
  token conjunctions for the three previously unlabeled family cases.
- browse_filter intersects that independent relevant set with typed filters,
  ranges and facets evaluated on source records.
- filter_only selects every source product satisfying those conditions.

The pinned source is BuildCores
`eec0df175504ebd15f0f3e3a8249a18a22f00940` (48,134 records). Source normalization
and ID mapping happen before search. A missing source product is never removed
from the relevant denominator merely because the candidate DB omitted it.
No expected selector is generated from result order. The original files and
extended source evidence remain unchanged. All extended judgments remain pending
human review and block release; measurement is still reported.

Human decisions are recorded in `test/fixtures/search-reviews.json`, keyed by
case ID, with `status: "reviewed"`, `reviewer`, `rationale` and the frozen
extended `fixture_sha256`. The loader rejects unknown IDs, incomplete decisions
or stale hashes. This overlay changes review status only, never query/expected.
It is empty in this change; no human decision is fabricated.

## Metrics

|Intent|Primary metrics / gate|
|---|---|
|lookup|Hit@1/3/5, MRR; exact-model Hit@1, other lookup Hit@3; explicitly classified typo fallback Hit@5|
|identifier|Hit@1=100%, explicit equivalent SKU set if necessary|
|browse|Recall@10/20, Precision@10/20, relevant coverage, zero-result rate, FP/FN contamination|
|browse_filter|full-window Recall/Precision, FP=FN=0, filter correctness, no out-of-filter products|
|filter_only|exact set equality, distinct IDs, alternate-page-size traversal, stable repeated first page|

Recall@K = relevant returned in first K / complete source relevant count.
Precision@K = relevant returned / returned slots up to K. Short but completely
relevant lists therefore score 1, rather than being penalized for empty slots.
Empty source and empty results have set precision/recall=1; unexpected empty
results score zero. Zero-result rate is also reported separately, including
intentional negative cases.

For N>20, Recall@20 cannot exceed 20/N. The default browse gate requires at least
90% of attainable Recall@20 (`0.9 * min(20,N)/N`) and Precision@20 ≥0.9.
Both raw recall and relevant count remain visible. This is not a claim of 90%
complete-catalog coverage. Candidate coverage is measured over the actual UI
window: keyword=1,000, filter-only=100,000. Window exhaustion is explicit.

Ranking-sensitive metrics are null for browse/filter intents. Broad expected
rank is never a release gate. Metrics are macro-averaged within each intent;
FP/FN and filter violations are also reported as counts.

All queries record the generated SQL's plan, catalog full scan and temp B-tree
visibility. First UI page (50 rows) records local D1 rows_read and SQL duration;
median/p95 are across cases. All-page costs are separate. Missing D1 metadata is
null, never a synthetic zero. node:sqlite test adapters do not establish D1 cost.
The conservative default per-case budgets are 500,000 rows and 250ms SQL;
reviewed fixtures may set tighter limits. Temp B-trees over retrieved candidates
are visible and allowed; unexpected catalog scans fail.

## Commands and gates

`npm run benchmark:search` measures the intent suite; `--category`, `--suite`,
`--class` select subsets. Custom fixtures must supply appropriate relevant sets.
`npm run release:verify -- --local` invokes the same evaluator and fails closed
on review debt, quality or performance violations. No saved historical rank or
FTS fingerprint is a release floor.

The original low-level benchmark module remains a ranking diagnostic/selector
framework for existing diagnostic callers; it is not the production release
quality model. BM25 explanations, corpus DF/document lengths, query plans,
rows_read, SQL timing, storage, source fingerprints and sync cost remain useful
diagnostics. Category-vs-shared-corpus adapters and artifacts were removed.
