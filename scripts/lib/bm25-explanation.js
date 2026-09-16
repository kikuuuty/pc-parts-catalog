// Explanatory reproduction of FTS5's BM25 for a lexical expression consisting of
// unscoped quoted AND/OR phrases, including compact-model query expansion.
// This is a diagnostic, never a replacement ranking implementation.
import assert from 'node:assert/strict';
const weights={text:.1,name:10,manufacturer:2,series:4,variant:3,family:4};
export function explainLexicalBm25(sqlite,index,expression,topResults) {
  assert(/^[a-z_]+$/.test(index));
  assert(!expression.replace(/"[^"]+"\*?|\bAND\b|\bOR\b|[()\s]/g,''),'Unsupported explanation grammar');
  sqlite.exec(`CREATE VIRTUAL TABLE temp.explain_vocab USING fts5vocab(main,${index},'instance');
    CREATE VIRTUAL TABLE temp.explain_row USING fts5vocab(main,${index},'row');
    CREATE VIRTUAL TABLE temp.explain_tokens USING fts5(text,tokenize='unicode61');
    CREATE VIRTUAL TABLE temp.explain_token_instances USING fts5vocab(temp,explain_tokens,'instance')`);
  const documents=sqlite.prepare(`SELECT count(*) AS n FROM ${index}`).get().n;
  const avg=sqlite.prepare('SELECT sum(cnt) AS n FROM temp.explain_row').get().n/documents;
  const phrases=[...expression.matchAll(/"([^"]+)"(\*)?/g)].map(match=>{
    sqlite.exec('DELETE FROM temp.explain_tokens');sqlite.prepare('INSERT INTO temp.explain_tokens(text) VALUES(?)').run(match[1]);
    const terms=sqlite.prepare('SELECT term FROM temp.explain_token_instances ORDER BY offset').all().map(r=>r.term);
    const df=sqlite.prepare(`SELECT count(*) AS n FROM ${index} WHERE ${index} MATCH ?`).get(match[0]).n;
    return {phrase:match[0],terms,prefix:Boolean(match[2]),document_frequency:df,corpus_rate:df/documents,idf:Math.max(1e-6,Math.log((documents-df+.5)/(df+.5)))};
  });
  const results=topResults.map(row=>{
    const tokens=sqlite.prepare('SELECT col,offset,term FROM temp.explain_vocab WHERE doc=? ORDER BY col,offset').all(row.id);
    const cols=Object.fromEntries(Object.keys(weights).map(col=>[col,tokens.filter(t=>t.col===col).map(t=>t.term)]));
    const length=tokens.length,normalizer=1.2*(.25+.75*length/avg);
    const contributions=phrases.map(phrase=>{
      const counts=Object.fromEntries(Object.entries(cols).map(([col,terms])=>[col,terms.filter((_,start)=>phrase.terms.every((term,offset)=>
        phrase.prefix && offset===phrase.terms.length-1 ? terms[start+offset]?.startsWith(term) : terms[start+offset]===term)).length]));
      const weightedTf=Object.entries(counts).reduce((n,[col,count])=>n+weights[col]*count,0);
      return {phrase:phrase.phrase,counts,weighted_tf:weightedTf,contribution:weightedTf ? phrase.idf*weightedTf*2.2/(weightedTf+normalizer):0};
    });
    const reproduced=contributions.reduce((n,p)=>n+p.contribution,0);
    assert(Math.abs(reproduced-row.search_fts_relevance)<1e-10,`BM25 reproduction differs for ${row.upstream_key}`);
    return {upstream_key:row.upstream_key,name:row.name,rank:row.rank,document_length:length,length_normalizer:normalizer,contributions,reproduced_relevance:reproduced};
  });
  return {index,expression,documents,average_document_length:avg,k1:1.2,b:.75,weights,phrases,results,note:'Reproduced values are checked within each corpus only. Compare rank, DF and term/length contributions, not cross-corpus absolute BM25.'};
}
