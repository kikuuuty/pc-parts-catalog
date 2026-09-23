import { readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { classifySearchCost } from '../src/search-protection.js';
import { distribution } from './lib/cache-measurement.js';
const {directory}=JSON.parse(await readFile('.cache/category-release-latest.json','utf8'));
const quality=JSON.parse(await readFile(path.join(directory,'quality.json'),'utf8'));
const samples=quality.results.map(r=>({id:r.id,intent:r.intent,source:'local D1 first-page intent benchmark',
  predicted:classifySearchCost({...r.search,category:r.category,...(r.query?{keyword:r.query}:{})},{method:r.search?'POST':'GET'}),rows_read:r.rows_read}));
if(!samples.every(s=>Number.isFinite(s.rows_read)))throw new Error('Missing measured D1 cost');
const report={generated_at:new Date().toISOString(),fixture_sha256:quality.fixture_sha256,expensive_boundary_rows:5000,samples,
  classes:Object.fromEntries(['normal','expensive','uncached','bootstrap'].map(c=>[c,distribution(samples.filter(s=>s.predicted===c).map(s=>s.rows_read))])),
  false_negatives:samples.filter(s=>s.rows_read>=5000&&s.predicted==='normal'),
  conservative:samples.filter(s=>s.rows_read<5000&&s.predicted!=='normal').length};
await writeFile('.cache/rate-classifier.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,samples:undefined},null,2));
