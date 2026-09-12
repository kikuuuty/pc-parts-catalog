import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export async function loadSearchFixture(file) {
  if (file) {
    const input = await readFile(file,'utf8');
    return { fixture:JSON.parse(input), hash:createHash('sha256').update(input).digest('hex') };
  }
  const root = new URL('../../test/fixtures/',import.meta.url);
  const inputs = await Promise.all(['search-benchmark.json','search-regression-labels.json','search-phase2.json'].map(f => readFile(new URL(f,root),'utf8')));
  const [regression,labels,added] = inputs.map(JSON.parse);
  if (Object.keys(labels).length !== regression.length || regression.some(r => !Object.hasOwn(labels,r.id))) throw new Error('Regression labels must cover the frozen legacy fixture exactly');
  if (Object.values(labels).some(label => Object.keys(label).some(k => !['class','acceptable'].includes(k)))) throw new Error('Regression labels may only add class/acceptable, never override expected or query');
  const fixture = [...regression.map(r => ({...r,...labels[r.id],suite:'regression'})),...added];
  return { fixture,hash:createHash('sha256').update(JSON.stringify(inputs)).digest('hex') };
}
