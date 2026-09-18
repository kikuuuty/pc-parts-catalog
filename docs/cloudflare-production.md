# Cloudflare D1 / Worker API

Category FTS generation 8, Product Detail, cursor pagination and batch reference
resolve are **live and production-verified as of 2026-09-18**. See the
[transition report/runbook](production-transition.md) for the current database,
Worker version, recovery and measured intent budgets. Historical measurements are in `production-*-baseline.md`,
`production-cache.md` and `production-rate-limiting.md`; they are not current
quality floors. See [release gates](catalog-release.md) before production changes.

## Binding and authentication

- `wrangler.json` root `DB` is the production account/database source of truth.
- `env.local` is a separate persisted local database. Use `--local --env local`
  for development; local operations require no Cloudflare credentials.
- The Worker uses `env.DB`, not an API token. Management commands use the D1 REST
  API with `CLOUDFLARE_API_TOKEN`, or captured Wrangler OAuth when absent.
- Explicit account/database environment overrides are supported by management
  CLI; release rejects mismatches against the production binding.
- Secrets, `.cache`, `.wrangler`, `.dev.vars` and `.env` are not tracked.
- `nodejs_compat` supports shared query/normalization imports. The Worker bundle
  does not import sync, CLI, Wrangler or administrative REST credentials.

## Local operation

```sh
npm run db:migrate
npm run sync
npm run worker:dev
npm run verify:worker:local
```

The bounded HTTP verifier reuses a healthy existing localhost:8787 server, or
starts and stops only its own process tree. It compares the intent suite's HTTP
results against current direct SQL and tests all-category Detail contracts.
HTTP/direct order equality checks compiler/transport parity, not historical
expected-product rank equality.

`verify:search:local` uses an isolated local snapshot clone for D1 migration,
integrity, quality, Detail/cache, plans and storage measurements. See
[local validation](category-search-validation.md).

## API v1

### Frontend integration quick reference

Production origin is **`https://pc-parts-catalog.kikuuuty.workers.dev`**.
All endpoints below are available now, with public CORS and no client credential.

|Request|Contract|
|---|---|
|GET `/v1/health`|`{ok:true,database:"available"}`|
|GET `/v1/categories`|`{categories:[...]}` from the 30-category registry|
|GET `/v1/search`|category required; q/limit/offset/cursor optional|
|POST `/v1/search`|JSON category, keyword, filters, ranges, facets, identifier, orderBy, limit, offset, cursor, include|
|GET `/v1/products/:id`|[Product Detail](product-detail.md): identifiers, typed spec, facets|
|POST `/v1/products/resolve`|[Stable refs](product-reference.md): 1–64 products → current IDs and active/inactive/missing|

Search returns `{data:[...],meta:{limit,offset,returned,has_more,next_offset,next_cursor,
window_limit,window_exhausted,source}}`. Data includes current runtime numeric `id`,
`source`, `upstream_key`, `upstream_id`, category/name/manufacturer/series/variant,
release_year/manufacturer_url and `specs`. Unknown fields are null.
UUID alone is not a cross-category identity. Use the search `id` for Detail.
For shared URLs/saved builds/exports use `source + upstream_key` as the durable
reference, then batch resolve before requesting Detail/price data.

Normal search does not load identifiers. POST can request
`include:["identifiers","facets"]`; its existing expansion remains compatible.
For grouped canonical identifiers after selection, use Detail and let the price
Provider decide MPN/EAN/UPC/name priority.

### Filters, ordering and pagination

- Scalar selections: OR within field, AND between fields; values must match the
  registry's TEXT/number type. Ranges are inclusive. Facets preserve multi-values.
- Explicit filters are strict. Words such as `32gb` parsed from a keyword are
  soft spec hints and do not assert that every result has that capacity.
- Keyword-free default is manufacturer → series NULLS LAST → name → id ASC
  (NOCASE text). Explicit allowlisted `orderBy` prepends that field, NULLS LAST.
  Keyword always uses relevance first, then the default display tuple.
- Default limit 20, max 50. Keyword window 1,000; keyword-free filter/list uses
  cursor/keyset with no total window. Nonzero keyword-free OFFSET returns 400.
- Use `meta.next_cursor` for keyword-free pages, `next_offset` for keyword pages.
  `returned` is not total hits. Cursor permits changed page size, requires the
  same category/filter/order/epoch and safely rejects invalid context with 400.
  At the explicit window boundary `has_more` can be true with null next_offset.
- GET supports category/q/limit/offset/cursor. Use POST for advanced filters/sort.
  See [cursor format and consistency](pagination.md).

### Input and errors

Body limit 16KiB, JSON content type required. Keywords are ≤200 characters and
1–12 letter/number tokens. Unknown/repeated parameters and unknown fields are
400. D1 parameter/selection/range complexity is validated before execution.
404 means unknown endpoint or unknown/inactive Detail product; 405 wrong method;
413 body too large; 415 content type; 429 resource admission; 503 transient D1;
500 internal/permanent database failure. Errors carry a request ID and never SQL,
stack, credentials, or request search terms.

Debounce input, abort stale requests, respect Retry-After on 429/503, and use
bounded backoff with jitter. Empty 200 results are normal, not a retry condition.

### Cache, protection, telemetry and attribution

Public read-only CORS `*`, no credentials. OPTIONS supports content-type.
Browser search/Detail responses remain `no-store`.
GET search's first six standard pages use Cache API TTL 60/300/600 (default 300).
Detail has its own namespace and 600s TTL. Epoch invalidates both; HIT executes
no D1 query. POST search bypasses cache. Cache failures use the normal protected
DB path; 404 and errors are not cached.
Cursor requests and batch resolve bypass edge cache. The keyword-free first
GET page can still cache. Search and Detail namespace generation is v3.

Existing rate/refill protection runs after HIT detection and before D1. No public
bypass/header is introduced. `X-Cache`, `X-Cache-TTL`, `Age`, `Server-Timing`,
`Retry-After` and fresh `X-Request-ID` are CORS-exposed observability headers.
Telemetry records bounded routes/categories, cost class, cache/rate status,
D1 query count/read/write/duration and elapsed time, never user keywords or IDs.

Display `meta.source` attribution from search in the frontend. Preserve
[NOTICE](../NOTICE.md) and upstream ODC-By 1.0 provenance when redistributing.

## Production release and resume

Production migration is manually reviewed and separately applied; release checks
the exact migration history before sync/deploy. The new Worker cannot run on a
pre-0009 database. Coordinate migration and Worker activation because the
previous Worker references removed indexes. No automatic backward-compatible
routing or destructive rollback is provided.

Use the existing release pipeline for complete sync → intent gates → epoch →
deploy → API smoke. Partial/failed sync resumes the same immutable snapshot by
hash under the existing lease. Wait for lease expiry after an interrupted writer.
Local measurements are not remote billed-cost guarantees; validate actual remote
D1 limits/budgets during the separately authorized production phase.
