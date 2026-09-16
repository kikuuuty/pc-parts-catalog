# Category-specific search architecture

The category registry is the only routing authority. `ftsName(category)` validates
the category and returns `${category}_fts`. No request can supply a SQL table name.

|Category|FTS|Category|FTS|
|---|---|---|---|
|cpu|cpu_fts|memory|memory_fts|
|motherboard|motherboard_fts|gpu|gpu_fts|
|storage|storage_fts|psu|psu_fts|
|case|case_fts|case_fan|case_fan_fts|
|cpu_cooler|cpu_cooler_fts|accessory|accessory_fts|
|capture_card|capture_card_fts|chair|chair_fts|
|desk|desk_fts|headphones|headphones_fts|
|keyboard|keyboard_fts|laptop|laptop_fts|
|lighting|lighting_fts|microphone|microphone_fts|
|monitor|monitor_fts|mouse|mouse_fts|
|mousepad|mousepad_fts|network_card|network_card_fts|
|os|os_fts|prebuilt_desktop|prebuilt_desktop_fts|
|sound_card|sound_card_fts|speaker|speaker_fts|
|stand|stand_fts|thermal_compound|thermal_compound_fts|
|vr_headset|vr_headset_fts|webcam|webcam_fts|

All indexes retain six fields (`text,name,manufacturer,series,variant,family`),
`unicode61`, and prefix `2 3 4`. No category-specific field or tokenizer changes.
BM25 corpus statistics cannot change because of documents in another category.
Local identifiers have a separate, unscored candidate index; they never contribute
to product BM25 statistics. All candidate paths apply category/active/typed scope.

## Retrieval and presentation

`searchQuery` retrieves candidates with category FTS and indexed typed/identifier
paths. Existing bounded model expansion and debug scores remain available.
`orderBy: relevance` uses ranking; `manufacturer`, `series`, `name` and typed field
ordering use the same retrieved/filtered set with an ID tiebreaker. Price belongs
to a future Provider-backed presentation layer, not a fabricated catalog value.

Browse evaluation measures relevant sets, not a single expected product's rank.
Explicit UI filters are strict; specification words interpreted from free text
remain soft retrieval/ranking hints. Clients should submit typed filters after
facet selection rather than concatenate them into the keyword.

## Migration 0008

`scripts/lib/category-migration.js` generates the migration. Applied migrations
0001–0007 remain immutable history required to upgrade existing databases.
The upgrade copies the existing normalized search text to
`product_search_documents` and backfills **active** products into category FTS
from the canonical field projection. The previous indexes/triggers are dropped.

The common ingest trigger writes product/raw/identifiers/facets and deletes its
staging row. One category staging hook then writes typed specs and the durable
search document. Its document trigger rebuilds that category's FTS using persisted
product/spec fields. Trigger dependencies provide explicit ordering; correctness
does not depend on the order of sibling triggers.

Product category/active changes remove the previous category document; active
products are inserted into their current FTS. Search text survives inactivity so
direct reactivation works. Hard deletion removes dependent rows and FTS in the
same transaction. The durable numeric-ID high-water mark prevents ID reuse.

The migration is 221 statements, maximum statement/CREATE TRIGGER 2,988 bytes,
well below the D1 100KB statement limit. No trigger contains all 30 category
spec/FTS branches. Generator enforces a 50KB budget.

## Integrity and operational boundaries

For every active product: one document in its category FTS, none in the other 29.
Inactive/deleted products have none. Audits report missing, duplicate, wrong
category, inactive orphan and canonical projection drift separately.

Sync keeps its lease, atomic chunk, content-hash resume, partial-sync deletion
deferral, local identifier/enrichment preservation and write budgets. Migration
does not change normalization or source IDs. Product Detail uses these IDs after
frontend selection; see [Product Detail](product-detail.md).

Production activation requires the [release gates](catalog-release.md).
