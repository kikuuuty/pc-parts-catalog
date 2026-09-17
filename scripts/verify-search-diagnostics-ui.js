// Optional loopback-only Edge check against the existing local D1 catalog.
import assert from 'node:assert/strict';
import { spawn,execFile } from 'node:child_process';
import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';

const profile=await mkdtemp('.cache/search-diagnostics-browser-');
const server=spawn(process.execPath,['scripts/search-diagnostics.js','--port','0'],{stdio:['ignore','pipe','pipe'],env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
let browser,socket;
const ready=(child,stream,pattern)=>new Promise((resolve,reject)=>{
  let text='';const timer=setTimeout(()=>reject(Error('Startup timeout')),30000);
  child.once('error',error=>{clearTimeout(timer);reject(error);});
  child.once('exit',code=>{clearTimeout(timer);reject(Error(`Process exited: ${code}`));});
  stream.on('data',chunk=>{text+=chunk;const match=text.match(pattern);if(match){clearTimeout(timer);resolve(match[1]);}});
});
try {
  const origin=await ready(server,server.stdout,/(http:\/\/127\.0\.0\.1:\d+)/);
  browser=spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${path.resolve(profile)}`,'about:blank'],{stdio:['ignore','ignore','pipe']});
  const port=await ready(browser,browser.stderr,/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/);
  const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  let id=0;const pending=new Map(),errors=[];
  socket.onmessage=event=>{const m=JSON.parse(event.data);if(m.method==='Runtime.exceptionThrown')errors.push(m.params);if(pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}};
  const call=async(method,params={})=>{
    const current=++id;
    const message=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(`CDP timeout: ${method}`)),120000);pending.set(current,value=>{clearTimeout(timer);resolve(value);});socket.send(JSON.stringify({id:current,method,params}));});
    if(message.error)throw Error(JSON.stringify(message.error));return message.result;
  };
  const evaluate=async expression=>{const result=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
  const wait=expression=>evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+110000;const timer=setInterval(()=>{if(${expression}){clearInterval(timer);resolve(true);}else if(Date.now()>end){clearInterval(timer);reject(Error('UI timeout'));}},50);})`);
  await call('Runtime.enable');await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride',{width:1200,height:1000,deviceScaleFactor:1,mobile:false});
  await call('Page.navigate',{url:origin});
  await wait("document.querySelector('#category')?.options.length===30");
  assert.equal(await evaluate("document.querySelectorAll('#reviewer,#rationale,.checks').length"),0);
  await evaluate("document.querySelector('#keyword').value='9800x3d';document.querySelector('#form').requestSubmit();");
  await wait("document.querySelector('#results h2') && !document.querySelector('#search').disabled");
  assert.match(await evaluate("document.querySelector('#results h2').textContent"),/9800X3D/i);
  assert((await evaluate("document.querySelector('#scores').textContent")).includes('score'));
  const image=await call('Page.captureScreenshot',{format:'png'});await writeFile('.cache/search-diagnostics-preview.png',Buffer.from(image.data,'base64'));
  await evaluate("document.querySelector('#category').value='memory';document.querySelector('#category').dispatchEvent(new Event('change'));document.querySelector('#keyword').value='';document.querySelector('#add-filter').click();const field=document.querySelector('.filter-row select');field.value='capacity_gb';field.dispatchEvent(new Event('change'));document.querySelector('.filter-row input').value='32';document.querySelector('#form').requestSubmit();");
  await wait("document.querySelectorAll('#results article').length===20 && !document.querySelector('#search').disabled");
  assert((await evaluate("document.querySelector('#results').textContent")).includes('容量 (GB): 32'));
  const first=await evaluate("Array.from(document.querySelectorAll('#results button[data-id]'),b=>b.dataset.id)");
  await evaluate("document.querySelector('#next').click();");
  await wait("document.querySelector('#summary').textContent.includes('21件目') && !document.querySelector('#search').disabled");
  const second=await evaluate("Array.from(document.querySelectorAll('#results button[data-id]'),b=>b.dataset.id)");
  assert(second.every(id=>!first.includes(id)));
  await evaluate("document.querySelector('#results button[data-id]').click();");
  await wait("document.querySelector('#results .identifiers').textContent.length>0");
  await evaluate("document.querySelector('#case-id').value='p2-storage-sata1tb';document.querySelector('#case-load').click();");
  await wait("!document.querySelector('#case-load').disabled && document.querySelector('#case-results').textContent.includes('Expected 130')");
  assert.match(await evaluate("document.querySelector('#case-results').textContent"),/Returned relevant 130/);
  assert.match(await evaluate("document.querySelector('#case-results').textContent"),/False negatives \(0\)/);
  await evaluate("document.querySelector('#case-id').value='ext-mouse-03';document.querySelector('#case-load').click();");
  await wait("!document.querySelector('#case-load').disabled && document.querySelector('#case-results').textContent.includes('Actual rank: 1')");
  assert.match(await evaluate("document.querySelector('#case-results').textContent"),/910-005469/);
  assert.match(await evaluate("document.querySelector('#case-results').textContent"),/BM25 relevance/);
  assert.deepEqual(errors,[]);
  console.log('Local browser diagnostics passed: keyword search, optional typed filter, cursor pages, identifiers, score/plan UI; no approval inputs. Preview: .cache/search-diagnostics-preview.png');
} finally {
  socket?.close();
  for(const child of [browser,server])if(child?.pid)await promisify(execFile)('taskkill',['/PID',String(child.pid),'/T','/F']).catch(()=>{});
  await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:300});
}
