-- Search-only projection. Preserve the legacy text column/ingestion contract.
-- Existing catalogs are rebuilt entirely from stored data, without upstream fetch/sync.
CREATE TABLE search_fts_backup AS SELECT rowid AS id,text FROM product_fts;
DROP TABLE product_fts;
CREATE VIRTUAL TABLE product_fts USING fts5(
  text, name, manufacturer, series, variant, family,
  tokenize='unicode61', prefix='2 3 4'
);
INSERT INTO product_fts(rowid,text,name,manufacturer,series,variant,family)
SELECT p.id,b.text,p.name,p.manufacturer,p.series,p.variant,
  trim(coalesce(c.family,'') || ' ' || coalesce(c.generation,'') || ' ' || coalesce(g.chipset,'') || ' ' || coalesce(g.chip_series,''))
FROM products p JOIN search_fts_backup b ON b.id=p.id
LEFT JOIN cpu c ON c.product_id=p.id LEFT JOIN gpu g ON g.product_id=p.id;
DROP TABLE search_fts_backup;

-- ingest_product deletes its staging row only AFTER all projections were written.
-- This hook is ordered by that operation, not by creation order of sibling triggers.
-- Its FTS update shares the existing single-statement transaction/rollback.
CREATE TRIGGER ingest_search_fields BEFORE DELETE ON ingest BEGIN
  UPDATE product_fts SET
    name=json_extract(old.payload,'$.product.name'),
    manufacturer=json_extract(old.payload,'$.product.manufacturer'),
    series=json_extract(old.payload,'$.product.series'),
    variant=json_extract(old.payload,'$.product.variant'),
    family=trim(coalesce(json_extract(old.payload,'$.spec.family'),'') || ' ' ||
      coalesce(json_extract(old.payload,'$.spec.generation'),'') || ' ' ||
      coalesce(json_extract(old.payload,'$.spec.chipset'),'') || ' ' ||
      coalesce(json_extract(old.payload,'$.spec.chip_series'),''))
  WHERE rowid=(SELECT id FROM products WHERE source='buildcores' AND upstream_key=json_extract(old.payload,'$.product.upstream_key'));
END;
