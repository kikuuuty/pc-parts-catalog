-- Source notices travel with database exports.
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  license TEXT NOT NULL,
  license_url TEXT NOT NULL,
  attribution TEXT NOT NULL
);
INSERT INTO sources VALUES ('buildcores', 'BuildCores OpenDB',
  'https://github.com/buildcores/buildcores-open-db', 'ODC-By 1.0',
  'https://opendatacommons.org/licenses/by/1-0/',
  'Contains information from BuildCores OpenDB (https://github.com/buildcores/buildcores-open-db), which is made available under the ODC Attribution License (https://opendatacommons.org/licenses/by/1-0/).');
CREATE TABLE categories (id TEXT PRIMARY KEY, upstream_name TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL);
CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL REFERENCES sources(id),
  upstream_id TEXT NOT NULL,
  upstream_key TEXT NOT NULL,
  category TEXT NOT NULL REFERENCES categories(id),
  manufacturer TEXT,
  name TEXT NOT NULL,
  series TEXT,
  variant TEXT,
  release_year INTEGER,
  manufacturer_url TEXT,
  identity_version INTEGER,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
  content_hash TEXT NOT NULL,
  source_commit TEXT NOT NULL,
  normalization_version INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(source, upstream_key)
);
CREATE INDEX products_category_manufacturer_series ON products(category, manufacturer, series, id) WHERE active=1;
CREATE INDEX products_category_series ON products(category, series, id) WHERE active=1;
CREATE TABLE upstream_raw (
  product_id INTEGER PRIMARY KEY REFERENCES products(id),
  raw_json TEXT NOT NULL CHECK(json_valid(raw_json))
);
CREATE TABLE upstream_identifiers (
  product_id INTEGER NOT NULL REFERENCES products(id),
  type TEXT NOT NULL,
  value TEXT NOT NULL,
  value_key TEXT NOT NULL,
  region TEXT NOT NULL,
  origin_field TEXT NOT NULL,
  PRIMARY KEY(product_id, type, value, region, origin_field)
);
CREATE INDEX upstream_identifier_exact ON upstream_identifiers(value_key, type, product_id);
CREATE TABLE local_identifiers (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  type TEXT NOT NULL CHECK(type IN ('mpn','gtin','ean','upc','jan')),
  value TEXT NOT NULL CHECK(length(trim(value))>0),
  value_key TEXT NOT NULL CHECK(length(value_key)>0),
  region TEXT NOT NULL DEFAULT 'jp',
  evidence TEXT NOT NULL,
  verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(product_id, type, value, region)
);
CREATE INDEX local_identifier_exact ON local_identifiers(value_key, type, product_id);
CREATE VIEW identifiers AS
  SELECT product_id,type,value,value_key,region,'upstream' AS origin,origin_field,NULL AS evidence,NULL AS verified_at FROM upstream_identifiers
  UNION ALL
  SELECT product_id,type,value,value_key,region,'local','local_identifiers',evidence,verified_at FROM local_identifiers;
CREATE TABLE local_enrichments (
  product_id INTEGER NOT NULL REFERENCES products(id),
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL CHECK(json_valid(value_json)),
  evidence TEXT NOT NULL,
  verified_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(product_id, namespace, key)
);
CREATE TABLE product_facets (
  product_id INTEGER NOT NULL REFERENCES products(id),
  attribute TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY(product_id, attribute, value)
);
CREATE INDEX facets_value ON product_facets(attribute, value, product_id);
CREATE VIRTUAL TABLE product_fts USING fts5(text, tokenize='unicode61', prefix='2 3 4');
CREATE VIRTUAL TABLE local_identifier_fts USING fts5(value, content='local_identifiers', content_rowid='id', tokenize='unicode61', prefix='2 3 4');
CREATE TRIGGER local_identifier_insert AFTER INSERT ON local_identifiers BEGIN
  INSERT INTO local_identifier_fts(rowid,value) VALUES(new.id,new.value);
END;
CREATE TRIGGER local_identifier_delete AFTER DELETE ON local_identifiers BEGIN
  INSERT INTO local_identifier_fts(local_identifier_fts,rowid,value) VALUES('delete',old.id,old.value);
END;
CREATE TRIGGER local_identifier_update AFTER UPDATE ON local_identifiers BEGIN
  INSERT INTO local_identifier_fts(local_identifier_fts,rowid,value) VALUES('delete',old.id,old.value);
  INSERT INTO local_identifier_fts(rowid,value) VALUES(new.id,new.value);
END;
CREATE TABLE sync_runs (
  id TEXT PRIMARY KEY,
  source_commit TEXT NOT NULL,
  normalization_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','complete','partial','failed')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  report_json TEXT,
  error TEXT
);
CREATE TABLE sync_lock (
  id INTEGER PRIMARY KEY CHECK(id=1),
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
-- Every product is applied atomically by one INSERT + trigger.
CREATE TABLE ingest (id INTEGER PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload)));
