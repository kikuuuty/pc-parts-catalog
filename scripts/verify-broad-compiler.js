import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { searchQuery } from '../src/queries.js';

const saved = JSON.parse(await readFile('.cache/broad-read-after.json', 'utf8'));
for (const item of saved.results) {
  const query = searchQuery(item.category, { ...item, limit: 21 });
  assert.equal(`${query.sql} OFFSET ?`, item.sql, `SQL changed: ${item.id}`);
  assert.deepEqual([...query.params, item.offset ?? 0], item.params);
}
const report = { sql_and_params_identical: saved.results.length,
  validated_engine_sha256: saved.engine_sha256,
  current_engine_sha256: createHash('sha256').update(JSON.stringify(await readFile('src/queries.js', 'utf8'))).digest('hex') };
await writeFile('.cache/broad-compiler-invariance.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
