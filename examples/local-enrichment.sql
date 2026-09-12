-- Example only: bind a real catalog product id and independently verified values.
-- Use src/enrichment.js from Node/a future administration tool instead of manually computing value_key.
-- A local identifier is never overwritten or deleted by the upstream importer.
SELECT i.*, p.upstream_key, p.name
FROM identifiers i JOIN products p ON p.id=i.product_id
WHERE i.origin='local';

SELECT p.id, p.name, p.active, e.namespace, e.key, e.value_json, e.evidence, e.verified_at
FROM products p JOIN local_enrichments e ON e.product_id=p.id;
