# Golden search queries

`search-benchmark.json` is a manually selected set of user intents grounded in the
local catalog at BuildCores commit `eec0df175504ebd15f0f3e3a8249a18a22f00940`.
IDs and identifiers were checked against `products` / `identifiers` using the existing
DB adapter. Broad family queries list the relevant IDs observed in that snapshot;
expectations were **not** generated from search result rankings.

Examples with no spaces (`rtx5080`, `990pro`) and `gaming x trio 5080` deliberately
exercise user shorthand. The latter targets the existing MSI GAMING TRIO OC 5080;
it does not assert that an independently verified "Gaming X Trio 5080" SKU exists.

`upstream_ids` and `anyOf` are explicit acceptable-product sets: the first returned
member determines rank. Each single selector must resolve to at most one product.
Do not silently relax an ambiguous MPN/name expectation; review the conflicting
records and use explicit stable IDs. See README.md for fixture syntax and metrics.

Phase 2 keeps this legacy file byte-identical. `search-regression-labels.json` adds
class/precision metadata without overriding queries or expectations.
`search-phase2.json` contains 80 catalog-grounded additions: 52 development and 28
holdout cases, frozen before search implementation changes. The default benchmark
loads all 120 cases; `--suite` and `--class` select evaluations.
Explicit `{ "set": { "fields": { "spec.family": "Ryzen 7" } } }` selectors resolve
groups using evaluation-only typed predicates. An optional `acceptable` selector
defines Precision@5/10 with a fixed K denominator (missing slots count as nonrelevant).
See [the evaluation contract](../../docs/search-evaluation-phase2.md) for evidence,
scope, classes, limitations, and fixture hashes.

Contains information from [BuildCores OpenDB](https://github.com/buildcores/buildcores-open-db),
which is made available under the [ODC Attribution License](https://opendatacommons.org/licenses/by/1-0/).
Preserve [NOTICE.md](../../NOTICE.md) with this fixture when redistributing it.
