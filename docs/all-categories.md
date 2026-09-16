# All 30 categories

The authoritative inventory is `src/model.js` plus `src/extended-models.js`.
`GET /v1/categories` returns this inventory. Each category owns a typed spec
table and its own FTS. The complete routing list is in
[category search architecture](category-search.md).

The fixed BuildCores commit `eec0df175504ebd15f0f3e3a8249a18a22f00940`
contains 48,134 products. `categoryCoverage` checks upstream directories and
schemas against the registry; unknown and schema-only categories are failures.
Full source JSON is preserved in `upstream_raw`; identifiers and facets have
independent relational projections. Unknown specs remain null.

`npm run verify:catalog` checks category counts, raw/spec values, source identifier
counts, FKs, and no-change sync. `npm run verify:search:local` additionally checks
exact identifiers/facets against the source snapshot, category FTS integrity,
intent-quality, Detail plans and storage on an isolated local upgrade clone.

Typed field/index/facet definitions are in the registry and tested for all
categories. Notable frontend fields include:

- motherboard: `form_factor`, `chipset`, `socket`, `ram_type`.
- memory: `ram_type`, `capacity_gb`, `speed`, `cas_latency`.
- monitor: `screen_size_inches`, `resolution_width`, `resolution_height`,
  `refresh_rate_hz`, connection facets.
- keyboard: `size`, `switch_type`, `polling_rate_hz`, connectivity facets.
- mouse: `shape`, `weight_g`, connectivity facets.

`POST /v1/search` can opt into identifiers/facets. After selection, use
[Product Detail](product-detail.md) for canonical identifier groups and typed
specs. Category-specific FTS does not change normalizer version or source keys.

The expanded category architecture has not been deployed to production in this
phase. See [validation results and remaining gates](category-search-validation.md).
