// Diagnostic corpus, independent of Golden expected and runtime classification.
export const broadQueries = Object.entries({
  memory: ['ddr5', 'ddr5 32gb', '6000', 'ddr5 6000', '32gb'],
  gpu: ['rtx 5080', '5070 ti', 'radeon', 'geforce'],
  cpu: ['ryzen 7', 'ryzen 9', 'intel', 'amd'],
  motherboard: ['b650', 'b650e', 'x870e', 'z890', 'am5'],
  psu: ['850w', '1000w', 'gold', '850w gold'],
  cpu_cooler: ['360mm aio', '120mm air cooler'],
  storage: ['nvme', '2tb', 'nvme 2tb'],
  case: ['atx'], case_fan: ['120mm pwm'],
}).flatMap(([category, keywords]) => keywords.map(keyword => ({ id: `broad:${category}:${keyword}`, group: 'broad', category, keyword })));

export const exactQueries = [['cpu', '9800x3d'], ['cpu', '14900k'], ['cpu', '285k'],
  ['storage', '990pro'], ['storage', 'sn850x'], ['gpu', 'rtx5080']]
  .map(([category, keyword]) => ({ id: `exact:${keyword}`, group: 'exact', category, keyword }));

export const offsetQueries = [0, 20, 40, 60, 80, 100].map(offset => ({
  id: `offset:${offset}`, group: 'offset', category: 'memory', keyword: 'ddr5', offset,
}));

// Original and optimized builders retain these logical CTE names for diagnostics.
export function searchCTEs(sql) {
  const boundary = Math.max(sql.lastIndexOf('SELECT p.id,p.upstream_id'), sql.lastIndexOf('SELECT r._p_id AS id'));
  if (boundary < 0) throw new Error('Search SQL layout changed; review diagnostic extraction');
  return sql.slice(0, boundary);
}
