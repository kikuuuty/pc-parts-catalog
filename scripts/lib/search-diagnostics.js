import { createWorker } from '../../src/worker.js';
import { models } from '../../src/model.js';
import { searchQuery,hasCatalogFullScan } from '../../src/queries.js';
import { fakeLimiters } from '../../test-support/rate-limiter.js';
import { renderSearchDiagnostics } from './search-diagnostics-ui.js';

const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});

// Local administrative tool only. Reuse the real API's validation, filters and
// pagination; diagnostic SELECT/EXPLAIN statements never write catalog/reviews.
export function createSearchDiagnostics({db,cases,epoch='local-diagnostics'}) {
  return async request=>{
    const url=new URL(request.url);
    if(request.headers.has('origin')&&request.headers.get('origin')!==url.origin)return json({error:{message:'Local origin required'}},403);
    if(url.pathname==='/'&&request.method==='GET')return new Response(renderSearchDiagnostics(),{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'"}});
    if(url.pathname==='/api/categories'&&request.method==='GET')return json({categories:Object.entries(models).map(([category,model])=>({
      category,fields:{name:'TEXT',manufacturer:'TEXT',series:'TEXT',variant:'TEXT',release_year:'INTEGER',...model.fields},facets:model.facets,
    }))});
    if(url.pathname==='/api/cases'&&request.method==='GET') {
      try {
        if(!cases)return json({cases:[]});
        const id=url.searchParams.get('id');
        if(id===null)return json({cases:await cases()});
        const result=await cases(id);
        return result?json(result):json({error:{message:'Unknown case ID'}},404);
      }catch{return json({error:{message:'Source snapshot / catalogが一致するローカルDBで再実行してください。'}},500);}
    }
    const search=url.pathname==='/api/search'&&request.method==='POST';
    const detail=/^\/api\/products\/[1-9]\d*$/.test(url.pathname)&&request.method==='GET';
    if(!search&&!detail)return json({error:{message:'Not found'}},404);
    const statements=[];let event;
    const worker=createWorker({log:e=>{event=e;},cache:{async match(){},async put(){}}});
    const env={...fakeLimiters({unlimited:true}),CATALOG_CACHE_EPOCH:epoch,DB:{prepare:sql=>({bind:(...params)=>({all:async()=>{
      statements.push({sql,params});return db.query(sql,params);
    }})})}};
    try {
      const text=search?await request.text():undefined;
      if(text!==undefined&&new TextEncoder().encode(text).length>16384)return json({error:{message:'Request body too large'}},413);
      const path=search?'/v1/search':url.pathname.replace('/api/','/v1/');
      const response=await worker.fetch(new Request(new URL(path,url),{method:request.method,headers:request.headers,body:text}),env);
      const body=await response.json();
      if(!response.ok||detail)return json(body,response.status);
      const input=JSON.parse(text),query=statements[0];
      const plan=(await db.query(`EXPLAIN QUERY PLAN ${query.sql}`,query.params)).results.map(r=>r.detail);
      let scores=[];
      if(input.keyword!==undefined) {
        const q=searchQuery(input.category,{...input,limit:(input.limit??20)+1,debug:true});
        scores=(await db.query(`${q.sql} OFFSET ?`,[...q.params,input.offset??0])).results.slice(0,input.limit??20).map(p=>({
          id:p.id,score:p.search_score,match:p.search_match,fts_relevance:p.search_fts_relevance,
        }));
      }
      return json({...body,diagnostics:{rows_read:event.rows_read,sql_duration_ms:event.sql_duration_ms,query_count:event.d1_queries,
        catalog_full_scan:hasCatalogFullScan(plan),plan,scores,cost_scope:'API search only; additional EXPLAIN/debug queries excluded'}});
    } catch {
      return json({error:{message:'ローカルDBの検索に失敗しました。DBのmigration・sync状態を確認してください。'}},500);
    }
  };
}
