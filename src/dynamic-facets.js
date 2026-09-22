import { models } from './model.js';
import { filterRegistry, filterType } from './filter-schema.js';
import { scalarField } from './search-fields.js';
import { searchPredicate, typedSearchIndex } from './queries.js';
import { filterOptionValue, validFilterOption, FilterOptionLimitError, MAX_FILTER_OPTIONS } from './filter-metadata.js';

// A field's own predicates may occur in more than one target (e.g. a numeric
// selection + range, or scalar socket + legacy socket facet). Exclude all of
// them by field ID; retain every predicate on every other field.
export function excludeFacet(conditions, id) {
  return Object.fromEntries(['filters', 'ranges', 'facets'].map(target =>
    [target, Object.fromEntries(Object.entries(conditions[target] ?? {}).filter(([key]) => key !== id))]));
}

export function dynamicFacetQueries(category, conditions = {}) {
  // Validate ALL input first, including predicates that self-exclusion removes.
  searchPredicate(category, conditions);
  const definitions = filterRegistry[category].filter(d => d.control === 'multi_select');
  const selected = d => ['filters', 'ranges', 'facets'].some(target => Object.hasOwn(conditions[target] ?? {}, d.id));
  const unselected = definitions.filter(d => !selected(d));
  const groups = [
    ...(unselected.length ? [{ definitions: unselected, conditions }] : []),
    ...definitions.filter(selected).map(d => ({ definitions: [d], conditions: excludeFacet(conditions, d.id) })),
  ];
  return groups.map(group => {
    const model = models[category];
    const { where, params } = searchPredicate(category, group.conditions);
    const index = typedSearchIndex(category, group.conditions);
    const scalars = group.definitions.filter(d => d.target !== 'facets');
    const facets = group.definitions.filter(d => d.target === 'facets');
    const needsSpec = scalars.some(d => scalarField(model, d.id).column.startsWith('s.')) || where.some(w => /\bs\./.test(w));
    // Selective typed seeds use the search indexes. Otherwise constrain the
    // category first; facet-only predicates can use the reverse facets_value index.
    const from = index ? `${model.table} s INDEXED BY ${index} CROSS JOIN products p ON p.id=s.product_id`
      : `products p INDEXED BY products_category_manufacturer_series${needsSpec ? ` CROSS JOIN ${model.table} s ON s.product_id=p.id` : ''}`;
    const projection = scalars.map(d => {
      const { column, type } = scalarField(model, d.id);
      return `${filterOptionValue(column, type)} AS ${d.id}`;
    });
    const branches = [];
    // Compress repeated scalar tuples BEFORE unpivoting: manufacturer-only
    // self-exclusion expands a handful of brands, not every catalog product.
    if (scalars.length) branches.push(`SELECT j.key AS field,j.value,g.n FROM (SELECT ${scalars.map(d => d.id).join(',')},count(*) AS n FROM candidates GROUP BY ${scalars.map(d => d.id).join(',')}) g CROSS JOIN json_each(json_object(${scalars.map(d => `'${d.id}',g.${d.id}`).join(',')})) j WHERE j.value IS NOT NULL`);
    if (facets.length) {
      branches.push(`SELECT f.attribute AS field,f.value,1 AS n FROM candidates c CROSS JOIN product_facets f ON f.product_id=c.id WHERE +f.attribute IN (${facets.map(() => '?').join(',')}) AND ${filterOptionValue('f.value', 'TEXT')} IS NOT NULL`);
      params.push(...facets.map(d => d.id));
    }
    if (params.length > 100) throw new Error('D1 supports at most 100 bound parameters');
    // Only mixed scalar/multivalue groups reuse candidates. NOT MATERIALIZED
    // lets scalar-only requests aggregate directly from the indexed traversal.
    // product_facets PK(product_id,attribute,value) makes counts product counts,
    // even when several selected values match the same product.
    return {
      sql: `WITH candidates AS ${branches.length > 1 ? 'MATERIALIZED' : 'NOT MATERIALIZED'} (SELECT p.id${projection.length ? ',' + projection.join(',') : ''} FROM ${from} WHERE ${where.join(' AND ')}),
        options AS (${branches.join(' UNION ALL ')}) SELECT field,value,sum(n) AS count FROM options GROUP BY field,value`,
      params,
    };
  });
}

export async function loadDynamicFacets(executeBatch, category, conditions = {}) {
  const queries = dynamicFacetQueries(category, conditions);
  const definitions = filterRegistry[category].filter(d => d.control === 'multi_select');
  const facets = Object.fromEntries(definitions.map(d => [d.id, { options: [] }]));
  for (const rows of await executeBatch(queries)) for (const { field, value, count } of rows) {
    facets[field].options.push({ value, count });
  }
  for (const d of definitions) {
    // HTTP strings use JS UTF-16 length/whitespace rules, not SQLite's Unicode
    // length/ASCII trim. Match static metadata exactly at the response boundary.
    const options = facets[d.id].options.filter(o => validFilterOption(o.value, filterType(category, d)));
    if (options.length > MAX_FILTER_OPTIONS) throw new FilterOptionLimitError(category, d.id, options.length);
    options.sort((a, b) => a.value < b.value ? -1 : a.value > b.value ? 1 : 0);
    facets[d.id].options = options.map(({ value, count }) => ({ value, label: d.optionLabels?.[value] ?? String(value), count }));
  }
  return { category, facets };
}
