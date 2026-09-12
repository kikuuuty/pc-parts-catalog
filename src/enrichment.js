import { identifierKey } from './normalize.js';

// DB adapter is shared with the CLI; callers can use local D1 or the remote REST adapter.
export async function addLocalIdentifier(db, { productId, type, value, region = 'jp', evidence, verifiedAt = null }) {
  if (!Number.isSafeInteger(productId) || productId <= 0 || !['mpn','gtin','ean','upc','jan'].includes(type) || typeof value !== 'string' || !value.trim() || typeof region !== 'string' || !region.trim() || typeof evidence !== 'string' || !evidence.trim()) throw new Error('Invalid local identifier or missing evidence');
  if (verifiedAt !== null && (typeof verifiedAt !== 'string' || !Number.isFinite(Date.parse(verifiedAt)))) throw new Error('Invalid verification timestamp');
  return db.query(`INSERT INTO local_identifiers(product_id,type,value,value_key,region,evidence,verified_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(product_id,type,value,region)
    DO UPDATE SET value_key=excluded.value_key,evidence=excluded.evidence,verified_at=excluded.verified_at`,
  [productId, type, value, identifierKey(value), region, evidence, verifiedAt]);
}

export async function setLocalEnrichment(db, { productId, namespace, key, value, evidence, verifiedAt = null }) {
  if (!Number.isSafeInteger(productId) || productId <= 0 || typeof namespace !== 'string' || !namespace.trim() || typeof key !== 'string' || !key.trim() || value === undefined || typeof evidence !== 'string' || !evidence.trim()) throw new Error('Invalid enrichment or missing evidence');
  if (verifiedAt !== null && (typeof verifiedAt !== 'string' || !Number.isFinite(Date.parse(verifiedAt)))) throw new Error('Invalid verification timestamp');
  return db.query(`INSERT INTO local_enrichments(product_id,namespace,key,value_json,evidence,verified_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(product_id,namespace,key) DO UPDATE SET value_json=excluded.value_json,evidence=excluded.evidence,
    verified_at=excluded.verified_at,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  [productId, namespace, key, JSON.stringify(value), evidence, verifiedAt]);
}
