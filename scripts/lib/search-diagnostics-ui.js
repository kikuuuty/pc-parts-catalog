export function mountSearchDiagnostics() {
  const $=id=>document.getElementById(id);
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const labels={cpu:'CPU',gpu:'グラフィックボード',memory:'メモリ',motherboard:'マザーボード',storage:'ストレージ',psu:'電源',case:'PCケース',cpu_cooler:'CPUクーラー',case_fan:'ケースファン',keyboard:'キーボード',mouse:'マウス',monitor:'モニター',headphones:'ヘッドホン'};
  const fields={manufacturer:'メーカー',name:'製品名',series:'シリーズ',variant:'バリエーション',capacity_gb:'容量 (GB)',ram_type:'メモリ規格',form_factor:'形状規格',chipset:'チップセット',socket:'ソケット',core_count:'コア数',thread_count:'スレッド数',speed:'速度',wattage:'出力 (W)',radiator_size_mm:'ラジエータ (mm)',vram_gb:'VRAM (GB)'};
  let categories=[],activeInput,lastBody,offset=0,busy=false,generation=0;
  const request=async(path,init)=>{
    const response=await fetch(path,init),body=await response.json();
    if(!response.ok)throw Error(body.error?.message??'検索できませんでした');return body;
  };
  const model=()=>categories.find(c=>c.category===$('category').value);
  function reset() {generation++;activeInput=null;lastBody=null;$('results').innerHTML='';$('summary').textContent='';$('message').textContent='';$('next').hidden=true;$('diagnostics').hidden=true;}
  function addFilter() {
    const current=model();if(!current||$('filters').children.length>=8)return;
    const row=document.createElement('div');row.className='filter-row';
    row.innerHTML=`<select aria-label="絞り込み項目">${Object.keys(current.fields).map(k=>`<option value="${esc(k)}">${esc(fields[k]??k)}</option>`).join('')}${current.facets.map(k=>`<option value="facet:${esc(k)}">${esc(k)} (facet)</option>`).join('')}</select>
      <select aria-label="条件"><option value="eq">一致</option><option value="min">以上</option><option value="max">以下</option></select>
      <input aria-label="値" placeholder="値"><button type="button" aria-label="条件を削除">×</button>`;
    row.querySelector('button').onclick=()=>{row.remove();reset();};
    const [field,op]=row.querySelectorAll('select');
    const changed=()=>{const text=field.value.startsWith('facet:')||current.fields[field.value]==='TEXT';for(const option of op.options)option.disabled=text&&option.value!=='eq';if(text)op.value='eq';};
    field.onchange=changed;changed();$('filters').append(row);
  }
  function input() {
    const result={category:$('category').value,limit:20},keyword=$('keyword').value.trim();
    if(keyword)result.keyword=keyword;
    for(const row of $('filters').children) {
      const [field,op]=row.querySelectorAll('select'),raw=row.querySelector('input').value.trim();
      if(!raw)continue;
      const facet=field.value.startsWith('facet:'),key=facet?field.value.slice(6):field.value;
      const value=facet||model().fields[key]==='TEXT'?raw:Number(raw);
      if(typeof value==='number'&&!Number.isFinite(value))throw Error(`${fields[key]??key}には数値を入力してください`);
      if(op.value!=='eq')((result.ranges??={})[key]??={})[op.value]=value;
      else {
        const values=facet?(result.facets??={}):(result.filters??={});
        values[key]=values[key]===undefined?value:[...new Set([].concat(values[key],value))];
      }
    }
    return result;
  }
  function render(body,start) {
    const diagnostic=body.diagnostics;
    $('summary').textContent=`${body.data.length}件表示${start?`（${start+1}件目〜）`:''}${body.meta.window_exhausted?' · 候補が多いため条件を絞り込んでください':''}`;
    $('results').innerHTML=body.data.length?body.data.map((p,i)=>{
      const specs=Object.entries(p.specs).filter(([,v])=>v!==null);
      const main=specs.filter(([k])=>['capacity_gb','ram_type','form_factor','chipset','socket','core_count','vram_gb','wattage'].includes(k));
      return `<article><div class="number">${start+i+1}</div><div class="product"><h2>${esc(p.name)}</h2>
        <p class="muted">${esc(p.manufacturer)}${p.series?` · ${esc(p.series)}`:''}${p.variant?` · ${esc(p.variant)}`:''}</p>
        <p>${main.map(([k,v])=>`${esc(fields[k]??k)}: ${esc(v)}`).join(' ／ ')}</p>
        <details><summary>仕様・識別子を見る</summary><table><tbody>${specs.map(([k,v])=>`<tr><th>${esc(fields[k]??k)}</th><td>${esc(v)}</td></tr>`).join('')}</tbody></table>
          <button type="button" data-id="${p.id}">識別子を読み込む</button><div class="identifiers"></div>
          <p class="muted">${esc(p.source)} / ${esc(p.upstream_key)}</p></details></div></article>`;
    }).join(''):'<p class="empty">該当する製品がありません。検索語や絞り込み条件を変えて試せます。</p>';
    $('results').querySelectorAll('button[data-id]').forEach(button=>button.onclick=async()=>{
      button.disabled=true;
      try {
        const product=await request(`/api/products/${button.dataset.id}`);
        button.nextElementSibling.innerHTML=product.identifiers.length?`<ul>${product.identifiers.map(i=>`<li>${esc(i.type.toUpperCase())}: ${esc(i.value)} (${esc(i.region)})</li>`).join('')}</ul>`:'<p>識別子の登録なし</p>';
      }catch(error){button.nextElementSibling.textContent=error.message;button.disabled=false;}
    });
    $('next').hidden=body.meta.next_cursor===null&&body.meta.next_offset===null;
    $('diagnostics').hidden=false;
    $('cost').textContent=`API相当: rows_read ${diagnostic.rows_read??'不明'} / SQL ${diagnostic.sql_duration_ms??'不明'}ms / ${diagnostic.query_count} queries / catalog full scan ${diagnostic.catalog_full_scan?'あり':'なし'}`;
    $('plan').textContent=diagnostic.plan.join('\n');
    $('scores').innerHTML=diagnostic.scores.length?`<table><thead><tr><th>順位</th><th>match</th><th>score</th><th>FTS relevance</th></tr></thead><tbody>${diagnostic.scores.map((p,i)=>`<tr><td>${start+i+1}</td><td>${esc(p.match)}</td><td>${esc(p.score)}</td><td>${esc(p.fts_relevance)}</td></tr>`).join('')}</tbody></table>`:'keywordなし: stable display ordering / cursor pagination';
  }
  async function run(next=false) {
    if(busy)return;busy=true;const current=generation;$('search').disabled=true;$('next').disabled=true;$('message').textContent='検索中…';
    try {
      const base=next?activeInput:input();
      const page=next?(lastBody.meta.next_cursor?{cursor:lastBody.meta.next_cursor}:{offset:lastBody.meta.next_offset}):{};
      const start=next?offset+lastBody.data.length:0;
      const body=await request('/api/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...base,...page})});
      if(current!==generation)return;
      activeInput=base;lastBody=body;offset=start;render(body,start);$('message').textContent='';
    }catch(error){if(current===generation)$('message').textContent=error.message;}
    finally{busy=false;$('search').disabled=false;$('next').disabled=false;}
  }
  $('form').onsubmit=event=>{event.preventDefault();void run();};
  $('form').oninput=reset;
  $('add-filter').onclick=addFilter;
  $('category').onchange=()=>{$('filters').innerHTML='';reset();};
  $('next').onclick=()=>void run(true);
  const productEvidence=p=>`<article><div class="product"><h2>${p.rank?`${esc(p.rank)}. `:''}${esc(p.name)} ${p.fixture_expected?'★ fixture expected':p.source_relevant?'★ relevant / source equivalent':''}</h2>
    <p>${esc(p.manufacturer)} · ${esc(p.series)} · ${esc(p.variant)}</p><p class="muted">${esc(p.source)} / ${esc(p.upstream_key)}</p>
    ${p.rank?`<p>match: ${esc(p.match_type)} / final score: ${esc(p.final_score)} / BM25 relevance (-bm25): ${esc(p.bm25_relevance)}</p>`:''}
    <p>${(p.identifiers??[]).map(i=>`${esc(i.type)}: ${esc(i.value)}`).join(' / ')}</p>
    <details><summary>spec / relevant判定のsource条件</summary><pre>${esc(JSON.stringify({spec:p.spec,source_condition:p.source_condition,source_relevant:p.source_relevant,source_filters_match:p.source_filters_match},null,2))}</pre></details></div></article>`;
  async function loadCase() {
    const id=$('case-id').value.trim();if(!id)return;
    $('case-load').disabled=true;$('case-results').textContent='source / 候補集合を診断中…';
    try {
      const r=await request(`/api/cases?id=${encodeURIComponent(id)}`);
      const pct=v=>Number.isFinite(v)?`${(v*100).toFixed(2)}%`:'—';
      const group=(label,products)=>`<details><summary>${esc(label)} (${products.length})</summary>${products.map(productEvidence).join('')||'<p>なし</p>'}</details>`;
      $('case-results').innerHTML=`<h2>Case: ${esc(r.id)}</h2><p>Query: ${esc(r.query??'(filter only)')} / Intent: ${esc(r.intent)} / Category: ${esc(r.category)}</p>
        ${r.classification?`<p>Baseline classification: ${esc(r.classification)} / ${esc(r.reason)}<br>Action: ${esc(r.proposed_action)}</p>`:''}
        ${r.required?`<p>Required: ${esc(r.required)} / Actual rank: ${esc(r.rank??'not found')}</p>`:`<p>Expected ${r.relevant_count} / Returned relevant ${r.relevant_returned.length} / Returned candidates ${r.returned}<br>Coverage ${pct(r.relevant_coverage)} / Precision ${pct(r.precision)} / FP ${r.false_positive_count} / FN ${r.false_negative_count}</p>`}
        <p>${r.window_exhausted?'Window exhausted: further filtering required':'Window exhausted: false'} / rows_read ${esc(r.rows_read)} / SQL ${esc(r.sql_duration_ms)}ms / catalog full scan ${esc(r.catalog_full_scan)}</p>
        <p>${esc(r.failures.join('; ')||'自動quality条件: pass')}</p><pre>${esc(JSON.stringify(r.search??{},null,2))}</pre>
        ${r.required?group('Expected product / source equivalents',r.expected_products)+`<h3>Top 10（最大10件）</h3>${r.top_results.map(productEvidence).join('')}`:
          group('Relevant returned',r.relevant_returned)+group('False positives',r.false_positives)+`<section><h3>False negatives (${r.false_negatives.length})</h3>${r.false_negatives.map(productEvidence).join('')||'<p>なし</p>'}</section>`}
        <details><summary>Missing trace（最大${r.trace_limit}件）/ query plan</summary><pre>${esc(JSON.stringify(r.missing_traces,null,2))}</pre><pre>${esc(r.query_plan.join('\n'))}</pre></details>
        <p class="muted">Source snapshot: ${esc(r.source_snapshot_commit)} / ${esc(r.cost_scope)}</p>`;
    }catch(error){$('case-results').textContent=error.message;}finally{$('case-load').disabled=false;}
  }
  $('case-load').onclick=()=>void loadCase();
  request('/api/cases').then(body=>{
    $('case-options').innerHTML=body.cases.map(r=>`<option value="${esc(r.id)}">${esc(r.intent)} / ${esc(r.query)}</option>`).join('');
    const id=new URL(location.href).searchParams.get('case');if(id){$('case-id').value=id;void loadCase();}
  }).catch(error=>{$('case-results').textContent=error.message;});
  request('/api/categories').then(body=>{
    categories=body.categories;
    $('category').innerHTML=categories.map(c=>`<option value="${esc(c.category)}">${esc(labels[c.category]??c.category)}</option>`).join('');
    $('search').disabled=false;
  }).catch(error=>{$('message').textContent=error.message;});
}

export function renderSearchDiagnostics() {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ローカル検索チェック</title>
  <style>
    :root{font:16px/1.6 system-ui,"Yu Gothic UI",sans-serif;color:#203247;background:#f3f6fa;color-scheme:light}*{box-sizing:border-box}body{max-width:1000px;margin:auto;padding:28px 20px}h1{font-size:25px;margin-bottom:4px}header p{margin:0 0 22px;color:#586b83}button,input,select{font:inherit;border:1px solid #b6c7da;border-radius:6px;padding:9px 12px}button{cursor:pointer;background:white}button:disabled{opacity:.6;cursor:wait}button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid #3b82f6;outline-offset:2px}.primary{background:#1858ac;color:white;border-color:#1858ac}form{background:white;padding:20px;border:1px solid #dce4ee;border-radius:10px}.search-row{display:flex;gap:12px;align-items:end}.search-row label{display:flex;flex-direction:column;font-size:13px;gap:4px}.keyword{flex:1}input{min-width:0}details{margin-top:14px}summary{cursor:pointer;color:#1858ac}.filter-row{display:flex;gap:8px;margin:10px 0}.filter-row input{flex:1}#add-filter{margin-top:10px}#message{color:#994126}#summary{font-weight:600}article{display:flex;gap:16px;background:white;border:1px solid #dce4ee;border-radius:8px;padding:18px;margin:12px 0}.number{color:#61758f;font-size:20px;min-width:25px}.product{min-width:0;flex:1}h2{font-size:18px;margin:0}p{margin:6px 0}.muted{color:#61758f;font-size:13px;overflow-wrap:anywhere}table{width:100%;border-collapse:collapse;font-size:13px;margin:12px 0}td,th{text-align:left;padding:6px;border-bottom:1px solid #dce4ee;overflow-wrap:anywhere}th{font-weight:500;color:#61758f}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}#diagnostics{background:#e9eff7;padding:14px;border-radius:8px}footer{margin-top:30px;color:#61758f;font-size:13px}.empty{padding:30px;background:white}#next{display:block;margin:20px auto}[hidden]{display:none!important}@media(max-width:650px){.search-row{flex-wrap:wrap}.keyword{min-width:60%}.filter-row{flex-wrap:wrap}.filter-row input{width:100%}body{padding:16px}}
  </style></head><body><header><h1>ローカル検索チェック</h1><p>気になった検索を、ここで試せます。確認・承認の作業はありません。</p></header>
  <section aria-label="Failure診断"><label>Case ID <input id="case-id" list="case-options" placeholder="p2-storage-sata1tb"></label><datalist id="case-options"></datalist><button id="case-load" type="button">Caseを診断</button><div id="case-results" aria-live="polite"></div></section>
  <form id="form"><div class="search-row"><label>カテゴリ<select id="category" aria-label="カテゴリ"></select></label>
    <label class="keyword">検索語<input id="keyword" placeholder="例: 9800X3D、MAG、SN850X" autocomplete="off"></label><button id="search" class="primary" disabled>検索</button></div>
    <details><summary>絞り込み条件（任意）</summary><div id="filters"></div><button id="add-filter" type="button">条件を追加</button><p class="muted">文字列は一致、数値は一致・以上・以下で絞れます。検索語を空にすると一覧を確認できます。</p></details></form>
  <p id="message" role="status" aria-live="polite"></p><p id="summary"></p><div id="results"></div><button id="next" hidden>次の20件</button>
  <details id="diagnostics" hidden><summary>詳しい診断情報（必要なときだけ）</summary><p id="cost"></p><p class="muted">説明取得用の追加SQLは上のcostに含めません。local測定であり、本番latencyではありません。</p><div id="scores"></div><pre id="plan"></pre></details>
  <footer>ローカルD1を読み取るだけのツールです。結果や操作はrelease判定に送られません。<br>Contains information from BuildCores OpenDB, made available under ODC-By 1.0.</footer>
  <script>(${mountSearchDiagnostics.toString()})();</script></body></html>`;
}
