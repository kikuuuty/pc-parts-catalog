# Stable display ordering and cursor pagination

FTS/BM25 retrieves candidates. Display ordering is a separate explicit contract.
All searches remain category-specific and active-only.

## Ordering

- Keyword-free default: manufacturer → series NULL state → series → name → id,
  ascending. Text uses SQLite NOCASE (ASCII case-insensitive; not locale-aware
  Unicode/numeric-natural sorting). NULL manufacturer/name compares as `''`.
- Series: empty string is a value and sorts before other strings; SQL NULL sorts
  last **within each manufacturer**. The pinned 48,134-product snapshot has
  16,349 NULL series, zero empty series and 58 NULL manufacturers. Tests also
  cover stored empty series and case-only ties.
- Keyword: relevance DESC → manufacturer → series NULL state → series → name →
  id ASC. Existing `orderBy` values are validated but cannot override relevance.
- Keyword-free explicit allowlisted `orderBy`: selected field ASC NULLS LAST,
  then the complete default display tuple. Cursor context includes this field.

`0009_display_order.sql` adds a category/active/expression-order index. Existing
typed indexes retrieve filtered candidates before stable display sorting;
bounded candidate temp sorting is allowed. Migration 0001–0008 is unchanged.

## Request and response

Keyword-free first page:

```json
{"category":"memory","filters":{"ram_type":"DDR5","capacity_gb":32},"limit":20}
```

Send the same conditions with `cursor: meta.next_cursor` for the next page.
GET accepts `category`, `limit`, `cursor`; use POST for filters. Existing search
`data` / `meta` wrapper remains. Example metadata:

```json
{"limit":20,"offset":0,"returned":20,"has_more":true,"next_cursor":"opaque-token","next_offset":null,"window_limit":null,"window_exhausted":false}
```

`source` attribution also remains in meta. Limit defaults to 20, maximum 50;
changing page size between pages is supported. An omitted cursor starts again.
Use `has_more` and `next_cursor`, not page numbers; final page has a null cursor.
Keyword-free nonzero OFFSET is HTTP 400. There is no total-result window.

Keyword search keeps bounded OFFSET pagination, `offset + limit <= 1000` and
`meta.next_offset`. At an uneven page boundary reduce limit to the remaining
window. `has_more=true`, `next_offset=null`, `window_exhausted=true` means more
filtering is required, not another page. `next_cursor` is null for keywords.
`returned` is page size, not a total count.

## Opaque cursor v1

Base64url UTF-8 JSON envelope contains a payload and SHA-256 corruption checksum.
Payload contains version, category, order (`display-v1` or an allowlisted field),
filter fingerprint, catalog epoch and last sort tuple:

```text
[manufacturer, series-is-null (0/1), series, name, id]
```

Explicit sort prepends `[field-is-null, field-value]`. The compiler supplies the
tuple directly to avoid product/spec column-name collisions. Canonical filter
fingerprints include filters/ranges/facets/identifier and normalize object-key
and selection-array order. Page size and include expansions are excluded.

Malformed encoding/JSON, corrupted checksum, unsupported version, mismatched
category/filter/order/epoch, invalid lengths/types/NULL state/unsafe ID or
control characters return generic HTTP 400 before SQL. All tuple values are SQL
parameters; no client table/column names are accepted. The checksum is **not a
signature or authorization mechanism**: this is a public read-only position
token, not a permission. Do not store it as product identity.

Epoch is `CATALOG_CACHE_EPOCH`; without it, local/dev cursors use `unversioned`
and cannot detect a catalog refresh. Production configuration already requires
an epoch. A changed epoch invalidates the cursor; restart from the first page.
Within an unchanged catalog, replay returns the same page. Inactivation (even of
the anchor product) does not shift the boundary or duplicate previous results;
inactive rows disappear. This is not snapshot isolation during concurrent sync:
renames/inserts can change traversal. Restart after catalog publication/epoch
rotation. No production epoch was changed by this implementation.

Cursor requests bypass edge cache; keyword-free first GET page can still cache.
POST and all browser responses remain no-store. Schema namespace is v3.
