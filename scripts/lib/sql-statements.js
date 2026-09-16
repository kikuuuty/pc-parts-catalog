// SQL-size diagnostics need statement boundaries, not naive semicolon splitting:
// trigger bodies, CASE ... END, strings and comments may contain semicolons.
export function splitSqlStatements(sql) {
  const tokens=sql.match(/--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[A-Za-z_]+|[^A-Za-z_]/g) ?? [];
  const statements=[]; let text='',header=[],trigger=false,depth=0;
  for (const token of tokens) {
    text+=token;
    if (/^--|^\/\*|^\s+$/.test(token)) continue;
    const word=token.toUpperCase();
    if (header.length<4 && /^[A-Z_]+$/.test(word)) {header.push(word);trigger=header[0]==='CREATE' && header.includes('TRIGGER');}
    if (trigger && ['BEGIN','CASE'].includes(word)) depth++;
    if (trigger && word==='END') depth--;
    if (token===';' && depth===0) {statements.push(text.trim());text='';header=[];trigger=false;}
  }
  if (text.trim() && !/^\s*(?:--[^\n]*(?:\n|$)|\s)*$/.test(text)) statements.push(text.trim());
  return statements;
}
