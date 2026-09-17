import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import { openDatabase } from '../src/database.js';
import { createSearchDiagnostics } from './lib/search-diagnostics.js';
import { createCaseDiagnostics } from './lib/case-diagnostics.js';

const {values:args}=parseArgs({options:{port:{type:'string',default:'8788'},case:{type:'string'}}});
const port=Number(args.port);
if(!Number.isInteger(port)||port<0||port>65535)throw Error('Invalid port');
const db=await openDatabase(false); // Deliberately no remote mode or credentials.
let server;
try {
  const state=await db.query("SELECT id FROM sync_runs WHERE status='complete' ORDER BY started_at DESC LIMIT 1");
  const cases=createCaseDiagnostics(db);
  if(args.case&&!(await cases()).some(r=>r.id===args.case))throw Error(`Unknown case: ${args.case}`);
  const handle=createSearchDiagnostics({db,cases,epoch:`local-${state.results[0]?.id??'unversioned'}`});
  server=createServer(async(req,res)=>{
    const address=server.address();
    if(![`127.0.0.1:${address.port}`,`localhost:${address.port}`].includes(req.headers.host)) {res.writeHead(403).end();return;}
    try {
      const chunks=[];let size=0;
      for await(const chunk of req) {
        size+=chunk.length;
        if(size>16384){res.writeHead(413).end('Request body too large');return;}
        chunks.push(chunk);
      }
      const requestOrigin=`http://${req.headers.host}`;
      const response=await handle(new Request(new URL(req.url,requestOrigin),{method:req.method,headers:req.headers,
        ...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})}));
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
    } catch {res.writeHead(500,{'Content-Type':'text/plain; charset=utf-8'}).end('Local diagnostic request failed');}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  console.log(`検索診断: http://127.0.0.1:${server.address().port}/${args.case?`?case=${encodeURIComponent(args.case)}`:''}`);
  console.log('カテゴリと検索語を入力してください。ローカルDBのみを読み取ります。終了: Ctrl+C');
  let closing=false;
  const close=async()=>{
    if(closing)return;closing=true;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await db.close();
  };
  process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());
} catch(error) {
  server?.close();await db.close();throw error;
}
