# Product Detail cleanup — 2026-09-19 JST

## Change and metric contract

Before: `product → spec → identifiers → facets`, four sequential indexed D1
binding calls. After: `product → batch(spec, identifiers, facets)`, two calls.
D1 executes the three batch statements in order in one operation; this does not
claim parallel SQL execution inside D1. Only independent reads are grouped.

The Worker supplies the batch callback to `loadProductDetail`. Query-only CLI
and local diagnostic adapters retain their existing interfaces and use parallel
reads. `src/database.js`, SQL text, category FTS, response fields, identifier
canonicalization/provenance and search behavior are unchanged.

|Successful request|Before SQL statements / D1 operations|After SQL statements / D1 operations|
|---|---:|---:|
|Detail MISS|4 / 4|4 / 2|
|Detail HIT|0 / 0|0 / 0|
|Missing/inactive, uncached|1 / 1|1 / 1|

- Existing `d1_queries` and performance-gate `query_count` count SQL statements,
  including all three batch statements. `max_query_count=4` remains unchanged.
- Additive runtime `d1_operations` counts binding calls, representing remote
  round trips at the Worker/D1 boundary. It does not count provider-internal
  retries. Before values are inferred from the verified one-`.all()`-per-query
  baseline; after values come from the Worker event.
- `rows_read`, `rows_written` and `sql_duration_ms` sum the product result and
  all three batch result metadata objects. `Server-Timing` uses the same sum.
  Missing metadata stays unknown; failed batches cannot produce a cached partial
  response. HIT SQL duration stays `null` (no SQL executed), not a measured zero.
- Direct-D1 release diagnostics still measure four statements independently.
  Their query count is not a measurement of the Worker's two binding calls.

## Measurement method

Measured 2026-09-18 14:50–15:01 UTC (2026-09-19 JST). Each run contains **six
Cold MISS + six Warm HIT** requests: one pair per product, paced by 3.5 seconds.
Elapsed HTTP includes the response body and excludes pacing and log collection.
All observed edge colos were NRT. Cold means application-cache MISS, not a claim
of Worker isolate cold start or cold D1 storage.

The user selected **read-only remote preview**, because normal production release
acquires a D1 write lease. No production deploy or D1 write was performed.
Both comparison Workers ran on Cloudflare using `wrangler dev --remote`, with
the same production D1, epoch and TTL. Distinct temporary preview script names
(`pc-parts-catalog-detail-before` / `pc-parts-catalog-detail-after`) isolate their
cache namespaces; limiter namespaces are separate from production. The client
accessed them through Wrangler's loopback forwarding proxy. This is remote
Worker + remote D1 HTTP, not local D1 latency; preview routing/forwarding overhead
means it is **not interchangeable with production HTTP**.

Before preview used the unmodified `b08c5b416cfdd48fc36a13c0a288e39abbe943b9`
Worker/Detail implementation; after used this cleanup. Full response objects
were compared: production before = preview before = preview after, including
all arrays, provenance and null fields. Contract differences: **zero**.

Percentiles use the existing diagnostic nearest-rank convention (`p50` is
reported as median). With n=6, p95 equals the largest sample. These are **small
diagnostic measurements, not SLOs or an estimate of production improvement**.

## Remote preview before / after

|Metric|Before|After|
|---|---:|---:|
|Cold HTTP median, ms|666.16|335.92|
|Cold HTTP p95, ms|838.21|434.13|
|Warm HIT HTTP median, ms|32.23|40.82|
|Warm HIT HTTP p95, ms|44.06|52.53|
|Cold D1 SQL duration median, ms|1.0821|2.9885|
|Cold D1 SQL duration p95, ms|1.4632|5.7167|
|Cold rows_read median / p95|21 / 165|21 / 165|
|Cold D1 operations per request|4|2|
|Cold SQL statements per request|4|4|
|Warm rows_read / operations / statements|0 / 0 / 0|0 / 0 / 0|

Cold p50 decreased about 49.6% on this preview path. SQL duration and Warm HIT
latency did not improve in this sample. The structural improvement is removing
two serial network waits; no additional optimization was attempted.

### Individual cold samples

|Product (ID)|HTTP ms before → after|SQL ms before → after|rows_read before → after|Coverage|
|---|---:|---:|---:|---|
|AMD Ryzen 7 9800X3D (372)|801.67 → 369.87|1.4498 → 4.1449|31 → 31|9 canonical identifiers, 16 spec fields|
|MSI MAG B850 TOMAHAWK WIFI (6166)|567.03 → 413.80|1.0821 → 1.7765|11 → 11|Motherboard spec|
|Samsung 990 Pro 2TB (13496)|666.16 → 329.49|1.0520 → 3.5074|15 → 15|Storage spec|
|Dell MS116 Wired Optical Mouse (46427)|697.90 → 246.01|1.4244 → 2.9885|165 → 165|78 canonical identifiers|
|MSI MPG CORELIQUID K240 (27988)|838.21 → 434.13|1.4632 → 5.7167|37 → 37|23 facets|
|AMD Ryzen Threadripper 9980X (1)|638.02 → 335.92|0.9435 → 1.3790|21 → 21|16 spec fields|

### Production baseline, separately measured

The deployed Worker remains `d644b54a-e35e-4389-a979-b0272b4a0905`, release
`release-b9b54959cbe94b1e22266c4502afd2ce`. Production after is **not measured**.

|Metric|Production before|
|---|---:|
|Cold HTTP median / p95, ms|486.50 / 553.72|
|Warm HIT HTTP median / p95, ms|28.08 / 32.73|
|Cold SQL duration median / p95, ms|2.3049 / 5.5826|
|Cold rows_read median / p95|21 / 165|
|Cold D1 operations / SQL statements|4 / 4|

Management reads before/after each run confirmed unchanged live Worker, binding,
epoch and completed sync `dc3cb03f-3361-4bb4-a5c6-3584260cdb79`. All measured
requests reported `rows_written=0`. No migration, sync, lease acquisition, epoch
rotation, index change or persistent diagnostic Worker deployment was performed.
Preview processes were stopped and temporary configs removed.

## Correctness and verification

- `npm run check`: schema check + **177/177 tests PASS** (175 existing + 2 new).
- Product Detail's six test cases cover all 30 categories, complete response
  equality, typed spec, facets, identifiers, canonical grouping and local/source
  provenance, durable source/upstream_key, missing/inactive, cache key, 600-second
  TTL, expiry, epoch invalidation, MISS/HIT, query plans and batch errors/metadata.
- Real local D1 binding: **30 categories, 30 MISS + 30 HIT, 120 plans PASS**;
  full response equals query-only loading, four statements/two operations per
  MISS, zero writes and zero catalog/identifier/facet full scans.
- Remote read-only plan checks: **24/24 indexed plans PASS**, including the
  high-identifier product; zero catalog/identifier/facet full scans.
- Remote preview before/after: **12/12 successful HTTP requests each**,
  six MISS → HIT pairs each, TTL 600, complete response equality.
- `node scripts/finalize-transition.js`: PASS, publication status is published.
  The script verifies the recorded promotion version/tag and live vars/binding;
  its reused migration HTTP/gate evidence is historical, not an after benchmark.

The cache key remains
`<origin>/__catalog_cache/product/v3/<id>?epoch=<epoch>&ttl=600`.
Missing/inactive requests issue only the product read and do not cache 404s.

## Publication documentation

GitHub's `main` commit was read back as
`b08c5b416cfdd48fc36a13c0a288e39abbe943b9`. Updated:

- `README.md`
- `docs/production-transition.md`
- `docs/catalog-release.md`
- `scripts/finalize-transition.js`

These now state that promotion is published, the repository binding matches
promoted D1, and scheduled/manual releases can use FTS8 through existing gates.
Repository-wide obsolete publication wording was searched. The transition-only
UUID mismatch/fail-closed explanation remains explicitly in the past tense;
original promotion Worker IDs, SQL/HTTP measurements and recovery evidence remain.

## Budgets and remaining limitations

**No performance budget changed**, including `product_detail.max_query_count=4`.
The identifier-heavy Dell diagnostic sample reads 165 rows both before and after,
above the existing detail `max_rows_read=60` and six-sample p95 budget of 50.
It is outside the fixed 30-category release sample. This exposes existing fixture
coverage/budget limitations, not additional reads introduced by batching; this
diagnostic run must not be described as passing those row budgets.

Sparse/conflicting upstream identifiers and the lack of a safe production
inactive fixture remain. Inactive behavior is verified locally. Production still
runs the serial implementation until the normal release path publishes this
cleanup; production-after latency and general-population p95 are unverified.

## Reproduction and artifacts

The measurement script runs the **current checkout**; `--phase` labels the
measurement and does not check out old code. Capture before with the baseline
implementation, and after only once local correctness has passed. Repeat a phase
only after its 600-second TTL has expired; a non-MISS cold sample fails explicitly.
Keep the source snapshot aligned with the production completed sync.

```sh
node scripts/measure-product-detail.js --target production --phase before
node scripts/measure-product-detail.js --target preview --phase before --compare .cache/detail-production-before.json
# Apply cleanup and run npm run check, then:
node scripts/measure-product-detail.js --target preview --phase after --compare .cache/detail-preview-before.json
```

Private raw evidence remains in `.cache/detail-production-before.json`,
`.cache/detail-preview-before.json`, `.cache/detail-preview-after.json`,
`.cache/detail-preview-{before,after}.log`, `.cache/detail-local-batch.json`,
`.cache/detail-remote-plans.json`, and `.cache/transition-final.json`. Local and
remote plan-check drivers used for this run are also retained under `.cache/`.
