# Query-plan verification

`npm run verify:plans` runs 45 representative search requests through the shared
compiler, then records EXPLAIN QUERY PLAN, returned count and D1 metadata.
The categories, typed field definitions and declared indexes are owned by the
registry; tuning migrations add the measured compound indexes.

- Category FTS supplies lexical candidates. `SCAN <category>_fts VIRTUAL TABLE
  INDEX` is an FTS access path, not a catalog full scan.
- Candidate product/spec joins use their PKs. Identifier exact lookup uses
  `(value_key,type,product_id)` indexes on upstream and local tables.
- Facet-only selection uses the reverse `(attribute,value,product_id)` index;
  selective typed candidates probe the product_id-leading facet PK.
- Typed range/order queries use reviewed compound indexes. A residual range is
  not falsely described as a second independent index seek.
- Candidate GROUP BY / display ORDER BY may need temp B-trees. The UX report
  explicitly exposes them. Unexpected full scans of products/spec tables fail.

Product Detail separately tests 4 query plans for each of 30 categories: product
PK, typed spec PK, identifier product_id indexes, and facet product_id PK. Its
plans reject full scans of product/spec/identifier/facet tables.

`npm run verify:search:local` measures all intent cases, the representative plans
and Detail plans on a fixed 48,134-product local D1 snapshot. See
[validation results](category-search-validation.md) for costs and outcomes.
Synthetic node:sqlite tests check correctness but are not D1 read-cost estimates.
