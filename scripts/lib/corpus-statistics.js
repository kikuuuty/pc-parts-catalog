import { createHash } from 'node:crypto';
import { categories, ftsName } from '../../src/model.js';
import { searchQuery } from '../../src/queries.js';

// node:sqlite only, outside production requests. Unicode61 itself tokenizes the
// original and expanded MATCH terms; JS tokenization is not used as a DF proxy.
export function corpusStatistics(sqlite, fixture) {
  const indexes = categories.map(ftsName);
  sqlite.exec("CREATE VIRTUAL TABLE temp.diagnostic_tokens USING fts5(text,tokenize='unicode61'); CREATE VIRTUAL TABLE temp.diagnostic_token_vocab USING fts5vocab(temp,diagnostic_tokens,'row')");
  const statistics={};
  for (const index of indexes) {
    sqlite.exec(`CREATE VIRTUAL TABLE temp.${index}_vocab USING fts5vocab(main,${index},'row'); CREATE VIRTUAL TABLE temp.${index}_instances USING fts5vocab(main,${index},'instance')`);
    const documents=sqlite.prepare(`SELECT count(*) AS n FROM ${index}`).get().n;
    const tokens=sqlite.prepare(`SELECT coalesce(sum(cnt),0) AS n FROM temp.${index}_vocab`).get().n;
    statistics[index]={documents,total_tokens:tokens,average_document_length:documents ? tokens/documents : null,terms:{}};
  }
  const queries=[];
  for (const item of fixture) {
    if (!item.query) continue;
    const query=searchQuery(item.category,{...item.search,keyword:item.query});
    const terms=JSON.parse(query.params.find(p => typeof p==='string' && p.startsWith('{"strict":')));
    const expressions=[terms.strict.prefix,terms.fallback?.prefix,terms.literalPrefix,terms.identityResidual].filter(Boolean);
    const quoted=expressions.flatMap(e => [...e.matchAll(/"([^"]+)"/g)].map(m => m[1]));
    sqlite.exec('DELETE FROM temp.diagnostic_tokens');
    sqlite.prepare('INSERT INTO temp.diagnostic_tokens(text) VALUES(?)').run([item.query,...quoted].join(' '));
    const tokens=sqlite.prepare('SELECT term FROM temp.diagnostic_token_vocab ORDER BY term').all().map(r => r.term);
    const index=ftsName(item.category);
    const stats=statistics[index];
    for (const token of tokens) if (!Object.hasOwn(stats.terms,token)) {
      const row=sqlite.prepare(`SELECT doc,cnt FROM temp.${index}_vocab WHERE term=?`).get(token);
      const prefix=sqlite.prepare(`SELECT count(DISTINCT doc) AS n FROM temp.${index}_instances WHERE term>=? AND term<?`).get(token,token+'\uffff').n;
      const df=row?.doc ?? 0;
      stats.terms[token]={document_frequency:df,occurrences:row?.cnt ?? 0,corpus_rate:stats.documents ? df/stats.documents : 0,
        prefix_document_frequency:prefix,unweighted_single_term_idf:Math.max(1e-6,Math.log((stats.documents-df+.5)/(df+.5)))};
    }
    queries.push({id:item.id,index,match_expressions:expressions,tokens});
  }
  return {method:'FTS5 unicode61 + fts5vocab(row/instance); document length sums all six columns, prefix DF unions distinct docs; IDF is explanatory, not a cross-corpus score comparison',statistics,queries};
}

export function storageStatistics(sqlite) {
  const schema=sqlite.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name').all();
  const indexes=categories.map(ftsName);
  const shadow = name => indexes.some(i => name.startsWith(i+'_'));
  const localShadow = name => name.startsWith('local_identifier_fts_');
  const pageSize=sqlite.prepare('PRAGMA page_size').get().page_size, pageCount=sqlite.prepare('PRAGMA page_count').get().page_count;
  const freelist=sqlite.prepare('PRAGMA freelist_count').get().freelist_count;
  const protectedTables={};
  for (const row of schema.filter(r => r.type==='table' && !indexes.includes(r.name) && !shadow(r.name)
    && r.name!=='local_identifier_fts' && !localShadow(r.name) && !r.name.startsWith('sqlite_') && !r.name.startsWith('_cf_'))) {
    const quoted=`"${row.name.replaceAll('"','""')}"`;
    const columns=sqlite.prepare(`PRAGMA table_info(${quoted})`).all().map(r => r.name);
    const hash=createHash('sha256'); let count=0;
    for (const data of sqlite.prepare(`SELECT * FROM ${quoted} ORDER BY ${columns.map(c => `"${c}"`).join(',')}`).iterate()) { hash.update(JSON.stringify(data)+'\n'); count++; }
    protectedTables[row.name]={count,sha256:hash.digest('hex')};
  }
  const projection=createHash('sha256');
  for (const row of sqlite.prepare(indexes.map(i => `SELECT rowid AS id,text,name,manufacturer,series,variant,family FROM ${i}`).join(' UNION ALL ')+' ORDER BY id').iterate()) projection.update(JSON.stringify(row)+'\n');
  let pages=null, dbstatError=null;
  try { pages=sqlite.prepare('SELECT name,sum(pgsize) AS bytes FROM dbstat GROUP BY name').all(); } catch(e) { dbstatError=e.message; }
  return {db_size_bytes:pageSize*pageCount,page_size:pageSize,freelist_bytes:freelist*pageSize,used_bytes:(pageCount-freelist)*pageSize,
    products:sqlite.prepare('SELECT count(*) AS n FROM products').get().n,identifiers:sqlite.prepare('SELECT count(*) AS n FROM identifiers').get().n,
    raw_bytes:sqlite.prepare('SELECT sum(length(CAST(raw_json AS BLOB))) AS n FROM upstream_raw').get().n,
    fts_count:indexes.length,fts_documents:Object.fromEntries(indexes.map(i => [i,sqlite.prepare(`SELECT count(*) AS n FROM ${i}`).get().n])),
    shadow_table_count:schema.filter(r => r.type==='table' && shadow(r.name)).length,
    all_fts_count:schema.filter(r => /USING fts5\(/i.test(r.sql ?? '')).length,
    sqlite_schema_entries:schema.length,fts_related_bytes:pages ? pages.filter(p => shadow(p.name) || indexes.includes(p.name)).reduce((n,p) => n+p.bytes,0) : null,dbstat_unavailable:dbstatError,
    max_create_trigger_bytes:Math.max(...schema.filter(r => r.type==='trigger').map(r => Buffer.byteLength(r.sql+';'))),
    non_fts_tables:protectedTables,fts_projection_sha256:projection.digest('hex')};
}
