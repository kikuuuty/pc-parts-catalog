import { writeFile } from 'node:fs/promises';

// Saving a diagnostic must not replace an authoritative validation/read error.
// A save failure on the success path still stops publication.
export async function saveValidationReport(file, report, originalError) {
  try { await writeFile(file, JSON.stringify(report, null, 2) + '\n'); }
  catch (error) {
    if (!originalError) throw error;
    originalError.reportSaveFailed = true;
    console.error('Validation report could not be saved; original failure retained');
  }
}
