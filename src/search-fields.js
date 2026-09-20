// Explicit common search allowlist. Spec fields take precedence (CPU manufacturer).
export const commonSearchFields = Object.freeze({ name: 'TEXT', manufacturer: 'TEXT', series: 'TEXT', variant: 'TEXT', release_year: 'INTEGER' });
export function scalarField(model, id) {
  if (Object.hasOwn(model.fields, id)) return { type: model.fields[id], column: `s.${id}` };
  if (Object.hasOwn(commonSearchFields, id)) return { type: commonSearchFields[id], column: `p.${id}` };
  throw new Error(`Unknown scalar field: ${id}`);
}
