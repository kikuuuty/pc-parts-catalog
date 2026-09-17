import { readFile } from 'node:fs/promises';
const report=JSON.parse(await readFile(process.argv[2]??'.cache/release-ux-report.json','utf8'));
console.log(JSON.stringify({
  catalog:report.catalog,display_values:report.display_values,
  human_review:'optional; not read by the release gate',
  performance:Object.fromEntries(Object.entries(report.by_intent).map(([intent,r])=>[intent,{count:r.count,rows_read:r.rows_read,sql_duration_ms:r.sql_duration_ms,query_count:r.query_count,catalog_full_scan_count:r.catalog_full_scan_count}])),
  quality_failures:report.release_failures,
  plan_count:report.plans?.length,plan_failures:report.plans?.filter(p=>!p.index_check).map(p=>({name:p.name,plan:p.plan})),
  old_ten:report.results.filter(r=>['p2-storage-990-2tb','p2-storage-sn850-2tb','p2-storage-sn850-4tb','p2-storage-990-1tb','p2-storage-sata1tb','p2-board-b650e-wifi','p2-case-meshify','p2-case-matx','p2-case-itx','p2-cooler-freezer360'].includes(r.id)).map(r=>({id:r.id,intent:r.intent,relevant_count:r.relevant_count,returned:r.returned,recall:r.recall,precision:r.precision,fp:r.false_positive_count,fn:r.false_negative_count})),
},null,2));
