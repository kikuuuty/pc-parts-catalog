import { models,ftsName } from '../model.js';
import { searchQuery } from '../queries.js';
import { parseSearchIntent } from '../search-intent.js';
import { matchesFilters } from './ux.js';
import { resolveExpected } from './benchmark.js';

// Evidence only: source membership is never inferred from returned candidates.
export async function diagnoseResult(db,source,result) {
  const byId=new Map(source.products.map(p=>[p.id,p]));
  const returned=new Set(result.returned_ids),relevant=new Set(result.relevant_ids);
  const originalExpected=new Set(['lookup','identifier'].includes(result.intent)&&result.expected?resolveExpected(source,result.category,result.expected).products.map(p=>p.id):[]);
  const condition={selector:result.equivalents??result.relevant??result.expected,search:result.search??{}};
  const product=id=>{
    const p=byId.get(id);
    return p?{id:p.id,source:p.source,upstream_key:p.upstream_key,name:p.name,manufacturer:p.manufacturer,
      series:p.series,variant:p.variant,spec:p.spec,identifiers:p.identifiers,source_condition:condition,
      fixture_expected:originalExpected.has(id),source_relevant:relevant.has(id),source_filters_match:matchesFilters(p,result.search)}:{id,missing_from_source:true};
  };
  const top=[];
  const actual=searchQuery(result.category,{...result.search,...(result.query?{keyword:result.query}:{}),limit:51,cursorPage:true});
  if(result.query) {
    const q=searchQuery(result.category,{...result.search,keyword:result.query,limit:10,debug:true});
    for(const [i,p] of (await db.query(q.sql,q.params)).results.entries())top.push({...product(p.id),rank:i+1,
      match_type:p.search_match,final_score:p.search_score,bm25_relevance:p.search_fts_relevance});
  }
  const missing=result.relevant_ids.filter(id=>!returned.has(id));
  const traces=[];
  // Membership lists are complete; expensive row-level traces are capped at ten.
  if(result.query) {
    const q=searchQuery(result.category,{...result.search,keyword:result.query,limit:10});
    const terms=q.params.map(p=>{try{return typeof p==='string'?JSON.parse(p):null;}catch{return null;}}).find(p=>p?.strict);
    const index=ftsName(result.category);
    for(const id of missing.slice(0,10)) {
      const fts=(await db.query(`SELECT * FROM ${index} WHERE rowid=?`,[id])).results;
      const expressions=[terms.literalPrefix??terms.candidatePrefix??terms.strict.prefix,...(terms.protocolPrefix?[terms.protocolPrefix]:[])];
      const expression=expressions.map(s=>`(${s})`).join(' OR ');
      const match=(await db.query(`SELECT rowid FROM ${index} WHERE rowid=? AND ${index} MATCH ?`,[id,expression])).results;
      const typedRow=(await db.query(`SELECT * FROM ${models[result.category].table} WHERE product_id=?`,[id])).results[0]??null;
      const raw=(await db.query('SELECT raw_json FROM upstream_raw WHERE product_id=?',[id])).results[0];
      traces.push({...product(id),search_text:fts,fts_membership:fts.length===1,fts_match:match.length===1,
        typed_row:typedRow,typed_predicates_match:typedRow!==null&&matchesFilters({...byId.get(id),spec:typedRow},result.search),
        source_raw:raw?JSON.parse(raw.raw_json):null,
        normalization:parseSearchIntent(result.category,result.query),match_expression:expression});
    }
  }
  return {...result,candidate_generation:actual,required:['lookup','identifier'].includes(result.intent)?`Hit@${result.intent==='identifier'?1:result.floors?.hit_at??(result.class==='exact_model'?1:['fallback','typo'].includes(result.class)?5:3)}`:null,
    expected_products:result.relevant_ids.map(product),top_results:top,
    relevant_returned:result.returned_ids.filter(id=>relevant.has(id)).map(product),
    false_positives:result.returned_ids.filter(id=>!relevant.has(id)).map(product),false_negatives:missing.map(product),missing_traces:traces,trace_limit:10};
}
