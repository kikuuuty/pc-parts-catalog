# Dynamic Facet API

```http
POST /v1/categories/:category/facets
Content-Type: application/json
```

全30カテゴリで、現在の条件と両立する **curated `multi_select` の候補と製品件数**を返します。
定義・表示順・field label・target・型・単位は既存の`GET /v1/categories/:category/filters`を使用します。
Dynamicレスポンスはその`id`で結合してください。rangeのmin/max/stepは静的metadataのままで、動的なrange集計はしません。

## Request

```json
{
  "filters": { "manufacturer": ["Intel"], "socket": ["LGA1700"] },
  "ranges": { "core_count": { "min": 6 } },
  "facets": {}
}
```

- categoryはpathで指定。bodyの3オブジェクトはすべて省略可能です。`{}`は無条件。
- 条件のfield/type allowlistは`POST /v1/search`と同一。registry外の合法な検索条件も絞り込みには使えますが、候補として返すfieldはregistryの`control === "multi_select"`だけです。
- bodyの`facets`は`product_facets`向けの**検索条件**です。返してほしいfieldの指定ではありません。
- 値は保存された値をそのまま送ります。socketの空白などをクライアントで推測・正規化せず、metadata / dynamic responseの`value`を使用してください。
- `keyword` / FTS / `identifier` / `orderBy` / pagination / `include`は受け付けません。keyword検索と同時表示する場合でも、facet件数の対象はここに送ったtyped条件のみです。

## Response

以下は小さなfixtureでの`{"filters":{"manufacturer":["Intel"]}}`に対する契約例です。実データの件数・値はsnapshotに依存します。

```json
{
  "category": "cpu",
  "facets": {
    "manufacturer": {
      "options": [
        { "value": "AMD", "label": "AMD", "count": 1 },
        { "value": "Intel", "label": "Intel", "count": 2 }
      ]
    },
    "family": {
      "options": [
        { "value": "Core i5", "label": "Core i5", "count": 1 },
        { "value": "Core i7", "label": "Core i7", "count": 1 }
      ]
    },
    "generation": { "options": [] },
    "socket": {
      "options": [
        { "value": "LGA1700", "label": "LGA1700", "count": 1 },
        { "value": "LGA1851", "label": "LGA1851", "count": 1 }
      ]
    },
    "includes_cooler": {
      "options": [
        { "value": 0, "label": "なし", "count": 1 },
        { "value": 1, "label": "あり", "count": 1 }
      ]
    }
  }
}
```

- `facets`のキーがfield ID。対象fieldは候補がなくても`options: []`で返します。
- `value`のJSON型を保持。`label`はregistryの`optionLabels`、なければ`String(value)`です。
- `count`は正の整数。active製品だけを数え、複数の選択値に一致した同一製品を重複加算しません。
- NULL・空/空白・200文字超・不正な数値はmetadataと同じルールで候補から除外します。
- 文字列はlocale非依存のコード単位昇順、数値は昇順です。
- 0件optionの補完、現在選択値の強制挿入、暗黙の条件解除は行いません。

## Self-exclusionと条件の意味

同一fieldの複数値は**OR**、別fieldは**AND**。rangeは包含境界で、両端指定時はANDです。
候補を計算するfield自身の条件だけを除外し、他の条件をすべて適用します。

例: `manufacturer=Intel AND socket=LGA1700`の場合:

|計算するfield|適用する条件|
|---|---|
|socket|manufacturer=Intel（他のIntel socketも追加選択可能）|
|manufacturer|socket=LGA1700|
|family / generation / includes_cooler|manufacturer=Intel AND socket=LGA1700|

同じIDを複数targetへ指定した場合、そのIDの条件を`filters`・`ranges`・`facets`のすべてから除外します。例えば`includes_cooler`のselectionとrange、legacy `socket` facetとscalar socketです。他IDのrangeは常に適用します。

両立しない条件も200で一貫した結果を返します。`Intel AND AMD専用socket`ならfamily等は空ですが、socket自身・manufacturer自身の候補はself-exclusionによって残り得ます。全facetを機械的に空にするAPIではありません。
件数は「そのfield自身を外した条件 + そのoption」の製品数であり、現在の全条件の結果件数や、追加選択後の合計件数とは異なります。

## Validation / limits / HTTP

検索本体とHTTP条件validator・SQL predicate compilerを共有します。

|制約|上限|
|---|---:|
|JSON body|16,384 bytes（streamも検査）|
|filters / ranges / facetsのfield数|8 / 8 / 4|
|全target合計field数|16|
|1 selectionの値数|1〜10|
|filters + facetsの合計選択値数|40|
|文字列値|非空、200 UTF-16 code units以内|
|1 SQLのbound parameters|100|
|返す1fieldのoption数|512|

フィールド名はmodel/registryからのみSQL化し、入力値はparameter bindingします。除外される自身の条件も、除外前に検証します。
option上限を超えた場合は全responseを500 `FILTER_OPTION_LIMIT`にし、field IDと上限を明示します。候補の無言truncateはしません。

- 成功: 200。unknown category: 404 `CATEGORY_NOT_FOUND`。
- unknown body/condition field、不正な型・範囲・複雑度、query parameter: 400 `INVALID_REQUEST`。
- 大きすぎるbody: 413。JSON以外: 415。GET等: 405 (`Allow: POST, OPTIONS`)。
- OPTIONSは204、既存public CORS `*`。DB障害は既存の秘匿化された500/503。
- **キャッシュなし**: `Cache-Control: no-store`, `X-Cache: BYPASS`。専用の`protectFacet()`で`FACET_MISS_LIMITER`（30/60秒）→`D1_MISS_LIMITER`（60/60秒）の順に判定します。`EXPENSIVE_MISS_LIMITER`・query refill limiterは消費しません。
- Worker telemetryはroute、SQL数、batch操作数、rows_read/written、durationを記録します。条件値やSQLは記録しません。
- 静的GETのepoch cache / TTL / browser再検証ポリシーは継続します。

### Rate budgetの分離

```text
Facet → FACET_MISS_LIMITER (30/60秒) → D1_MISS_LIMITER (60/60秒) → D1
Search (expensive / uncached) → EXPENSIVE_MISS_LIMITER (20/60秒) → D1_MISS_LIMITER → D1
```

`POST /v1/search`は引き続きSearch側の20/60秒budgetを使用します。normal GET MISSはD1側、cache HITはMISS limiterを消費しません。
両方の専用budgetを分離しても、D1 admissionは同じbinding・keyで合算し、60/60秒の最終防衛線を維持します。これはrequest単位のadmissionで、1 Facet request内のSQL数ではありません。Workers bindingはcolo-local / eventually consistentであり、worldwideで厳密な60件を保証するものではありません。

Facet専用拒否は後段のD1 tokenを消費せず、D1実行0で429を返します。bindingは非transactionalなので、後段のD1 limiterによる拒否では既に消費したFacet tokenを返却できません。
両limiterの429は`Retry-After: 60`。公開エラーは既存の`RATE_LIMITED` / `Too many search requests`と`request_id`を維持し、binding欠落・例外・不正応答ではfail-closedの503 `PROTECTION_UNAVAILABLE`（同じく60秒）になります。

telemetryの`rate_limit_class`はFacet許可・専用拒否で`facet_miss`、D1拒否で`d1_miss`、Search専用拒否で`expensive_miss`です。`search_cost_class`はFacetでも従来の`uncached`を維持します。
**30/60秒は調整可能な初期threshold**です。productionでroute/colo別の`facet_miss`・`expensive_miss`・`d1_miss`の429率、`unavailable`（503）、許可requestの`rows_read`・`d1_queries`・SQL/HTTP latency・runtime CPUを観測して調整します。
namespaceはproduction `29599005`、local `29599105`。変更時は`wrangler.json`の両環境と`protectionBindings`の厳密なpredeploy契約を同時に更新します。

## SQL設計とindex

`src/queries.js`の`searchPredicate()`を検索本体と共有し、typed `IN`、range、multi-value `EXISTS`/`IN`を生成します。CPU manufacturerのspec優先解決も同じです。`typedSearchIndex()`は既存の検索index選択を共有します。

`src/dynamic-facets.js`はregistryから以下を構成します。

1. 未選択fieldを1グループにまとめ、現在の全条件を適用。
2. 選択済みfieldごとに、そのIDだけを除外したグループを作成。
3. 各グループは1 SQL。scalarの値の組み合わせをまず`GROUP BY ... COUNT(*)`し、その小さな集合を`json_each`でfield/valueへ展開、`GROUP BY field,value SUM(n)`で候補と件数を一緒に取得。
4. multi-value optionは`product_facets`をproduct_idでprobe。PK `(product_id,attribute,value)`により1option/1製品は一度だけ数える。
5. scalarとmulti-valueを同じグループで計算するときだけ候補CTEをmaterializeし、両集計で共有。scalarだけならindexed traversalから直接group集計。

対象field数をF、自身の条件を持つ対象field数をSとすると、SQL数は`S + (S < F ? 1 : 0)`。現registryのFは最大7です。range等、候補として返さないfieldの条件はSQL数を増やしません。全SQLを1回の`DB.batch()`で実行します。

無条件ではcategory partial index walk、typed条件があれば既存spec indexを起点にPK probeします。
主な利用indexは`products_category_manufacturer_series`、`cpu_family_cores`、`cpu_socket`、`motherboard_socket_memory`、`gpu_vendor_vram`、`facets_value`、product_facets PKです。GROUP BY用の一時B-treeと中間集合/JSON仮想表のSCANはありますが、catalog全体やproduct_facets全体の無制限scanはありません。

**新index / migrationは追加していません。** 新たな互換表・上流JSONの読み込み・Dynamic Range Aggregationもありません。

## 測定と検証

```sh
npm run check
npm run verify:protection
npm run benchmark:facets
npm run verify:plans
```

`benchmark:facets`は既存ローカルD1をread-onlyで測定し、`.cache/facet-benchmark.json`へEXPLAIN、SQL数、候補数、SQL duration、adapter wall time、D1 meta、catalog数、snapshot commitを保存します。EXPLAIN・条件サンプル選択等の診断queryはUI集計のSQL数/コストから分離します。最頻のIntel socket・motherboard socket・GPU vendorをDBから選択し、小さすぎるサンプルに偏らせません。
query数の上限、catalog/facet全走査なし、option上限、rows_written=0、カテゴリ規模に対するread budgetを検査し、失敗時も診断reportを保存します。

2026-09-22、snapshot `eec0df175504ebd15f0f3e3a8249a18a22f00940`（48,134 active製品）の実測:

|条件|SQL数|返却option数|local rows_read|SQL duration合計(ms)|adapter wall合計(ms)|
|---|---:|---:|---:|---:|---:|
|CPU 無条件|1|54|3,989|1|81.62|
|CPU manufacturer=Intel|2|38|4,777|2|160.32|
|CPU Intel + socket=LGA 1151|3|24|3,176|1|233.26|
|motherboard socket=LGA 1151|2|73|15,203|4|145.76|
|GPU chip_vendor=NVIDIA|2|40|20,812|6|164.71|
|keyboard 無条件（scalar + multi-value）|1|293|26,404|5|85.20|

全ケースrows_written=0。category/spec/facet indexを利用し、catalog/facet全走査なし。
初期の製品ごとの行展開からtuple事前集約へ変えることで、CPU無条件は8,766→3,989 reads、Intel指定は8,015→4,777、keyboard無条件は49,706→26,404へ減少しました。

`rows_read`は**ローカルD1/workerdのmeta観測値**で、本番Cloudflare D1での請求readsの実測ではありません。Node SQLite fixture adapterの`results.length`をreadコストとして代用していません。durationはローカルの単回観測で0msへの丸めもあり、p95/SLAではありません。adapter wallにはローカルbridgeと逐次queryの往復が含まれ、本番の1 batchのHTTP latencyとは比較できません。
self-exclusionでカテゴリ全体を再集計するfieldがあるため、選択条件が増えるだけで必ずreadsが減るわけではありません。現在の規模では上記のbounded readと既存MISS保護を採用し、長期cacheを追加していません。

自動テストはCPUの5必須ケース、motherboard/GPUを含む全30カテゴリの独立fixture候補・件数、通常検索との件数一致、OR/AND/range/multi-value、active限定、boolean label、入力上限、SQL注入、overflow、protection、cache bypass、query planを確認します。既存テストを含む228件とschema check、既存45検索planが成功しました。

rate分離の追加テストはdeterministic fake limiterで30 Facet許可→31件目429/D1=0、20 advanced Search＋20 Facetの独立消費、normal検索も合算した60件のD1上限、拒否順序・refundなし・429/503契約・設定欠落/相違を確認します。fakeの正確な件数はproduction bindingの厳密なquota保証ではありません。

## pc-build-sheet接続時

1. カテゴリ選択時は静的GETでUI定義・初期候補・rangeを取得。
2. 条件変更時に同じtyped条件だけをDynamic POSTへ送信し、`facets[id].options`を差し替える。
3. 選択値の型を維持し、候補が消えた選択を自動削除せず、解除可能な状態で表示する。件数はself-excludingとして表示する。
4. 連続操作はdebounce/coalesceし、古いresponseを採用しない。429の`Retry-After`を扱う。
5. rangeは静的範囲、検索結果一覧は既存`POST /v1/search`から取得する。keyword付き一覧ではfacet件数がkeywordを反映しないことをUI側で扱う。

今回`pc-build-sheet`の変更は含みません。
