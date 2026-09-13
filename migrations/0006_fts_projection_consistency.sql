-- Canonical field-aware projection, shared by repair and future ingest.
-- Legacy text remains the NORMALIZER_VERSION=1 search_text document (including
-- upstream identifiers and motherboard chipset). Do not retokenize/reorder it.
-- family is the Phase 1 CPU/GPU classification field; Phase 2 motherboard
-- identity uses its typed chipset, not an extra family-field projection.
CREATE VIEW product_search_projection AS
SELECT p.id AS product_id,p.name,p.manufacturer,p.series,p.variant,
  CASE p.category
    WHEN 'cpu' THEN trim(coalesce(c.family,'') || ' ' || coalesce(c.generation,''))
    WHEN 'gpu' THEN trim(coalesce(g.chipset,'') || ' ' || coalesce(g.chip_series,''))
    ELSE ''
  END AS family
FROM products p
LEFT JOIN cpu c ON p.category='cpu' AND c.product_id=p.id
LEFT JOIN gpu g ON p.category='gpu' AND g.product_id=p.id;

DROP TRIGGER ingest_search_fields;
CREATE TRIGGER ingest_search_fields BEFORE DELETE ON ingest BEGIN
  -- ingest_product deletes staging only after products/typed specs/identifiers
  -- and the legacy FTS text are persisted. This shares its atomic transaction.
  UPDATE product_fts SET (name,manufacturer,series,variant,family) = (
    SELECT name,manufacturer,series,variant,family FROM product_search_projection
    WHERE product_id=product_fts.rowid
  )
  WHERE rowid=(SELECT id FROM products WHERE source='buildcores'
    AND upstream_key=json_extract(old.payload,'$.product.upstream_key'));
END;

-- In-place, NULL-safe repair: examine every existing document but write only
-- mismatched field projections. Preserve rowid/text and all source catalog data.
UPDATE product_fts SET (name,manufacturer,series,variant,family) = (
  SELECT name,manufacturer,series,variant,family FROM product_search_projection
  WHERE product_id=product_fts.rowid
)
WHERE rowid IN (SELECT product_id FROM product_search_projection)
  AND (name,manufacturer,series,variant,family) IS NOT (
    SELECT name,manufacturer,series,variant,family FROM product_search_projection
    WHERE product_id=product_fts.rowid
  );
