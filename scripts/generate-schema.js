import { readFile, writeFile } from 'node:fs/promises';
import { categoryMigration } from './lib/category-migration.js';

// Applied migrations 0001–0007 are immutable history, not application routing.
const target = new URL('../migrations/0008_category_fts.sql', import.meta.url);
const { sql, metrics } = categoryMigration();
if (process.argv.includes('--check')) {
  if (await readFile(target, 'utf8') !== sql) throw new Error('Run npm run schema:generate');
} else await writeFile(target, sql);
console.log(JSON.stringify(metrics));
