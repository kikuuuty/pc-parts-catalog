# Canonical FTS projection consistency

`product_search_projection` supplies persisted name/manufacturer/series/variant
and CPU family+generation / GPU chipset+chip_series. Other family fields remain
empty. Normalized `text` is stored in `product_search_documents`, including the
existing upstream identifier order and searchable source fields.

Migration 0008 uses the same projection for active-product backfill and future
category document triggers. Typed specs exist before the staging hook writes the
document. Reactivation uses the durable text, so it does not require reconstructing
the original JSON normalization inside SQLite.

`ftsIntegrity` audits every category for missing/duplicate/wrong/inactive orphan
rows and canonical projection drift. `captureProjection` / `compareProjection`
remain diagnostics for source invariance, no-op sync, and field/score differences.
Exact historical FTS fingerprints and rank equality are not release gates.

```sh
node scripts/compare-fts-projection.js snapshot --search --output .cache/projection.json
npm run verify:search:local
```

See [architecture](category-search.md), [evaluation](search-evaluation.md) and
[local validation](category-search-validation.md). Applied historical migrations
remain immutable and are exercised as upgrade inputs in tests.
