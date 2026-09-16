# Broad-query retrieval and cost

The production query compiler deduplicates narrow hit IDs, fetches each candidate
product/spec by PK, applies scope, and carries projected columns into ranking.
Repeated MATCH tiers are folded when their expressions are identical. Public
ordering avoids the debug-only ranked spool; diagnostic scores remain available.
Category-specific FTS restricts BM25 statistics and lexical reads to the selected
category. Local identifier hits are unscored and filtered by category/active state.

Broad keywords are evaluated as candidate sets. The frontend should narrow them
with typed filters/ranges/facets, then choose a stable display order. Free-text
spec hints are soft, whereas explicit filters prohibit out-of-filter products.

Retained tools include `scripts/lib/broad-workload.js`, query-plan inspection,
cache/refill measurements, `corpus-statistics.js` (DF, average document length,
shadow/schema counts and storage), and `bm25-explanation.js` (weighted term and
length contributions). `verify-search-local.js` records first-page rows_read,
SQL duration, all-page cost, plans and temp B-trees on local D1.

The frozen pre-optimization SQL oracle and shared-vs-category corpus comparison
drivers have been removed. The current [UX evaluator](search-evaluation.md),
source predicates and independent behavioral tests determine correctness.
Historical cache/rate measurements are historical operational observations, not
quality floors for this generation.
