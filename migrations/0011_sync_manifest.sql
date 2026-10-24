-- Immutable application plans live in Actions artifacts/local files. Only the
-- binding is stored in D1; no per-warning or per-observation product writes.
ALTER TABLE sync_runs ADD COLUMN plan_hash TEXT;
ALTER TABLE sync_runs ADD COLUMN base_sync_id TEXT;
