-- BuildCores-derived catalog: see sources and NOTICE.md for ODC-By attribution.
-- All values below are examples. APIs should use bound parameters as in src/queries.js.

-- Category + manufacturer + series; left prefix also handles category/manufacturer.
SELECT id,name,series,variant FROM products
WHERE active=1 AND category='cpu' AND manufacturer='Intel' AND series='Core i7 14000'
ORDER BY id LIMIT 20;

-- Category + series (manufacturer not specified).
SELECT id,name FROM products
WHERE active=1 AND category='storage' AND series='WD_Black' ORDER BY id LIMIT 20;

-- Socket filter.
SELECT p.id,p.name,c.socket FROM cpu c JOIN products p ON p.id=c.product_id
WHERE p.active=1 AND p.category='cpu' AND c.socket='AM5' LIMIT 20;

-- 1. CPU + Intel + Core i7.
SELECT p.id,p.name,c.core_count FROM cpu c JOIN products p ON p.id=c.product_id
WHERE p.active=1 AND p.category='cpu' AND c.manufacturer='Intel' AND c.family='Core i7'
ORDER BY c.core_count,c.product_id LIMIT 20;

-- 2. CPU + AMD + Ryzen 7 + cores >=8.
SELECT p.id,p.name,c.core_count FROM cpu c JOIN products p ON p.id=c.product_id
WHERE p.active=1 AND p.category='cpu' AND c.manufacturer='AMD' AND c.family='Ryzen 7' AND c.core_count>=8
ORDER BY c.core_count,c.product_id LIMIT 20;

-- 3. GPU + NVIDIA + VRAM >=16GB + length <=320mm.
SELECT p.id,p.name,g.vram_gb,g.length_mm FROM gpu g JOIN products p ON p.id=g.product_id
WHERE p.active=1 AND p.category='gpu' AND g.chip_vendor='NVIDIA' AND g.vram_gb>=16 AND g.length_mm<=320
ORDER BY g.vram_gb,g.product_id LIMIT 20;

-- 4. RAM + DDR5 + capacity >=32GB + speed >=6000.
SELECT p.id,p.name,m.capacity_gb,m.speed FROM memory m JOIN products p ON p.id=m.product_id
WHERE p.active=1 AND p.category='memory' AND m.ram_type='DDR5' AND m.capacity_gb>=32 AND m.speed>=6000
ORDER BY m.speed,m.product_id LIMIT 20;

-- 5. PSU + ATX + wattage >=850W.
SELECT p.id,p.name,s.wattage FROM psu s JOIN products p ON p.id=s.product_id
WHERE p.active=1 AND p.category='psu' AND s.form_factor='ATX' AND s.wattage>=850
ORDER BY s.wattage,s.product_id LIMIT 20;

-- 6. Case + GPU clearance >=350mm.
SELECT p.id,p.name,c.max_gpu_length_mm FROM pc_case c JOIN products p ON p.id=c.product_id
WHERE p.active=1 AND p.category='case' AND c.max_gpu_length_mm>=350
ORDER BY c.max_gpu_length_mm,c.product_id LIMIT 20;

-- 7. Exact MPN across all categories, combining upstream and local identifiers.
SELECT p.id,p.category,p.name FROM products p
WHERE p.active=1 AND p.id IN (
  SELECT product_id FROM identifiers WHERE value_key='BX80768285K' AND type='mpn'
);

-- Numeric BETWEEN operates on a typed column, never json_extract in a filter.
SELECT p.name,g.length_mm FROM gpu g JOIN products p ON p.id=g.product_id
WHERE p.active=1 AND p.category='gpu' AND g.length_mm BETWEEN 250 AND 320
ORDER BY g.length_mm,g.product_id LIMIT 20;

-- Keyword + typed filters (CLI also searches local_identifier_fts).
SELECT p.id,p.name,g.vram_gb,g.length_mm FROM products p JOIN gpu g ON g.product_id=p.id
WHERE p.active=1 AND p.category='gpu'
  AND p.id IN (SELECT rowid FROM product_fts WHERE product_fts MATCH '"RTX"* AND "5080"*')
  AND g.vram_gb>=16 AND g.length_mm<=320 LIMIT 20;

-- Example EXPLAIN. The full automated set uses exactly the CLI query builder.
EXPLAIN QUERY PLAN
SELECT p.id,p.name,s.wattage FROM psu s JOIN products p ON p.id=s.product_id
WHERE p.active=1 AND p.category='psu' AND s.form_factor='ATX' AND s.wattage>=850
ORDER BY s.wattage,s.product_id LIMIT 20;
