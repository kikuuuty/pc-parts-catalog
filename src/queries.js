import { models, ftsName } from './model.js';
import { identifierKey } from './normalize.js';
import { parseSearchIntent, specSeed } from './search-intent.js';

const common = { name: 'TEXT', manufacturer: 'TEXT', series: 'TEXT', variant: 'TEXT', release_year: 'INTEGER' };
const productColumns = ['id', 'upstream_id', 'upstream_key', 'category', 'manufacturer', 'name', 'series', 'variant', 'release_year', 'manufacturer_url'];
const productProjection = `${productColumns.map(field => `p.${field}`).join(',')},s.*`;
// Immutable schema-derived SQL fragments, not a query/result cache. Reuse them
// even on cache HIT validation instead of rebuilding dozens of aliases per call.
const searchColumns = Object.fromEntries(Object.entries(models).map(([category, model]) => {
  const specColumns = ['product_id', ...Object.keys(model.fields)];
  return [category, {
    carried: [...productColumns.map(field => `p.${field} AS _p_${field}`),
      ...specColumns.map(field => `s.${field} AS _s_${field}`)].join(','),
    projection: [...productColumns.map(field => `r._p_${field} AS ${field}`),
      ...specColumns.map(field => `r._s_${field} AS ${field}`)].join(','),
  }];
}));
function keywordTokens(value) {
  if (typeof value !== 'string' || value.length > 200) throw new Error('Keyword must be at most 200 characters');
  const tokens = value.normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!tokens.length || tokens.length > 12) throw new Error('Keyword needs 1–12 letter/number tokens');
  return tokens;
}

// Deliberately bounded model grammar: long digit run plus short ASCII affixes.
// Natural-language words, one-digit family numbers and arbitrary MPNs are not compacted.
const modelToken = t => /^(?:[a-z]{1,5}\d{3,5}(?:[a-z][a-z0-9]{0,3})?|\d{3,5}[a-z][a-z0-9]{0,3})$/i.test(t);
function modelForms(token) {
  if (!modelToken(token)) return [token];
  // Split only beside the main digit run, keeping suffixes such as X3D intact.
  const [,head,digits,tail] = token.match(/^([a-z]*)(\d{3,5})(.*)$/i);
  return [...new Set([token, `${head} ${digits}${tail}`.trim(), `${head}${digits} ${tail}`.trim(), `${head} ${digits} ${tail}`.trim()])];
}
function expressionFor(tokens, prefix = true) {
  const term = value => `"${value}"${prefix && !/^\d$/.test(value) ? '*' : ''}`;
  const single = token => modelForms(token).map(term);
  const parts = [];
  // Non-overlapping, longest model groups keep expansion linear in query length.
  // Every branch retains all input tokens; only the alternate model spelling is ORed.
  for (let start = 0; start < tokens.length;) {
    let width = 1;
    for (let size = 1; size <= 3 && start+size <= tokens.length; size++) {
      const group = tokens.slice(start,start+size);
      const compact = group.join('');
      if (size > 1 && (!modelToken(compact) || !group.every(t => /^[a-z0-9]+$/i.test(t)) ||
          !group.some(t => /\d{3,5}/.test(t)) || group.some(t => /^\d$/.test(t)) ||
          group.slice(1).some((t,i) => /[a-z]/i.test(group[i].at(-1)) === /[a-z]/i.test(t[0])))) continue;
      width = size;
    }
    const group = tokens.slice(start,start+width);
    const raw = group.map(t => {
      const forms = single(t);
      return forms.length === 1 ? forms[0] : `(${forms.join(' OR ')})`;
    }).join(' AND ');
    const alternatives = [...new Set([raw,...(width > 1 ? single(group.join('')) : [])])];
    parts.push(alternatives.length === 1 ? raw : `(${alternatives.map(a => `(${a})`).join(' OR ')})`);
    start += width;
  }
  return parts.join(' AND ');
}
export function keywordExpression(value) {
  return expressionFor(keywordTokens(value));
}
export function searchTerms(value) {
  const tokens = keywordTokens(value);
  const describe = terms => {
    const exact = expressionFor(terms, false);
    const prefix = expressionFor(terms);
    const models = terms.filter(t => modelToken(t) || /^\d{3,5}$/.test(t));
    const compact = terms.join('');
    const phrases = terms.length <= 3 && modelToken(compact)
      && !terms.slice(1).some((t,i) => /[a-z]/i.test(terms[i].at(-1)) === /[a-z]/i.test(t[0]))
      ? modelForms(compact) : [terms.join(' ')];
    return {
      prefix, nameExact: `name : (${exact})`, namePrefix: `name : (${prefix})`,
      namePhrase: `name : (${phrases.map(t => `"${t}"`).join(' OR ')})`,
      modelExact: `name : (${expressionFor(models.length ? models : terms, false)})`,
      familyExact: `{series variant family} : (${exact})`,
      fieldsExact: `{name manufacturer series variant family} : (${exact})`,
    };
  };
  const removable = tokens.filter(t => /^[a-z]$/i.test(t));
  const remaining = tokens.filter(t => !/^[a-z]$/i.test(t));
  const letterIndex = tokens.findIndex(t => /^[a-z]$/i.test(t));
  const modelAdjacent = [tokens[letterIndex-1],tokens[letterIndex+1]].some(t => t && /\d/.test(t));
  // At most one isolated letter, at least three remaining anchors, including a
  // model number. Never drop a digit, model suffix, or meaningful multi-letter word.
  const fallback = removable.length === 1 && !modelAdjacent && remaining.length >= 3 && remaining.some(t => /\d{3,5}/.test(t))
    ? { ...describe(remaining), dropped: removable[0] } : null;
  const key = identifierKey(value);
  const identifierKind = /^[0-9]+$/.test(key) && [8,12,13,14].includes(key.length) ? 'barcode'
    : key.replace(/[^A-Z0-9]/g,'').length >= 5 && /[A-Z]/.test(key) && /[0-9]/.test(key) ? 'mpn' : null;
  return { strict: describe(tokens), fallback, identifierKind, name: value.normalize('NFKC').trim().toLowerCase() };
}

export function searchQuery(category, { keyword, filters = {}, ranges = {}, facets = {}, identifier, limit = 20, orderBy, debug = false } = {}) {
  if (typeof category !== 'string' || !Object.hasOwn(models, category)) throw new Error(`Unknown category: ${category}`);
  const model = models[category];
  const index = ftsName(category);
  if (orderBy === 'relevance') orderBy = undefined;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be 1–100');
  const fields = { ...common, ...model.fields };
  const column = key => {
    if (!Object.hasOwn(fields, key)) throw new Error(`Unknown ${category} filter: ${key}`);
    return `${Object.hasOwn(model.fields, key) ? 's' : 'p'}.${key}`;
  };
  const where = ['p.active=1', 'p.category=?'];
  const params = [category];
  for (const [key, raw] of Object.entries(filters)) {
    const col = column(key);
    const values = Array.isArray(raw) ? raw : [raw];
    if (!values.length || values.length > 20) throw new Error('Each selection needs 1–20 values');
    for (const value of values) {
      if (fields[key] === 'TEXT' ? typeof value !== 'string' || !value.length : typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid value for ${key}`);
    }
    where.push(`${col} IN (${values.map(() => '?').join(',')})`);
    params.push(...values);
  }
  for (const [key, range] of Object.entries(ranges)) {
    const col = column(key);
    if (fields[key] === 'TEXT' || !range || typeof range !== 'object' || Array.isArray(range) || Object.keys(range).some(k => !['min','max'].includes(k))) throw new Error(`Invalid range: ${key}`);
    if (range.min === undefined && range.max === undefined) throw new Error(`Empty range: ${key}`);
    if (range.min !== undefined && range.max !== undefined && range.min > range.max) throw new Error(`min > max: ${key}`);
    for (const [bound, op] of [['min', '>='], ['max', '<=']]) {
      if (range[bound] === undefined) continue;
      if (typeof range[bound] !== 'number' || !Number.isFinite(range[bound])) throw new Error(`Invalid range value: ${key}`);
      where.push(`${col}${op}?`);
      params.push(range[bound]);
    }
  }
  for (const [attribute, raw] of Object.entries(facets)) {
    if (!model.facets.includes(attribute)) throw new Error('Unknown facet');
    const values = Array.isArray(raw) ? raw : [raw];
    if (!values.length || values.length > 20 || values.some(v => typeof v !== 'string' || !v.length)) throw new Error('Invalid facet values');
    // With selective typed filters, probe a candidate product's small facet set.
    // With facets alone, allow the reverse facet index to supply candidate IDs.
    const hasTypedFilters = Object.keys(filters).length || Object.keys(ranges).length;
    where.push(hasTypedFilters
      ? `EXISTS (SELECT 1 FROM product_facets f WHERE f.product_id=p.id AND f.attribute=? AND f.value IN (${values.map(() => '?').join(',')}))`
      : `p.id IN (SELECT product_id FROM product_facets WHERE attribute=? AND value IN (${values.map(() => '?').join(',')}))`);
    params.push(attribute, ...values);
  }
  if (identifier) {
    if (typeof identifier.value !== 'string' || !identifier.value.trim() || (identifier.type && !['mpn','gtin','ean','upc','jan'].includes(identifier.type))) throw new Error('Invalid identifier');
    where.push(`p.id IN (SELECT product_id FROM identifiers WHERE value_key=?${identifier.type ? ' AND type=?' : ''})`);
    params.push(identifierKey(identifier.value));
    if (identifier.type) params.push(identifier.type);
  }
  let withSQL = '';
  let from = `products p JOIN ${model.table} s ON s.product_id=p.id`;
  // Models with an order-leading index can stream a filtered sort before PK
  // product/facet probes. This avoids fresh-statistics category-first sorting.
  if (model.indexedOrderFirst && orderBy && (Object.hasOwn(filters, orderBy) || Object.hasOwn(ranges, orderBy))
      && Object.values(model.indexes).some(columns => columns[0] === orderBy)) {
    from = `${model.table} s CROSS JOIN products p ON p.id=s.product_id`;
  }
  let diagnostics = '';
  let projection = productProjection;
  let order = orderBy ? `${column(orderBy)},s.product_id` : 'p.id';
  let predicates = where.join(' AND ');
  if (keyword !== undefined) {
    keywordTokens(keyword); // Validate the original input before consuming semantic tokens.
    const intent = parseSearchIntent(category,keyword);
    const seed=specSeed(category,intent.specs);
    // A manufacturer/family word plus several specs can otherwise expand to
    // thousands of brand-only hits. Keep literal recall, adding a bounded indexed
    // spec+lexical path instead. Digit-bearing model anchors remain unrestricted.
    const boundedLexical = !intent.specOnly && !intent.identity && intent.specs.length>=2 && !/\d/.test(intent.remaining) && seed;
    const terms = {...searchTerms(intent.keyword),intent,name:keyword.normalize('NFKC').trim().toLowerCase()};
    if (boundedLexical) terms.literalPrefix=keywordExpression(intent.literal);
    // Exact identifiers always use the unconsumed input and Phase 1 trust rules.
    terms.identifierKind = searchTerms(keyword).identifierKind;
    if (intent.identity?.residual) terms.identityResidual = keywordExpression(intent.identity.residual);
    // Two binds regardless of token/fallback count. Numbered references let strict
    // and fallback share all filters without duplicating the 100-bind budget.
    let n = 0;
    const scoped = predicates.replaceAll('?', () => `?${++n}`);
    const input = `?${params.length+1}`;
    const key = `?${params.length+2}`;
    params.push(JSON.stringify(terms), identifierKey(keyword));
    const value = path => `(SELECT json_extract(q,'$.${path}') FROM search_input)`;
    const fts = (mode, guard = '') => `SELECT rowid AS id,-bm25(${index},0.1,10,2,4,3,4) AS relevance
        FROM ${index} WHERE ${guard}${index} MATCH ${value(mode==='strict' && boundedLexical ? 'literalPrefix' : `${mode}.prefix`)}
      UNION ALL SELECT i.product_id,0 FROM local_identifier_fts JOIN local_identifiers i ON i.id=local_identifier_fts.rowid
        WHERE ${guard}local_identifier_fts MATCH ${value(mode==='strict' && boundedLexical ? 'literalPrefix' : `${mode}.prefix`)}`;
    // Both joins are PK lookups: each hit ID determines exactly one product/spec
    // row. Deduplicate narrow hits first, then fetch those columns only once
    // for scope, ranking and results. Separate aliases
    // preserve common/spec name collisions (notably CPU manufacturer).
    const { carried } = searchColumns[category];
    const rankColumns = sql => sql.replace(/\bp\.([a-z_]+)/g, 'c._p_$1').replace(/\bs\.([a-z_]+)/g, 'c._s_$1');
    const candidates = (hits, mode) => `SELECT h.id,h.relevance,${mode} AS fallback,${carried}
      FROM (SELECT id,max(relevance) AS relevance FROM ${hits} GROUP BY id) h
      CROSS JOIN products p ON p.id=h.id CROSS JOIN ${model.table} s ON s.product_id=p.id
      WHERE ${scoped}`;
    const matches = field => `p.id IN (SELECT rowid FROM ${index} WHERE ${index} MATCH
      ${terms.fallback ? `CASE WHEN NOT EXISTS (SELECT 1 FROM strict) THEN ${value(`fallback.${field}`)} ELSE ${value(`strict.${field}`)} END` : value(`strict.${field}`)})`;
    // CASE is first-match wins. A later identical MATCH predicate is unreachable
    // after an earlier false result; keep only the first (highest-priority) tier.
    // Both strict and fallback expressions must agree before a clause is folded.
    const seenMatches = new Set();
    const matchTiers = intent.specOnly ? '' : [['namePhrase', 650], ['nameExact', 600], ['modelExact', 500],
      ['namePrefix', 400], ['familyExact', 300], ['fieldsExact', 200]].flatMap(([field, tier]) => {
      const signature = JSON.stringify([terms.strict[field], terms.fallback?.[field] ?? null]);
      if (seenMatches.has(signature)) return [];
      seenMatches.add(signature);
      return [`WHEN ${matches(field)} THEN ${tier}`];
    }).join('\n          ');
    const specConditions = intent.specs.map((spec,i) => `s.${spec.field}=${value(`intent.specs[${i}].value`)}`);
    const identityCondition = intent.identity ? `s.chipset IN (SELECT value FROM json_each(${value('intent.identity.values')}))` : '0';
    const familyCondition = intent.family ? `s.family=${value('intent.family')}` : '0';
    const typed = intent.identity ? `UNION ALL SELECT s.product_id,0 FROM ${model.table} s WHERE ${identityCondition}
        ${intent.identity.residual ? `AND EXISTS (SELECT 1 FROM ${index} WHERE rowid=s.product_id AND ${index} MATCH ${value('identityResidual')})` : ''}`
      : (intent.specOnly || boundedLexical) && seed ? `UNION ALL SELECT id,0 FROM (
          SELECT s.product_id AS id FROM ${model.table} s CROSS JOIN products p ON p.id=s.product_id
          WHERE ${specConditions.join(' AND ')} AND ${scoped}
          ${boundedLexical ? `AND s.product_id IN (SELECT rowid FROM ${index} WHERE ${index} MATCH ${value('strict.prefix')})` : ''}
          ORDER BY ${seed.order.map(field=>`s.${field}`).join(',')} LIMIT 256
        )` : '';
    const specScore = intent.specs.length ? `(${specConditions.map((condition,i) => `CASE WHEN ${condition} THEN 1.0 WHEN s.${intent.specs[i].field} IS NULL THEN 0.25 ELSE 0 END`).join('+')}) * ${12/intent.specs.length}` : '0';
    const manufacturer = "lower(trim(replace(replace(coalesce(p.manufacturer,''),'.',' '),'!','')))";
    const manufacturerScore = `CASE WHEN length(${manufacturer})>0 AND instr(' '||${value('intent.remaining')}||' ',' '||${manufacturer}||' ')>0 THEN 2 ELSE 0 END`;
    // NULL is neutral, not an old year. A fixed reference makes same-DB ordering
    // independent of wall-clock time. Only recognized CPU family queries opt in.
    const freshness = intent.family ? `CASE WHEN ${familyCondition} AND p.release_year IS NOT NULL THEN max(-0.05,min(0.05,(p.release_year-2022)*0.01)) ELSE 0 END` : '0';
    // identifierKind is already derived from the unchanged input grammar. An
    // ineligible shape cannot produce a trusted identifier; avoid opening that
    // view at all. Keep the key parameter slot even in the empty branch.
    const exactIdentifiers = terms.identifierKind ? `SELECT DISTINCT product_id FROM identifiers WHERE value_key=${key} AND
      ${terms.identifierKind === 'mpn' ? "type='mpn'" : "type IN ('gtin','ean','upc','jan')"}
      AND EXISTS (SELECT 1 FROM ${index} WHERE rowid=identifiers.product_id)`
      : `SELECT NULL AS product_id WHERE 0 AND ${key} IS NULL`;
    const ranking = rankColumns(`SELECT c.*, CASE
          WHEN c.fallback=0 AND p.id IN (SELECT product_id FROM trusted_identifiers) THEN 800
          WHEN lower(trim(p.name))=${value('name')} THEN 700
          ${intent.specOnly ? 'ELSE 600' : `WHEN ${identityCondition} OR ${familyCondition} THEN 675
          ${intent.specs.length ? `WHEN ${manufacturer}=${value('intent.remaining')} THEN 650` : ''}
          ${matchTiers}
          ELSE 100`} END AS tier,
          ${specScore} AS spec_score,${manufacturerScore} AS manufacturer_score,${freshness} AS freshness_score
        FROM candidates c`);
    withSQL = `WITH search_input AS (SELECT ${input} AS q),
      exact_identifiers AS MATERIALIZED (${exactIdentifiers}),
      trusted_identifiers AS (SELECT product_id FROM exact_identifiers WHERE (SELECT count(*) FROM exact_identifiers)<=3),
      strict_fts AS NOT MATERIALIZED (${fts('strict')}
        UNION ALL SELECT product_id,0 FROM trusted_identifiers ${typed}),
      strict AS ${terms.fallback ? 'MATERIALIZED' : 'NOT MATERIALIZED'} (${candidates('strict_fts',0)}),
      ${terms.fallback ? `fallback_fts AS NOT MATERIALIZED (${fts('fallback','NOT EXISTS (SELECT 1 FROM strict) AND ')}),
      candidates AS (${candidates('fallback_fts',1)} UNION ALL SELECT * FROM strict),` : 'candidates AS (SELECT * FROM strict),'}
      ranked AS ${debug ? 'MATERIALIZED' : 'NOT MATERIALIZED'} (${ranking}), scored AS (
        SELECT *,tier + spec_score + manufacturer_score + freshness_score + relevance/(1+relevance) - fallback*1000 AS score,
          CASE WHEN fallback=1 THEN 'fallback' ${intent.specOnly ? "WHEN tier<700 THEN 'spec-intent'" : ''} ELSE CASE tier
            WHEN 800 THEN 'exact-identifier' WHEN 700 THEN 'exact-name' WHEN 675 THEN 'family-chipset'
            WHEN 650 THEN 'name-phrase' WHEN 600 THEN 'exact-name-tokens' WHEN 500 THEN 'exact-model'
            WHEN 400 THEN 'prefix-name' WHEN 300 THEN 'series-variant'
            WHEN 200 THEN 'field-tokens' ELSE 'fts' END END AS match_type FROM ranked
      ) `;
    // GROUP BY keeps FTS bm25 evaluation inside the hit co-routine. Only fallback
    // needs to reuse strict, and debug needs to reuse ranking across output fields.
    // The public path evaluates ranking once for ORDER BY, without a ranked spool.
    from = 'scored r';
    projection = searchColumns[category].projection;
    order = orderBy ? `${column(orderBy).replace(/^([ps])\./, 'r._$1_')},r._s_product_id` : 'r.score DESC,r.id';
    predicates = '1=1'; // Scope was applied before the strict-empty/fallback decision.
    if (debug) diagnostics = ',r.score AS search_score,r.match_type AS search_match,r.relevance AS search_fts_relevance,r.tier AS model_score,r.spec_score,r.manufacturer_score,r.freshness_score,r.fallback AS search_fallback';
  }
  params.push(limit);
  if (params.length > 100) throw new Error('D1 supports at most 100 bound parameters');
  return {
    sql: `${withSQL}SELECT ${projection}${diagnostics} FROM ${from} WHERE ${predicates} ORDER BY ${order} LIMIT ?`,
    params,
  };
}

export const representativeQueries = [
  { name: '1 CPU Intel Core i7', category: 'cpu', options: { filters: { manufacturer: 'Intel', family: 'Core i7' }, orderBy: 'core_count' }, indexes: ['cpu_family_cores'] },
  { name: '2 CPU AMD Ryzen 7 cores >=8', category: 'cpu', options: { filters: { manufacturer: 'AMD', family: 'Ryzen 7' }, ranges: { core_count: { min: 8 } }, orderBy: 'core_count' }, indexes: ['cpu_family_cores'] },
  { name: '3 GPU NVIDIA VRAM >=16 length <=320', category: 'gpu', options: { filters: { chip_vendor: 'NVIDIA' }, ranges: { vram_gb: { min: 16 }, length_mm: { max: 320 } }, orderBy: 'vram_gb' }, indexes: ['gpu_vendor_vram'] },
  { name: '4 RAM DDR5 capacity >=32 speed >=6000', category: 'memory', options: { filters: { ram_type: 'DDR5' }, ranges: { capacity_gb: { min: 32 }, speed: { min: 6000 } }, orderBy: 'speed' }, indexes: ['memory_type_speed'] },
  { name: '5 PSU ATX >=850W', category: 'psu', options: { filters: { form_factor: 'ATX' }, ranges: { wattage: { min: 850 } }, orderBy: 'wattage' }, indexes: ['psu_form_wattage'] },
  { name: '6 Case GPU clearance >=350', category: 'case', options: { ranges: { max_gpu_length_mm: { min: 350 } }, orderBy: 'max_gpu_length_mm' }, indexes: ['case_gpu_clearance'] },
  { name: '7 MPN exact', category: 'cpu', options: { identifier: { type: 'mpn', value: 'BX80768285K' } }, indexes: ['upstream_identifier_exact','local_identifier_exact'] },
  { name: '8 Keyword RTX 5080 + GPU filters', category: 'gpu', options: { keyword: 'RTX 5080', filters: { chip_vendor: 'NVIDIA' }, ranges: { length_mm: { min: 250, max: 320 } } }, indexes: ['VIRTUAL TABLE INDEX'] },
  { name: '9 Storage capacity + PCIe gen', category: 'storage', options: { filters: { storage_type: 'SSD' }, ranges: { capacity_gb: { min: 1000 }, pcie_generation: { min: 4 } }, orderBy: 'capacity_gb' }, indexes: ['storage_type_capacity'] },
  { name: '10 Fan size + airflow + noise', category: 'case_fan', options: { filters: { size_mm: 120 }, ranges: { airflow_max_cfm: { min: 60 }, noise_max_db: { max: 25 } }, orderBy: 'airflow_max_cfm' }, indexes: ['fan_size_airflow'] },
  { name: '11 Cooler air + height + socket', category: 'cpu_cooler', options: { filters: { water_cooled: 0 }, ranges: { height_mm: { max: 160 } }, facets: { socket: 'AM5' }, orderBy: 'height_mm' }, indexes: ['cooler_type_height'] },
  { name: '12 Cooler socket facet', category: 'cpu_cooler', options: { facets: { socket: 'AM5' } }, indexes: ['facets_value'] },
  { name: '13 Exact model relevance', category: 'cpu', options: { keyword: '14900k' }, indexes: ['VIRTUAL TABLE INDEX'] },
  { name: '14 Compact model', category: 'storage', options: { keyword: '990pro' }, indexes: ['VIRTUAL TABLE INDEX'] },
  { name: '15 Short family token', category: 'cpu', options: { keyword: 'ryzen 7' }, indexes: ['VIRTUAL TABLE INDEX'] },
  { name: '16 Controlled fallback', category: 'gpu', options: { keyword: 'gaming x trio 5080' }, indexes: ['VIRTUAL TABLE INDEX'] },
  { name: '17 Keyword identifier boost', category: 'cpu', options: { keyword: 'BX80768285K' }, indexes: ['upstream_identifier_exact','local_identifier_exact'] },
  { name: '18 Memory combined specifications', category: 'memory', options: { keyword:'ddr5 6000 cl30 32gb' }, indexes:['memory_search_speed'] },
  { name: '19 Memory transfer rate', category: 'memory', options: { keyword:'6000mt/s' }, indexes:['memory_search_speed'] },
  { name: '20 Motherboard chipset and wifi', category: 'motherboard', options: { keyword:'b650e wifi' }, indexes:['motherboard_search_chipset'] },
  { name: '21 Motherboard socket and form', category: 'motherboard', options: { keyword:'am5 atx' }, indexes:['motherboard_socket_memory'] },
  { name: '22 PSU spec-only', category: 'psu', options: { keyword:'850w gold' }, indexes:['psu_wattage'] },
  { name: '23 Cooler fan diameter', category: 'cpu_cooler', options: { keyword:'120mm air cooler' }, indexes:['cooler_search_fan'] },
  { name: '24 Cooler radiator diameter', category: 'cpu_cooler', options: { keyword:'360mm aio' }, indexes:['cooler_radiator'] },
  { name: '25 Case fan size PWM', category: 'case_fan', options: { keyword:'120mm pwm' }, indexes:['fan_size_airflow'] },
  { name: '26 Storage NVMe capacity', category: 'storage', options: { keyword:'nvme 2tb' }, indexes:['storage_capacity'] },
  { name: '27 Memory type only', category: 'memory', options: { keyword:'ddr5' }, indexes:['memory_type_speed'] },
  { name: '28 Memory total capacity', category: 'memory', options: { keyword:'ddr5 32gb' }, indexes:['memory_search_capacity'] },
  { name: '29 Memory broad type and speed', category: 'memory', options: { keyword: 'ddr5 6000' }, indexes: ['memory_search_speed'] },
  { name: '30 Memory bare numeric token', category: 'memory', options: { keyword: '6000' }, indexes: ['VIRTUAL TABLE INDEX'] },
  { name: '31 Memory capacity only', category: 'memory', options: { keyword: '32gb' }, indexes: ['memory_search_capacity'] },
  { name: '32 GPU broad family word', category: 'gpu', options: { keyword: 'geforce' }, indexes: ['VIRTUAL TABLE INDEX'] },
  { name: '33 CPU manufacturer across FTS categories', category: 'cpu', options: { keyword: 'intel' }, indexes: ['VIRTUAL TABLE INDEX'] },
  { name: '34 PSU unindexed spec intent', category: 'psu', options: { keyword: 'gold' }, indexes: ['VIRTUAL TABLE INDEX'] },
  { name: '35 Storage unindexed spec intent', category: 'storage', options: { keyword: 'nvme' }, indexes: ['VIRTUAL TABLE INDEX'] },
  { name: '36 Case broad form factor word', category: 'case', options: { keyword: 'atx' }, indexes: ['VIRTUAL TABLE INDEX'] },
  { name: '37 Memory category listing', category: 'memory', options: {}, indexes: [] },
  { name: '38 Monitor resolution and refresh', category: 'monitor', options: { filters: { resolution_width: 2560, resolution_height: 1440 }, ranges: { refresh_rate_hz: { min: 144 } }, orderBy: 'refresh_rate_hz' }, indexes: ['monitor_resolution_refresh'] },
  { name: '39 Keyboard size and switch', category: 'keyboard', options: { filters: { size: '75%', switch_type: 'Linear' } }, indexes: ['keyboard_size_switch'] },
  { name: '40 Mouse shape and weight', category: 'mouse', options: { filters: { shape: 'Ergonomic' }, ranges: { weight_g: { max: 70 } }, orderBy: 'weight_g' }, indexes: ['mouse_shape_weight'] },
  { name: '41 Headphones acoustic type', category: 'headphones', options: { filters: { headphone_type: 'Closed-Back' }, orderBy: 'weight_g' }, indexes: ['headphones_type_weight'] },
  { name: '42 Webcam resolution and FPS', category: 'webcam', options: { filters: { resolution: '4k' }, ranges: { frame_rate_fps: { min: 30 } }, orderBy: 'frame_rate_fps' }, indexes: ['webcam_resolution_fps'] },
  { name: '43 Microphone multi-valued connectivity', category: 'microphone', options: { facets: { connectivity_type: 'XLR' } }, indexes: ['facets_value'] },
  { name: '44 Network card basic FTS', category: 'network_card', options: { keyword: 'Intel' }, indexes: ['VIRTUAL TABLE INDEX'] },
  { name: '45 Keyboard connectivity facet and polling range', category: 'keyboard', options: { ranges: { polling_rate_hz: { min: 1000 } }, facets: { connectivity: 'Bluetooth' }, orderBy: 'polling_rate_hz' }, indexes: ['keyboard_polling'] },
];

export function hasCatalogFullScan(details) {
  const names = ['p', 's', 'products', ...Object.values(models).map(model => model.table)].join('|');
  return details.some(detail => new RegExp(`^SCAN (?:${names})(?:$| )`).test(detail));
}

export async function verifyPlans(db) {
  const reports = [];
  for (const q of representativeQueries) {
    const { sql, params } = searchQuery(q.category, q.options);
    const plan = await db.query(`EXPLAIN QUERY PLAN ${sql}`, params);
    const details = plan.results.map(r => r.detail);
    const rows = await db.query(sql, params);
    const fullScan = hasCatalogFullScan(details);
    const used = q.indexes.every(index => details.some(d => d.includes(index))) && !fullScan;
    reports.push({ name: q.name, sql, params, plan: details, index_check: used, catalog_full_scan: fullScan, returned: rows.results.length, meta: rows.meta });
  }
  return reports;
}
