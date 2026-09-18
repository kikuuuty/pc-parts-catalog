import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';

const child=spawn(process.execPath,['scripts/search-diagnostics.js','--case','cpu-9800x3d','--port','0'],{stdio:['ignore','pipe','pipe']});
try {
  const origin=await new Promise((resolve,reject)=>{
    let text='';const timer=setTimeout(()=>reject(Error('Diagnostic startup timeout')),60000);
    child.once('error',reject);child.once('exit',code=>reject(Error(`Diagnostic exit ${code}`)));
    child.stdout.on('data',chunk=>{text+=chunk;const match=text.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});
  });
  const response=await fetch(`${origin}/api/cases?id=cpu-9800x3d`);
  assert.equal(response.status,200);
  const report=await response.json();
  assert.equal(report.source_snapshot_commit,'eec0df175504ebd15f0f3e3a8249a18a22f00940');
  assert.deepEqual(report.failures,[]);
  await writeFile('.cache/transition-diagnostics.json',JSON.stringify(report,null,2)+'\n');
  console.log('PASS: diagnose:search -- --case cpu-9800x3d; matching snapshot; read-only local case evaluation');
} finally {if(child.pid)await promisify(execFile)('taskkill',['/PID',String(child.pid),'/T','/F']).catch(()=>{});}
