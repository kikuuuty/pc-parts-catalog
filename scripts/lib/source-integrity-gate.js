import assert from 'node:assert/strict';
import { verifySourceCatalog } from '../../src/quality/integrity.js';
import { saveValidationReport } from './validation-report.js';

export async function sourceIntegrityGate(db, catalog, snapshot, output) {
  let report = { schema_version: 2, snapshot_commit: snapshot.commit, sync: catalog.metadata.last_sync, status: 'running', pass: false,
    products: catalog.products.filter(p => p.active === 1).length, expected_products: snapshot.records.length,
    products_checked: 0, raw_checked: 0, mismatch_count: 0, by_kind: {}, product_fields: {}, sample_limit: 50,
    details: [], errors: [], omitted: 0, truncated: false };
  try {
    // This catalog-level comparison must never be confused with row provenance.
    if (snapshot.commit !== catalog.metadata.last_sync?.source_commit) {
      report.status = 'failed'; report.failure = 'Evaluation snapshot differs';
      report.mismatch_count = 1; report.by_kind.snapshot_commit = 1;
      report.details.push({ upstream_key: null, kind: 'snapshot_commit', field: 'sync_runs.source_commit' });
      report.errors.push('Catalog completed snapshot differs');
      await saveValidationReport(output, report);
      assert.equal(snapshot.commit, catalog.metadata.last_sync?.source_commit, report.failure);
    }
    report = await verifySourceCatalog(db, catalog, snapshot);
    await saveValidationReport(output, report);
    assert(report.pass, 'Source catalog integrity failed');
    return report;
  } catch (error) {
    report = error.sourceIntegrityReport ?? report;
    report.status = 'failed'; report.pass = false;
    await saveValidationReport(output, report, error);
    throw error;
  }
}
