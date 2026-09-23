-- Current normalized Offer summary cache, not price history or catalog data.
CREATE TABLE product_offer_summary (
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK(provider = 'yahoo'),
  source TEXT NOT NULL,
  upstream_key TEXT NOT NULL,
  catalog_epoch TEXT NOT NULL,
  generation TEXT NOT NULL,
  ttl_seconds INTEGER NOT NULL CHECK(ttl_seconds BETWEEN 60 AND 3600),
  status TEXT NOT NULL CHECK(status IN ('complete', 'empty', 'unsupported')),
  lowest_price INTEGER,
  offer_count INTEGER NOT NULL CHECK(offer_count BETWEEN 0 AND 50),
  lookup_strategy TEXT CHECK(lookup_strategy IN ('jan', 'ean13_as_jan')),
  fetched_at TEXT,
  observed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at > observed_at),
  PRIMARY KEY(product_id, provider),
  CHECK((status = 'complete' AND typeof(lowest_price) = 'integer' AND lowest_price > 0 AND offer_count > 0)
    OR (status IN ('empty', 'unsupported') AND lowest_price IS NULL AND offer_count = 0)),
  CHECK((status = 'unsupported' AND lookup_strategy IS NULL AND fetched_at IS NULL)
    OR (status IN ('complete', 'empty') AND lookup_strategy IS NOT NULL AND fetched_at IS NOT NULL))
) WITHOUT ROWID;
