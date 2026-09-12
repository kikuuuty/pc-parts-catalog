import { models } from './model.js';

// Query-only interpretation, not catalog normalization. Keep model numbers unless
// a unit or a narrowly defined category context disambiguates them.
export function parseSearchIntent(category, keyword) {
  const original = keyword.normalize('NFKC').toLowerCase();
  let text = original.replace(/\bgskill\b/g,'g.skill'); // punctuation omission of the existing G.Skill brand
  const literal=text;
  const specs = [];
  const add = (field,value) => {
    if (!Object.hasOwn(models[category].fields,field)) throw new Error(`Unsupported search spec: ${category}.${field}`);
    specs.push({field,value});
  };
  const consume = (pattern,fn) => { text = text.replace(pattern,(...args) => fn(...args) === false ? args[0] : ' '); };
  const boundary = '(?![\\p{L}\\p{N}.])';
  const unit = suffix => new RegExp(`(?<![\\p{L}\\p{N}.])([0-9]+(?:\\.[0-9]+)?)\\s*(${suffix})${boundary}`,'giu');
  const memoryContext = /\bddr[345]\b|\bcl\s*\d+\b/i.test(original);
  const cooling = category === 'cpu_cooler' ? original.match(/\b(aio|water|air)\b/)?.[1] : null;
  if (['memory','storage','gpu'].includes(category)) consume(unit(category === 'storage' ? 'tb|gb' : 'gb'),(_,n,u) => {
    const value = Number(n)*(u.toLowerCase()==='tb' ? 1000 : 1);
    if (!(value > 0 && value <= 1000000)) return false;
    add(category === 'gpu' ? 'vram_gb' : 'capacity_gb',value);
  });
  if (['memory','motherboard'].includes(category)) consume(/\bddr([345])\b/gi,(_,n) => add('ram_type',`DDR${n}`));
  if (category === 'memory') {
    consume(unit('mhz|mt\/s|mts'),(_,n) => Number(n)>=800 && Number(n)<=12000 ? add('speed',Number(n)) : false);
    consume(/\bcl\s*(\d{1,3})\b/gi,(_,n) => Number(n)>0 && Number(n)<=100 ? add('cas_latency',Number(n)) : false);
    if (memoryContext) consume(/(?<![\p{L}\p{N}])(\d{4,5})(?![\p{L}\p{N}])/gu,(_,n) =>
      Number(n)>=1600 && Number(n)<=12000 && Number(n)%100===0 ? add('speed',Number(n)) : false);
  }
  if (category === 'storage') consume(/\bnvme\b/gi,() => add('nvme',1));
  if (category === 'psu') {
    consume(unit('w'),(_,n) => Number(n)>0 && Number(n)<=3000 ? add('wattage',Number(n)) : false);
    consume(/\b(?:80\s*\+\s*)?(gold|bronze|platinum|titanium|silver)\b/gi,(_,v) => add('efficiency_rating',`80+ ${v[0].toUpperCase()}${v.slice(1).toLowerCase()}`));
    consume(/\b(sfx-l|sfx|atx|tfx)\b/gi,(_,v) => add('form_factor',v.toUpperCase()));
  }
  if (category === 'case_fan') {
    consume(unit('mm'),(_,n) => Number(n)>=20 && Number(n)<=500 ? add('size_mm',Number(n)) : false);
    consume(/\bpwm\b/gi,() => add('pwm',1));
  }
  if (category === 'cpu_cooler') {
    consume(/\b(aio|water|air)\b/gi,(_,v) => add('water_cooled',v.toLowerCase()==='air' ? 0 : 1));
    if (cooling) {
      consume(unit('mm'),(_,n) => Number(n)>=20 && Number(n)<=500 ? add(cooling==='air' ? 'fan_size_mm' : 'radiator_size_mm',Number(n)) : false);
      // Bare radiator sizes only with an explicit liquid-cooling type, never a bare CPU/GPU model.
      if (cooling !== 'air') consume(/\b(120|140|240|280|360|420)\b/g,(_,n) => add('radiator_size_mm',Number(n)));
    }
  }
  if (category === 'motherboard') {
    consume(/\b(am[345]|lga\s*\d{3,4})\b/gi,(_,v) => add('socket',v.startsWith('lga') ? v.replace(/^lga\s*/i,'LGA ') : v.toUpperCase()));
    consume(/\b(micro[ -]?atx|matx|mini[ -]?itx|mitx|eatx|atx)\b/gi,(_,v) => add('form_factor',
      /^(micro|matx)/i.test(v) ? 'Micro ATX' : /^(mini|mitx)/i.test(v) ? 'Mini-ITX' : v.toUpperCase()));
  }
  // Category nouns only disappear in a meaningful interpreted query. Brand names
  // such as "Cooler Master" are not stop words.
  if (specs.length) {
    const nouns = {psu:/\bpsu\b/g,case_fan:/\bfan\b/g,cpu_cooler:/\b(?:cpu\s+)?cooler\b(?!\s+master)/g};
    if (nouns[category]) text = text.replace(nouns[category],' ');
  }
  const unique = new Map();
  for (const spec of specs) {
    if (unique.has(spec.field) && unique.get(spec.field).value !== spec.value) {
      // Conflicting values remain literal rather than silently choosing one.
      return {keyword:original,remaining:original,specs:[],identity:null,family:null,specOnly:false};
    }
    unique.set(spec.field,spec);
  }
  const remaining = (text.match(/[\p{L}\p{N}]+/gu) ?? []).join(' ');
  const board = category === 'motherboard' ? remaining.match(/\b([abxzh]\d{3}e?)\b/i) : null;
  const identity = board ? {field:'chipset',values:[`AMD ${board[1].toUpperCase()}`,`Intel ${board[1].toUpperCase()}`,board[1].toUpperCase()],
    residual:remaining.replace(board[0],' ').trim()} : null;
  const familyMatch = category === 'cpu' ? remaining.match(/^(?:(?:amd|intel) )?(ryzen [3579]|core i[3579]|(?:core )?ultra [3579])$/i) : null;
  const family = familyMatch ? familyMatch[1].replace(/^(?:core )?ultra/i,'Core Ultra').replace(/^ryzen/i,'Ryzen').replace(/^core/i,'Core') : null;
  return {keyword:remaining ? text.trim() : original,literal,remaining,specs:[...unique.values()],identity,family,specOnly:!remaining && unique.size>0};
}

// Only these left-prefix INDEX paths may supply typed-only candidates.
export function specSeed(category, specs) {
  const priority = {
    memory:['capacity_gb','speed','ram_type'], storage:['capacity_gb'], psu:['wattage'],
    motherboard:['socket'], case_fan:['size_mm'], cpu_cooler:['radiator_size_mm','fan_size_mm','water_cooled'],
  };
  const field=priority[category]?.find(field => specs.some(s => s.field===field));
  if (!field) return null;
  const orders={
    memory:{capacity_gb:['capacity_gb','ram_type','speed','cas_latency'],speed:['speed','ram_type','cas_latency','capacity_gb'],ram_type:['ram_type','speed','product_id','capacity_gb']},
    storage:{capacity_gb:['capacity_gb']},psu:{wattage:['wattage']},motherboard:{socket:['socket','ram_type','form_factor']},
    case_fan:{size_mm:['size_mm','airflow_max_cfm']},cpu_cooler:{radiator_size_mm:['radiator_size_mm'],fan_size_mm:['fan_size_mm','water_cooled'],water_cooled:['water_cooled','height_mm']},
  };
  return {field,order:[...new Set([...orders[category][field],'product_id'])]};
}
