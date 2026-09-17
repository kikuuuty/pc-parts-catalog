-- Append-only migration: keyset listing index; existing FTS projections unchanged.
CREATE INDEX products_display_order ON products(category,active,
  coalesce(manufacturer,'') COLLATE NOCASE, series IS NULL,
  coalesce(series,'') COLLATE NOCASE, coalesce(name,'') COLLATE NOCASE,id);
