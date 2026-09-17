# Golden fixture assets

`search-benchmark.json` (40), `search-regression-labels.json` and
`search-phase2.json` (80) preserve the original 120 source-grounded cases.
`search-extended.json` preserves 102 cases for the other 21 categories.
`search-extended-evidence.json` preserves their source paths, identifiers,
specs/facets and independent relevant sets. The source commit is
`eec0df175504ebd15f0f3e3a8249a18a22f00940`.

`loadUXFixture()` reclassifies these into lookup, identifier, browse and
browse_filter. `search-ux-overrides.json` records the ten frontend-operation
reclassifications while preserving frozen source assets. `search-ux.json` adds 11
frontend cases, including MAG → ATX → AMD B850, OLED/size/resolution, filter-only
DDR5/32GB, and an intentional empty filter result.

Relevant sets are resolved from source data, never search order. Lookup may use
explicit equivalent SKU sets; browse uses relevant sets, not a single expected
rank. Rank movement within a relevant browse set is not a regression.
All intents, including 111 lookup cases, are machine evaluated. Human checking
is optional; `search-reviews.json` is a legacy artifact and is not read by the
fixture loader or release gate. Per-case hashes identify fixture revisions,
not required approvals. For ad-hoc inspection use `npm run diagnose:search`.
`scripts/prepare-extended-golden.js` checks source evidence and refuses to
overwrite frozen fixtures. Expected IDs must not be auto-adjusted to rankings.

See [the evaluation contract](../../docs/search-evaluation.md) for denominators,
metrics, floors, pagination and review policy.

Contains information from [BuildCores OpenDB](https://github.com/buildcores/buildcores-open-db),
made available under [ODC-By 1.0](https://opendatacommons.org/licenses/by/1-0/).
Preserve [NOTICE.md](../../NOTICE.md) when redistributing fixtures.
