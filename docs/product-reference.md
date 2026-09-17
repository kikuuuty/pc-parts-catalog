# Stable Product Reference and saved/shared builds

```text
id = current DB/runtime API lookup ID
source + upstream_key = durable/shared reference
```

`UNIQUE(source, upstream_key)` is the identity basis. A UUID alone is not unique
across categories; numeric IDs can differ after a fresh catalog import. Search
and Product Detail always expose `id`, `source`, `upstream_key` (and upstream_id).
Persist the pair for shared URLs, saved builds, favorites, localStorage and
export/import:

```json
{"source":"buildcores","upstream_key":"Motherboard/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"}
```

## Resolve in one request

`POST /v1/products/resolve`, application/json:

```json
{"products":[{"source":"buildcores","upstream_key":"CPU/00000000-0000-4000-8000-000000000001"}]}
```

Response preserves request order **and duplicate input slots**:

```json
{"products":[{"source":"buildcores","upstream_key":"CPU/00000000-0000-4000-8000-000000000001","id":123,"category":"cpu","name":"Example CPU","active":true,"status":"active"}]}
```

|Status|Fields / frontend behavior|
|---|---|
|active|Current id/category/name, active=true; load Detail and then price data|
|inactive|Existing id/category/name, active=false; show “この製品は現在カタログ非掲載です”|
|missing|id/category/name/active=null; preserve source/upstream_key and ask the user to replace the unavailable reference|

Unknown syntactically valid sources return per-item missing. Missing and inactive
never silently select an equivalent/current SKU. Source deletion or upstream key
replacement is not automatically aliased.

The batch bound is **1–64 references**, with the existing 16KiB request limit.
Each reference has exactly source and upstream_key. Source is a lowercase ASCII
slug (1–64 chars); upstream_key is a bounded `Category/key` path (≤200 chars),
without traversal, SQL identifier interpretation or extra fields. Invalid shape
or batch size is 400. Query parameters are rejected; OPTIONS/CORS are supported.

One JSON bind + SQLite `json_each` + indexed LEFT JOIN uses the existing unique
source/key index, safely below D1's 100-parameter limit. No per-product HTTP or
SQL loop. The resolver deliberately includes inactive products. Detail remains
active-only and returns 404 for inactive/missing runtime IDs.

Resolver responses are uncached (`X-Cache: BYPASS`, `Cache-Control: no-store`) and
use existing POST resource protection. Repeating a resolution observes the
current catalog. No new cache invalidation protocol is needed.

## Frontend flow and example adapter

```text
shared URL / saved build
→ stable refs
→ POST /v1/products/resolve
→ current product IDs/status
→ Product Detail / identifiers / price lookup
```

`examples/shared-build.js` is a browser-ready adapter: `serializeBuild`,
`parseBuild`, `buildURL`, `referencesFromURL`, `restoreBuild`. The versioned
saved document stores only refs, never IDs, and uses URL-fragment encoding.
For localStorage use `setItem(key, serializeBuild(selectedProducts))`, then
`restoreBuild(apiOrigin, parseBuild(getItem(key)))`. Keep slot positions and
inactive/missing statuses visible; do not discard them when restoring a build.

Tests cover a separate fresh DB assigning a different numeric ID to the same
reference, mixed categories, duplicates, active/inactive/missing, unknown source,
input bounds and shared URL round-trip with a single HTTP restoration request.
