// Review source records, never search results. Does not select Golden expectations.
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { initialCategories, models } from '../src/model.js';
const location = JSON.parse(await readFile('.cache/all-categories-fresh-location.json','utf8'));
const dir = path.join(location.directory,'state/v3/d1/miniflare-D1DatabaseObject');
const file = (await readdir(dir)).find(f => f.endsWith('.sqlite') && f!=='metadata.sqlite');
const db = new DatabaseSync(path.join(dir,file),{readOnly:true});
try {
  const result = {};
  for (const c of Object.keys(models).filter(c => !initialCategories.includes(c))) {
    result[c] = db.prepare(`SELECT p.upstream_key,p.name,p.manufacturer,p.variant,s.* FROM products p JOIN ${models[c].table} s ON s.product_id=p.id
      WHERE category=? AND active=1 ORDER BY name`).all(c).filter(p => p.name.length<=120);
  }
  await writeFile('.cache/extended-source-records.json',JSON.stringify(result,null,2));
  const priorities = /Keychron Q1|Huntsman V3|Wooting|MX Master 3|DeathAdder V3|Viper V3|G502 HERO|WH-1000XM5|HD 600|HD 660|DT 990|Cloud III|AW3423DWF|27GP850|VG27AQ|M27Q|Odyssey G7|C920|C922|Facecam|Brio|Wave:3|QuadCast|Yeti|SM7B|Sound Blaster|Archer TX|AX200|MX-4|Kryonaut|NT-H1|HD60|4K60|Pebble|Z623|R1280/i;
  await writeFile('.cache/extended-review-candidates.json', JSON.stringify(Object.fromEntries(Object.entries(result).map(([c,rows]) => [c,
    [...new Map(rows.filter(r => priorities.test(r.name)).map(r => [r.name,r])).values()].slice(0,25).concat(rows.slice(0,3)).map(r => [r.upstream_key,r.name])])),null,2));
  await writeFile('.cache/extended-typed-review.json',JSON.stringify(Object.fromEntries(['keyboard','mouse','headphones','monitor'].map(c => [c,{
    specs: result[c].filter(r => c==='keyboard' ? r.polling_rate_hz!==null : c==='mouse' ? r.weight_g!==null && /razer/i.test(r.name) : c==='headphones' ? r.weight_g!==null && /beyerdynamic/i.test(r.name) : /gigabyte/i.test(r.name)).slice(0,8),
    facets:db.prepare('SELECT attribute,value,count(*) AS n FROM product_facets f JOIN products p ON p.id=f.product_id WHERE p.category=? GROUP BY attribute,value').all(c)
  }])),null,2));
  console.log(Object.fromEntries(Object.entries(result).map(([c,rows]) => [c,rows.length])));
} finally { db.close(); }
