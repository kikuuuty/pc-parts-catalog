// Frozen pre-optimization SQL compiler from 319f86c. Test oracle only.
// The unchanged input grammar/model helpers are shared; candidate/ranking SQL is not.
import { models } from '../src/model.js';
import { identifierKey } from '../src/normalize.js';
import { parseSearchIntent, specSeed } from '../src/search-intent.js';
import { searchTerms, keywordExpression } from '../src/queries.js';

export function searchBefore(category, { keyword, filters = {}, ranges = {}, facets = {}, identifier, limit = 20, orderBy, debug = false } = {}) {
  const model = models[category];
  const column = key => `${Object.hasOwn(model.fields, key) ? 's' : 'p'}.${key}`;
  const where = ['p.active=1', 'p.category=?'];
  const params = [category];
  for (const [key, raw] of Object.entries(filters)) {
    const values = Array.isArray(raw) ? raw : [raw];
    where.push(`${column(key)} IN (${values.map(() => '?').join(',')})`);
    params.push(...values);
  }
  for (const [key, range] of Object.entries(ranges)) for (const [bound, op] of [['min', '>='], ['max', '<=']]) {
    if (range[bound] === undefined) continue;
    where.push(`${column(key)}${op}?`); params.push(range[bound]);
  }
  for (const [attribute, raw] of Object.entries(facets)) {
    const values = Array.isArray(raw) ? raw : [raw];
    const hasTypedFilters = Object.keys(filters).length || Object.keys(ranges).length;
    where.push(hasTypedFilters
      ? `EXISTS (SELECT 1 FROM product_facets f WHERE f.product_id=p.id AND f.attribute=? AND f.value IN (${values.map(() => '?').join(',')}))`
      : `p.id IN (SELECT product_id FROM product_facets WHERE attribute=? AND value IN (${values.map(() => '?').join(',')}))`);
    params.push(attribute, ...values);
  }
  if (identifier) {
    where.push(`p.id IN (SELECT product_id FROM identifiers WHERE value_key=?${identifier.type ? ' AND type=?' : ''})`);
    params.push(identifierKey(identifier.value)); if (identifier.type) params.push(identifier.type);
  }
  let withSQL = '', from = `products p JOIN ${model.table} s ON s.product_id=p.id`, diagnostics = '';
  let predicates = where.join(' AND ');
  if (keyword !== undefined) {
    keywordExpression(keyword);
    const intent = parseSearchIntent(category, keyword), seed = specSeed(category, intent.specs);
    const boundedLexical = !intent.specOnly && !intent.identity && intent.specs.length >= 2 && !/\d/.test(intent.remaining) && seed;
    const terms = { ...searchTerms(intent.keyword), intent, name: keyword.normalize('NFKC').trim().toLowerCase() };
    if (boundedLexical) terms.literalPrefix = keywordExpression(intent.literal);
    terms.identifierKind = searchTerms(keyword).identifierKind;
    if (intent.identity?.residual) terms.identityResidual = keywordExpression(intent.identity.residual);
    let n = 0;
    const scoped = predicates.replaceAll('?', () => `?${++n}`);
    const input = `?${params.length + 1}`, key = `?${params.length + 2}`;
    params.push(JSON.stringify(terms), identifierKey(keyword));
    const value = path => `(SELECT json_extract(q,'$.${path}') FROM search_input)`;
    const fts = (mode, guard = '') => `SELECT rowid AS id,-bm25(product_fts,0.1,10,2,4,3,4) AS relevance
        FROM product_fts WHERE ${guard}product_fts MATCH ${value(mode === 'strict' && boundedLexical ? 'literalPrefix' : `${mode}.prefix`)}
      UNION ALL SELECT i.product_id,0 FROM local_identifier_fts JOIN local_identifiers i ON i.id=local_identifier_fts.rowid
        WHERE ${guard}local_identifier_fts MATCH ${value(mode === 'strict' && boundedLexical ? 'literalPrefix' : `${mode}.prefix`)}`;
    const candidates = (hits, mode) => `SELECT h.id,max(h.relevance) AS relevance,${mode} AS fallback
      FROM ${hits} h CROSS JOIN products p ON p.id=h.id CROSS JOIN ${model.table} s ON s.product_id=p.id
      WHERE ${scoped} GROUP BY h.id`;
    const matches = field => `p.id IN (SELECT rowid FROM product_fts WHERE product_fts MATCH
      ${terms.fallback ? `CASE WHEN NOT EXISTS (SELECT 1 FROM strict) THEN ${value(`fallback.${field}`)} ELSE ${value(`strict.${field}`)} END` : value(`strict.${field}`)})`;
    const specConditions = intent.specs.map((spec, i) => `s.${spec.field}=${value(`intent.specs[${i}].value`)}`);
    const identityCondition = intent.identity ? `s.chipset IN (SELECT value FROM json_each(${value('intent.identity.values')}))` : '0';
    const familyCondition = intent.family ? `s.family=${value('intent.family')}` : '0';
    const typed = intent.identity ? `UNION ALL SELECT s.product_id,0 FROM ${model.table} s WHERE ${identityCondition}
        ${intent.identity.residual ? `AND EXISTS (SELECT 1 FROM product_fts WHERE rowid=s.product_id AND product_fts MATCH ${value('identityResidual')})` : ''}`
      : (intent.specOnly || boundedLexical) && seed ? `UNION ALL SELECT id,0 FROM (
          SELECT s.product_id AS id FROM ${model.table} s CROSS JOIN products p ON p.id=s.product_id
          WHERE ${specConditions.join(' AND ')} AND ${scoped}
          ${boundedLexical ? `AND s.product_id IN (SELECT rowid FROM product_fts WHERE product_fts MATCH ${value('strict.prefix')})` : ''}
          ORDER BY ${seed.order.map(field => `s.${field}`).join(',')} LIMIT 256
        )` : '';
    const specScore = intent.specs.length ? `(${specConditions.map((condition, i) => `CASE WHEN ${condition} THEN 1.0 WHEN s.${intent.specs[i].field} IS NULL THEN 0.25 ELSE 0 END`).join('+')}) * ${12 / intent.specs.length}` : '0';
    const manufacturer = "lower(trim(replace(replace(coalesce(p.manufacturer,''),'.',' '),'!','')))";
    const manufacturerScore = `CASE WHEN length(${manufacturer})>0 AND instr(' '||${value('intent.remaining')}||' ',' '||${manufacturer}||' ')>0 THEN 2 ELSE 0 END`;
    const freshness = intent.family ? `CASE WHEN ${familyCondition} AND p.release_year IS NOT NULL THEN max(-0.05,min(0.05,(p.release_year-2022)*0.01)) ELSE 0 END` : '0';
    withSQL = `WITH search_input AS (SELECT ${input} AS q),
      exact_identifiers AS MATERIALIZED (
        SELECT DISTINCT product_id FROM identifiers WHERE value_key=${key} AND
          ((${value('identifierKind')}='mpn' AND type='mpn') OR
           (${value('identifierKind')}='barcode' AND type IN ('gtin','ean','upc','jan')))
      ),
      trusted_identifiers AS (SELECT product_id FROM exact_identifiers WHERE (SELECT count(*) FROM exact_identifiers)<=3),
      strict_fts AS MATERIALIZED (${fts('strict')}
        UNION ALL SELECT product_id,0 FROM trusted_identifiers ${typed}),
      strict AS MATERIALIZED (${candidates('strict_fts', 0)}),
      ${terms.fallback ? `fallback_fts AS MATERIALIZED (${fts('fallback', 'NOT EXISTS (SELECT 1 FROM strict) AND ')}),
      candidates AS (${candidates('fallback_fts', 1)} UNION ALL SELECT * FROM strict),` : 'candidates AS (SELECT * FROM strict),'}
      ranked AS MATERIALIZED (
        SELECT c.*, CASE
          WHEN c.fallback=0 AND p.id IN (SELECT product_id FROM trusted_identifiers) THEN 800
          WHEN lower(trim(p.name))=${value('name')} THEN 700
          ${intent.specOnly ? 'ELSE 600' : `WHEN ${identityCondition} OR ${familyCondition} THEN 675
          ${intent.specs.length ? `WHEN ${manufacturer}=${value('intent.remaining')} THEN 650` : ''}
          WHEN ${matches('namePhrase')} THEN 650
          WHEN ${matches('nameExact')} THEN 600
          WHEN ${matches('modelExact')} THEN 500
          WHEN ${matches('namePrefix')} THEN 400
          WHEN ${matches('familyExact')} THEN 300
          WHEN ${matches('fieldsExact')} THEN 200
          ELSE 100`} END AS tier,
          ${specScore} AS spec_score,${manufacturerScore} AS manufacturer_score,${freshness} AS freshness_score
        FROM candidates c CROSS JOIN products p ON p.id=c.id
        ${intent.specs.length || intent.identity || intent.family ? `CROSS JOIN ${model.table} s ON s.product_id=p.id` : ''}
      ), scored AS (
        SELECT *,tier + spec_score + manufacturer_score + freshness_score + relevance/(1+relevance) - fallback*1000 AS score,
          CASE WHEN fallback=1 THEN 'fallback' ${intent.specOnly ? "WHEN tier<700 THEN 'spec-intent'" : ''} ELSE CASE tier
            WHEN 800 THEN 'exact-identifier' WHEN 700 THEN 'exact-name' WHEN 675 THEN 'family-chipset'
            WHEN 650 THEN 'name-phrase' WHEN 600 THEN 'exact-name-tokens' WHEN 500 THEN 'exact-model'
            WHEN 400 THEN 'prefix-name' WHEN 300 THEN 'series-variant'
            WHEN 200 THEN 'field-tokens' ELSE 'fts' END END AS match_type FROM ranked
      ) `;
    from = `scored r CROSS JOIN products p ON p.id=r.id CROSS JOIN ${model.table} s ON s.product_id=p.id`;
    predicates = '1=1';
    if (debug) diagnostics = ',r.score AS search_score,r.match_type AS search_match,r.relevance AS search_fts_relevance,r.tier AS model_score,r.spec_score,r.manufacturer_score,r.freshness_score,r.fallback AS search_fallback';
  }
  const order = orderBy ? `${column(orderBy)},s.product_id` : keyword === undefined ? 'p.id' : 'r.score DESC,p.id';
  params.push(limit);
  return { sql: `${withSQL}SELECT p.id,p.upstream_id,p.upstream_key,p.category,p.manufacturer,p.name,p.series,p.variant,p.release_year,p.manufacturer_url,s.*${diagnostics} FROM ${from} WHERE ${predicates} ORDER BY ${order} LIMIT ?`, params };
}
