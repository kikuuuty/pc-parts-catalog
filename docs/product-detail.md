# Product Detail / Identifier API

`GET /v1/products/:id` is the formal boundary between frontend product selection
and a price Provider's lookup strategy. Use the numeric `id` returned by search.
The response is a product object (not a search page wrapper).

Illustrative response; identifier values below are examples, not verified codes:

```json
{
  "id": 12345,
  "upstream_id": "00000000-0000-4000-8000-000000000001",
  "upstream_key": "Motherboard/00000000-0000-4000-8000-000000000001",
  "category": "motherboard",
  "manufacturer": "MSI",
  "name": "MSI MAG B850 TOMAHAWK MAX WIFI",
  "series": "MAG",
  "variant": null,
  "release_year": null,
  "manufacturer_url": null,
  "identifiers": [
    {
      "type": "mpn", "value": "EXAMPLE-MPN", "region": "all",
      "origin": "upstream", "origin_field": "identifiers",
      "origins": [
        {"origin": "upstream", "origin_field": "identifiers"},
        {"origin": "upstream", "origin_field": "metadata.part_numbers"}
      ]
    },
    {
      "type": "ean", "value": "0012345678901", "region": "all",
      "origin": "upstream", "origin_field": "identifiers",
      "origins": [{"origin": "upstream", "origin_field": "identifiers"}]
    }
  ],
  "spec": {"socket": "AM5", "chipset": "AMD B850", "form_factor": "ATX"},
  "facets": []
}
```

`spec` actually includes every field defined by that category's typed model;
unknown fields have null values. The example abbreviates that object.
`facets` is an array of `{attribute,value}`; absence gives `[]`.
`identifiers` also gives `[]` when the product has no identifiers.
Unknown/inactive IDs return 404 (`PRODUCT_NOT_FOUND`), malformed paths return 404,
unsafe numeric IDs return 400, unsupported methods return 405. OPTIONS supports
the existing public CORS contract. Query parameters are rejected.

## Identifiers and provenance

Supported canonical types are `mpn`, `upc`, `ean`, `gtin`, `jan` (JAN may be local).
Values are strings: leading zeros and significant punctuation are preserved.
The API does not infer equivalence between barcode types or regions.

Detail canonicalizes exact `type + value + region` duplicates. `origins[]`
retains every distinct origin/origin_field pair. Top-level `origin` and
`origin_field` are a deterministic representative, compatible with the existing
search expansion's naming. Origin is upstream or local; arbitrary local
enrichment JSON is not silently promoted into a canonical identifier. Local
canonical additions belong in `local_identifiers`.

POST search's opt-in identifier expansion retains its existing provenance-row
contract. Clients wanting canonical grouped identifiers should use Detail.

No single `price_search_code` is selected by the backend. For example:

1. Frontend selects a search result and requests its Detail.
2. Provider A tries MPN → EAN → name fallback.
3. Provider B tries EAN/UPC → MPN → name fallback.
4. Providers decide regional availability, disambiguation and fallback behavior.

## IDs, performance and cache

Numeric IDs remain stable during sync, update, inactivity and reactivation.
Migration 0008 prevents recycling an ID after hard deletion. `upstream_key` is
also exposed for source identity and exports; rebuilding a separate empty DB is
not an ID-preserving production migration.

Four bounded reads use product PK, spec PK, identifier product_id-leading unique
indexes, and facet PK. All 30 categories have query-plan tests. No catalog scan
or full identifier/facet scan is needed.

Cache API keys use `/__catalog_cache/product/v2/:id`, origin, catalog epoch and
TTL=600 seconds. Search retains its own namespace and 60/300/600 policy.
The shared epoch invalidates both on a completed catalog release. Missing/invalid
epoch bypasses cache. Only 200 JSON bodies are cached; no 404/error/request IDs
or timings. HIT executes zero SQL and preserves fresh per-request headers.
Browser responses remain `no-store`; cache failures use the protected DB path.
MISS uses existing search admission/refill limits and bounded telemetry route
`/v1/products/:id`, never a per-product log dimension.

Out-of-band identifier changes require epoch rotation through the existing
catalog release process, or remain visible after TTL expiry.
