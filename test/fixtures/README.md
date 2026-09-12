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

Contains information from [BuildCores OpenDB](https://github.com/buildcores/buildcores-open-db),
which is made available under the [ODC Attribution License](https://opendatacommons.org/licenses/by/1-0/).
Preserve [NOTICE.md](../../NOTICE.md) with this fixture when redistributing it.
