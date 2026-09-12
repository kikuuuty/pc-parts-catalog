-- Real snapshot EXPLAIN: the old trailing length/capacity before product_id
-- forced sorting entire equal-speed/equal-VRAM groups even with LIMIT 20.
-- Keep those residual filters in the index, after the ORDER BY keys.
DROP INDEX gpu_vendor_vram;
CREATE INDEX gpu_vendor_vram ON gpu(chip_vendor,vram_gb,product_id,length_mm);
DROP INDEX memory_type_speed;
CREATE INDEX memory_type_speed ON memory(ram_type,speed,product_id,capacity_gb);
PRAGMA optimize;
