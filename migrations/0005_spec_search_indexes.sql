-- Search access paths only. Catalog values and existing indexes remain intact.
CREATE INDEX memory_search_capacity ON memory(capacity_gb,ram_type,speed,cas_latency,product_id);
CREATE INDEX memory_search_speed ON memory(speed,ram_type,cas_latency,capacity_gb,product_id);
CREATE INDEX motherboard_search_chipset ON motherboard(chipset,product_id);
CREATE INDEX cooler_search_fan ON cpu_cooler(fan_size_mm,water_cooled,product_id) WHERE fan_size_mm IS NOT NULL;
