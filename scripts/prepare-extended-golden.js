// Source-only authoring recipe. No query compiler, FTS or search result is used.
// --write creates new files exclusively; subsequent runs only check the frozen bytes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { loadSnapshot } from '../src/upstream.js';
const hash=value=>createHash('sha256').update(value).digest('hex');
const snapshot = await loadSnapshot();
assert.equal(snapshot.commit,'eec0df175504ebd15f0f3e3a8249a18a22f00940');
const byKey = new Map(snapshot.records.map(r => [r.product.upstream_key,r]));
const fixture = [], evidence = [];
const resolve = key => { const r=byKey.get(key); assert(r, key); return r; };
function add(key, query, cls='exact_model', search) {
  const r=resolve(key), category=r.product.category;
  const item={id:`ext-${category}-${String(fixture.filter(f => f.category===category).length+1).padStart(2,'0')}`,category,query,class:cls,suite:'extended',expected:{upstream_key:key}};
  if (search) item.search=search;
  fixture.push(item);
  evidence.push({id:item.id,source_path:`open-db/${key}.json`,name:r.product.name,manufacturer:r.product.manufacturer,variant:r.product.variant,identifiers:r.identifiers,spec:r.spec,facets:r.facets});
  return item;
}
function identifier(key, value) {
  const r=resolve(key), i=value ? r.identifiers.find(i => i.value===value) : r.identifiers.find(i => i.type==='mpn') ?? r.identifiers[0]; assert(i,key);
  const item=add(key,i.value,'identifier',{identifier:{type:i.type,value:i.value}});
  item.notes='Source identifier, including an explicit identifier filter; collisions remain visible rather than selecting a returned SKU.';
}
function group(category,query,pattern,cls='broad',search={}) {
  const matches=snapshot.records.filter(r => r.product.category===category && pattern.test(r.product.name)
    && Object.entries(search.filters ?? {}).every(([k,v]) => (r.spec[k] ?? r.product[k])===v)
    && Object.entries(search.ranges ?? {}).every(([k,v]) => r.spec[k]!=null && (v.min===undefined || r.spec[k]>=v.min) && (v.max===undefined || r.spec[k]<=v.max))
    && Object.entries(search.facets ?? {}).every(([k,v]) => r.facets.some(f => f.attribute===k && f.value===v)));
  assert(matches.length>1 && matches.length<=500,`${category}/${query}: ${matches.length}`);
  const item=add(matches[0].product.upstream_key,query,cls,search);
  const selectors={anyOf:matches.map(r => ({upstream_key:r.product.upstream_key})).sort((a,b) => a.upstream_key.localeCompare(b.upstream_key))};
  item.expected=selectors; item.acceptable=selectors;
  item.notes=`Snapshot-only relevance rule: name /${pattern.source}/${pattern.flags}, AND explicit search constraints. All ${matches.length} source records are enumerated; no ranking-based selection.`;
  evidence.at(-1).relevant_products=matches.map(r => ({upstream_key:r.product.upstream_key,name:r.product.name}));
}
const k='Keyboard/4d239c02-3bf1-45d6-9d94-fa3c096eb87a';
add(k,'Keychron Q1 QMK V2 Knob Mini Mechanical Keyboard');
add(k,'Keychron Q1 QMK V2 Knob','manufacturer_model');
add('Keyboard/4c7a1dfc-7954-47d7-aada-263bac218b41','K380s','compact_model');
add('Keyboard/451a2df2-55a9-43ff-b07e-96811bedfd11','Pebble Keys 2 K380s Tonal Rose','variant');
add('Keyboard/fcaee215-422f-4107-a3ea-1d9122950c88','8BitDo Retro C64','manufacturer_model');
add('Keyboard/ddafe6ad-cea8-4a1b-b61d-0ad0f0f7f51c','8BitDo Retro Fami','manufacturer_model');
identifier(k); identifier('Keyboard/4c7a1dfc-7954-47d7-aada-263bac218b41');
group('keyboard','keychron q1',/\bKeychron Q1\b/i);
group('keyboard','aula',/\bAULA\b/i,'typed_spec',{filters:{switch_type:'Linear'}});
group('keyboard','aula',/\bAULA\b/i,'facet',{facets:{connectivity:'Bluetooth'}});
group('keyboard','aula',/\bAULA\b/i,'range',{ranges:{polling_rate_hz:{min:1000}}});
const m='Mouse/fe670d09-2136-4aae-9705-757e5039b9f6';
add(m,'Logitech MX Master 3');
add('Mouse/b727b264-7909-4487-9cfb-cab0458816f3','Logitech G502 HERO High Performance Gaming Mouse');
add('Mouse/19377571-877c-41a4-81cc-43ca813cf646','G502HERO','compact_model');
add('Mouse/aa282b84-406c-4829-9fa9-9cae47fefcb6','DeathAdder V3 Pro Faker Edition','variant');
add('Mouse/0701b5a3-1d66-4321-a393-b0daed7e3705','Razer DeathAdder V3 HyperSpeed','manufacturer_model');
add('Mouse/a630f2ce-5d1e-4006-835b-13dc514887b5','MX Master 3S Business Graphite','variant');
identifier(m);identifier('Mouse/b727b264-7909-4487-9cfb-cab0458816f3');
group('mouse','logitech mx master',/\bLogitech MX Master\b/i);
group('mouse','razer',/\bRazer\b/i,'typed_spec',{filters:{shape:'Ergonomic'}});
group('mouse','logitech mx master',/\bLogitech MX Master\b/i,'facet',{facets:{connectivity:'Bluetooth'}});
group('mouse','razer',/\bRazer\b/i,'range',{ranges:{weight_g:{max:70}}});
const mon='Monitor/1f541617-7eb7-452e-82dc-c3ce08af8001';
add(mon,'VG27AQ');
add('Monitor/1fb33721-265a-4807-a5c6-9365a1938c55','AW3423DWF','compact_model');
add('Monitor/23f9bbc9-05c9-45a5-830f-60b4056baa15','LG 27GP850-B','manufacturer_model');
add('Monitor/2bfe1aad-b965-4180-b18b-fcdd96c2f14e','Gigabyte M27Q-P','variant');
add('Monitor/60d325b7-1e1f-4f01-b900-4f1e05267ed3','Gigabyte M27Q-X','variant');
add('Monitor/8c481254-0c3e-40b9-9d72-54fc7243fec5','Gigabyte M27Q rev 2.0','variant');
identifier(mon,'90LM0500-B01370');identifier('Monitor/23f9bbc9-05c9-45a5-830f-60b4056baa15');
group('monitor','odyssey g7',/\bOdyssey G7\b/i);
group('monitor','asus',/\bAsus\b/i,'typed_spec',{filters:{resolution_width:2560,resolution_height:1440}});
group('monitor','gigabyte',/\bGigabyte\b/i,'range',{ranges:{refresh_rate_hz:{min:170}}});
group('monitor','monitor',/\bMonitor\b/i,'facet',{facets:{ports:'displayport_1_4a'}});
const h='Headphones/eb851535-44b4-417f-bbba-5a0966e0c691';
add(h,'Beyerdynamic DT 990 Pro 250 Open-Back Wired Headphones');
add(h,'Beyerdynamic DT 990 Pro 250','manufacturer_model');
add(h,'DT990','compact_model');
add('Headphones/30148a55-a1c7-47fc-a0d6-4fad5a36c682','HyperX Cloud III S Wireless Black Red','variant');
add('Headphones/c5e81f3b-ac78-43c1-91ca-141f01805406','HyperX Cloud III S Wireless White','variant');
add('Headphones/8e3b6893-69ca-40b8-ab6f-a1af8cd3e695','Creative Sound Blaster JAM V2','manufacturer_model');
identifier(h);identifier('Headphones/30148a55-a1c7-47fc-a0d6-4fad5a36c682');
group('headphones','dt 990',/\bDT 990\b/i);
group('headphones','hyperx',/\bHyperX\b/i,'typed_spec',{filters:{headphone_type:'Closed-Back'}});
group('headphones','hyperx',/\bHyperX\b/i,'facet',{facets:{connection_types:'Wireless 2.4GHz'}});
group('headphones','hyperx',/\bHyperX\b/i,'range',{ranges:{weight_g:{max:400}}});
const secondary=[
 ['CaptureCard/8073870e-71bd-45a6-ba71-825dbe1cfa2d','Elgato 4K60 Pro MK.2','CaptureCard/0dddfe03-fe17-4d5a-9d53-5ec7521458e1','Elgato HD60 S+','Elgato',/\bElgato\b/i],
 ['Microphone/af9f6585-24d3-48c6-94aa-a96023412558','Shure SM7B','Microphone/be2e37f7-f6f2-4643-9d23-282b8d3a0e12','HyperX QuadCast 2 S USB-C Microphone Black','yeti',/\bYeti\b/i],
 ['Webcam/a9550bce-54e6-45c0-8272-dcec5a6a0313','Logitech C920 HD Pro Webcam','Webcam/eb1ad3e3-a854-42ac-816b-c487f94537e6','Elgato Facecam MK.2','facecam',/\bFacecam\b/i],
 ['Speaker/ccac0ba6-be47-49e4-91da-42bc76a62bed','Creative Labs Pebble V3','Speaker/4ee0327d-be59-4781-ae51-3015b6d5abd2','Edifier R1280DB Black','pebble',/\bPebble\b/i],
 ['SoundCard/bbac81cf-5031-4f2c-b4bd-61db24ccd0e0','Creative Sound Blaster AE-7','SoundCard/a54d739f-4101-41f5-a797-6b294178825a','Sound Blaster Audigy Fx V2','sound blaster',/\bSound Blaster\b/i],
 ['NetworkCard/f2f1237f-8514-446f-b790-81f1ac21d12f','Asus NX1101','NetworkCard/eb37b18a-da57-47e5-ba20-db6160a06896','Asus PCE-C2500','intel',/\bIntel\b/i],
 ['ThermalCompound/e3025280-46a4-4472-8e0e-e4cd6da2862b','Noctua NT-H1 3.5g','ThermalCompound/fa26b1fc-7696-4022-9044-aa90e1fb29d2','Kryonaut Extreme 2g','arctic mx-4',/\bArctic MX-4\b/i],
];
for (const [key,q,key2,q2,broad,pattern] of secondary) {
  add(key,q,'manufacturer_model'); add(key2,q2,'variant'); identifier(key);
  add(key,resolve(key).product.category==='sound_card' ? 'Creative Labs Sound Blaster AE-7' : resolve(key).product.name); group(resolve(key).product.category,broad,pattern);
}
for (const [key,q,key2,q2] of [
 ['Accessory/cfee4a1b-6850-4ed0-950e-497996cc08af','APC BN450MNW','Accessory/86069191-d876-411b-a301-b2140e65e726','APC BN1500M2'],
 ['Chair/25defeb2-b8a0-4170-a71e-0958b90187a1','BLACKLYTE Athena Fabric Black','Chair/ba9a5adf-1455-432c-b9a9-b6b157f51494','BLACKLYTE Athena Fabric Camo'],
 ['Desk/2c0d93e8-efb7-41be-a7e7-654a9ff2875d','Amazon Basics Electric Standing Desk Black Walnut','Desk/b27e3c1b-3dc0-4de0-993a-e23d56f26c8d','Amazon Basics Electric Standing Desk White Oak'],
 ['Laptop/66f08d6b-668b-4ef0-bebe-f971ae5b16a7','ASUS P5405CSA-DH54','Laptop/a5d86627-2163-4c97-82b0-a7bb63772a2a','ASUS P5405CSA-DH76'],
 ['Lighting/13319d02-fb4d-42b8-8932-93d1d8383841','Elgato Key Light','Lighting/484a47cf-077b-4b20-b8b3-7de452be7cc5','Elgato Key Light Neo'],
 ['Mousepad/a73b842e-7d52-4fdf-ba8b-41fbc1c62973','ASUS ROG Moonstone Ace L Black','Mousepad/ae3e9f6e-c1c2-485b-8de7-711ed5bce27a','ASUS ROG Moonstone Ace L Moonlight White'],
 ['OS/06351667-b638-46e4-88d9-5829230a9fcc','Microsoft Windows 10 Home Download','OS/1fab27b8-12a8-4f16-aa04-8db160c0167e','Microsoft Windows 10 Home USB Flash Drive'],
 ['PrebuiltDesktop/03192e27-53c7-47ca-8f56-e5effa659d1b','Alienware AAT2250','PrebuiltDesktop/98da01cb-228b-4b57-8e7b-9e15d5235950','Alienware AAT2265'],
 ['Stand/28a131b6-32cd-4774-8415-794bb50b5678','CORSAIR ST100 RGB'],
 ['VRHeadset/8282f393-e404-45bf-b6f7-05d85e3db6aa','Meta Quest 2 128GB','VRHeadset/637022f6-7c14-450e-8e10-d2a6cd355c24','Meta Quest 2 256GB'],
]) { add(key,q,'manufacturer_model'); if (key2) add(key2,q2,'variant'); }
assert.equal(fixture.length,102);
for (const item of fixture) assert((item.query.match(/[\p{L}\p{N}]+/gu)?.length ?? 0)<=12,`${item.id}: exceeds API token limit`);
const bytes=JSON.stringify(fixture,null,2)+'\n';
const manifest={snapshot_commit:snapshot.commit,fixture_sha256:hash(bytes),review_status:'pending human review; no extended rank/precision floors',query_count:fixture.length,
  by_category:Object.fromEntries([...new Set(fixture.map(r => r.category))].map(c => [c,fixture.filter(r => r.category===c).length])),evidence};
for (const [name,content] of [['search-extended.json',bytes],['search-extended-evidence.json',JSON.stringify(manifest,null,2)+'\n']]) {
  const file=`test/fixtures/${name}`;
  if (process.argv.includes('--candidate')) await writeFile(`.cache/candidate-${name}`,content);
  else if (process.argv.includes('--write')) await writeFile(file,content,{flag:'wx'});
  else assert.equal(await readFile(file,'utf8'),content,`Frozen ${name} differs; review explicitly, never adopt search output`);
}
console.log(JSON.stringify({count:fixture.length,sha256:manifest.fixture_sha256,by_category:manifest.by_category},null,2));
