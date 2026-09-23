# Category filter metadata API

```http
GET /v1/categories/:category/filters
```

登録済み30カテゴリで利用可能です。`pc-build-sheet`はカテゴリ選択後にこのresponseを取得し、backendの定義から検索UIを構築できます。
このAPIは**そのカテゴリのactive catalog全体**の候補を返します。keywordや選択中のfilterを受け取らず、検索条件に応じたdynamic faceted navigationやoptionごとの件数は返しません。
現在条件での候補・件数は[Dynamic Facet API](dynamic-facets.md) (`POST /v1/categories/:category/facets`)で取得できます。UI定義・初期候補・rangeの観測範囲は引き続きこの静的APIを使用してください。

## Response contract

以下は契約の例です。実際の項目はregistry、候補・範囲はリリース済みcatalogに従います。

```json
{
  "category": "motherboard",
  "filters": [
    {
      "id": "manufacturer",
      "label": "メーカー",
      "control": "multi_select",
      "target": "filters",
      "value_type": "string",
      "unit": null,
      "options": [{ "value": "ASRock", "label": "ASRock" }, { "value": "ASUS", "label": "ASUS" }]
    },
    {
      "id": "socket",
      "label": "ソケット",
      "control": "multi_select",
      "target": "filters",
      "value_type": "string",
      "unit": null,
      "options": [{ "value": "AM5", "label": "AM5" }]
    },
    {
      "id": "memory_slots",
      "label": "メモリスロット数",
      "control": "range",
      "target": "ranges",
      "value_type": "integer",
      "unit": null,
      "range": { "min": 2, "max": 8, "step": 1 }
    }
  ]
}
```

|Field|意味|
|---|---|
|`category`|検索APIと同じカテゴリID|
|`filters`|表示順に並ぶcurated filter定義。空配列も正当な契約|
|`id`|検索条件オブジェクトのキー。SQL名をクライアントが決定するものではない|
|`label`|日本語の表示名|
|`control`|`multi_select`または`range`|
|`target`|送信先の`filters`・`ranges`・`facets`|
|`value_type`|`string` (TEXT)、`integer` (INTEGER)、`number` (REAL)。モデル由来|
|`unit`|表示単位。単位が不要なら`null`|
|`options`|multi_selectのみ。`{value, label}`の配列。valueのJSON型を保持して送信する|
|`range`|rangeのみ。`{min, max, step}`。有効値が一件もなければ`null`|

- 空候補は`options: []`、空数値範囲は`range: null`。クライアントは該当controlを無効化または非表示にできます。データのないbooleanに0/1を補完しません。
- rangeはactive製品の有限値から取得した包含境界です。`min <= max`で、同値も有効です。INTEGERのstepは1、REALはregistryで表示単位に合わせて指定します。stepはUIの増分であり、検索APIが許可する数値の制約ではありません。観測された端点はstepに丸めません。
- null、空/空白文字列、不正な数値は候補になりません。文字列は検索APIが受理する200文字以内。候補valueは正規化し直さず保存値を返します。
- 文字列候補はlocaleに依存しないコード単位昇順、数値は昇順、filter自体はregistry順です。
- boolean相当も`value_type: integer`、valueは数値`0`/`1`。labelはregistry由来の「対応／非対応」「あり／なし」「空冷／水冷」等です。
- 1filterにつき最大512候補。製品名・sensor・switch model等は登録しません。上限超過は不完全な候補を返さず、非cacheの500として検出します。`verify:filters:local`で全カテゴリの上限を検証できます。

## POST /v1/searchとの対応

```json
{
  "category": "keyboard",
  "filters": { "manufacturer": ["Keychron"], "hot_swappable": [1] },
  "ranges": { "polling_rate_hz": { "min": 1000 } },
  "facets": { "connectivity": ["Bluetooth"] }
}
```

`target`を送信先、`id`をキーとして使います。multi_selectでは`options[].value`の配列を送り、rangeでは選択した`min` / `max`のみを送り、`step`や表示用labelは送信しません。未選択項目や空配列は送信しません。
同一filter内はOR、filter間はANDです。既存の複雑度制限（filters最大8項目、ranges最大8項目、facets最大4項目、各選択最大10値、合計最大16項目・40選択値）を維持します。

## Curated registry

`src/filter-schema.js`はUI用の選別・label・control・target・unit・step・boolean表示文言を管理します。型を重複保持せず`models[category].fields` / `.facets`から導出します。
startup validationは全カテゴリの登録、field/facetの存在、targetとcontrolと型の一致、重複ID、stepを検証します。common product fieldのUI露出は`manufacturer`だけを明示許可します。
`src/search-fields.js`のscalar解決を検索compilerとメタデータで共有し、CPU manufacturerは既存どおりspec、他カテゴリはproductsを参照します。既存compilerのcommon allowlistを拡張していません。

全カテゴリにmanufacturerを定義し、以下を追加しています。

|Category|manufacturer以外の主要filter|
|---|---|
|cpu|family、generation、socket、core_count、thread_count、boost_clock_ghz、tdp_w、includes_cooler|
|cpu_cooler|water_cooled、radiator_size_mm、height_mm、fan_size_mm|
|memory|ram_type、capacity_gb、module_capacity_gb、speed、kit_quantity、ecc、xmp、expo|
|motherboard|socket、chipset、form_factor、ram_type、max_memory_gb、memory_slots、m2_slots、back_connect|
|gpu|chip_vendor、chip_series、vram_gb、memory_type、length_mm、tdp_w|
|storage|storage_type、form_factor、interface、capacity_gb、pcie_generation、nvme|
|psu|form_factor、efficiency_rating、modular、wattage、length_mm、pcie_12vhpwr（個数range）|
|case|form_factor、max_gpu_length_mm、max_cpu_cooler_height_mm、max_psu_length_mm、volume_l、supports_back_connect|
|case_fan|size_mm、connector、flow_direction、pwm、quantity|
|monitor|screen_size_inches、refresh_rate_hz、panel_type、response_time_ms、hdr、adaptive_sync、aspect_ratio、**ports facet**|
|keyboard|switch_type、size、layout、hot_swappable、polling_rate_hz、**connectivity / features facets**|
|mouse|shape、size、weight_g、max_dpi、polling_rate_hz、**connectivity / grip_types facets**|
|headphones|headphone_type、ear_cup_type、weight_g、has_microphone、**connection_types / features / platforms facets**|
|webcam|resolution、frame_rate_fps、**connectivity_type facet**|
|microphone|**connectivity_type / polar_pattern / features facets**|
|os、accessory、capture_card、chair、desk、laptop、lighting、mousepad、network_card、prebuilt_desktop、sound_card、speaker、stand、thermal_compound、vr_headset|manufacturerのみ|

モニターの複合解像度controlはこの版にはありません。既存POST検索のresolution_width / resolution_height条件は利用可能です。raw JSONからの補完・推測は行いません。

## HTTP / cache / protection

- GET成功: 200。未登録category: 404 (`CATEGORY_NOT_FOUND`)。POST等: 405、`Allow: GET, OPTIONS`。
- query parameterは400。OPTIONSは既存public APIと同じ204/preflight検証、CORS `*`。
- 内部Cache API key: `/__catalog_cache/filters/v1/<category>?epoch=<CATALOG_CACHE_EPOCH>`。search/detail namespaceとは独立し、API変更時はfilter versionを更新します。
- TTLは600秒。epoch不正・未設定時は内部cacheをBYPASS。catalog releaseのepoch変更により旧metadataは再利用しません。
- ブラウザ向け`Cache-Control: public, max-age=0, must-revalidate`。固定URLにepochがないため、ブラウザ・通常のHTTP shared cacheは毎回再検証し、古いreleaseを独自TTLで保持しません。内部のepoch付きcacheがD1アクセスを抑制します。
- `X-Cache` / `X-Cache-TTL` / `Age`は既存utilityと同じです。HITは全limiter token・D1 query/operation/read/writeゼロ。MISSは`protectBootstrap()`でin-flight guard → `QUERY_REFILL_LIMITER` (2/10秒、canonical keyのSHA-256) → `BOOTSTRAP_MISS_LIMITER` (40/60秒) → `D1_MISS_LIMITER` (60/60秒)を通ります。Searchの20/60秒とFacetの30/60秒は消費しません。
- bootstrap許可・専用拒否は`rate_limit_class=bootstrap_miss`、`search_cost_class=bootstrap`。共通D1拒否は`d1_miss`です。専用tierを先に判定するため専用拒否でD1 tokenを消費しません。後段D1拒否で前段tokenを返却することはできません。
- bootstrap 429も既存の`RATE_LIMITED` / `Too many search requests`、`no-store`、`X-Cache: BYPASS`、`Retry-After: 60`、CORS `*`を維持し、D1 query/read/writeはゼロです。refill / in-flight拒否のRetry-Afterは10秒です。
- cache障害・epoch不正・Cache APIなしでは既存の`uncached` → expensive 20/60秒 → D1 60/60秒で保護してDBへフォールバックします（keyがあるlookup障害ではrefillも適用）。エラーは`no-store`、DBエラーは既存の秘匿化と503/500契約、binding障害はfail closedを維持します。

この分離は、**bounded-cardinalityかつcacheableなUI bootstrap trafficを、任意にunique queryを生成できるexpensive Searchからresource isolationするため**のものです。metadataはcategory allowlistとquery parameter禁止により各カテゴリ1つのcanonical keyに限定されます。
同じresource classに入る検索は、GET・keyword/cursor/追加条件なし・limit=20（省略可）・offset=0（省略可）・cache eligibleの初期category listingだけです。keyword、POST、cursor、非標準pagination、Product Detail/resolveはbootstrapに含みません。

```text
Bootstrap → QUERY_REFILL 2/10 → BOOTSTRAP 40/60 → D1 60/60
Expensive Search → EXPENSIVE 20/60 → D1 60/60
Dynamic Facet → FACET 30/60 → D1 60/60
```

Searchにもcache keyがあれば既存refillを適用します。全classの共通D1 budgetを維持し、metadataのread量が安価であるとは仮定しません。
exactな40→41はdeterministic testで検証します。productionでthresholdまでmetadataをcold取得するsmokeは行わず、確認する場合も1〜数requestの許可telemetryとMISS→HIT（HITのD1=0）に限定します。

## Query costと検証

scalarは全項目のDISTINCT / MIN / MAXを**1回のcategory index traversal**へまとめ、typed specはPK lookupします。メーカーのみのカテゴリはspec tableも読みません。
facetは追加1クエリでactive製品からproduct_id PK indexをprobeします。IN属性ごとの空probe増幅を避けるため、各製品の小さなfacet集合を一度読み、その後に属性を判定します。
本番D1では1回のbatch（1〜2 SQL statement）です。既存のpartial `products_category_manufacturer_series`とspec/facet PK indexを使い、新migration/indexは不要です。
catalog全体のfull scanはなく、scalarのread量は通常約2×カテゴリ製品数、メーカーのみなら約1×です。facet追加分はそのカテゴリの製品数とfacet行数に比例します。distinct/grouping用の一時B-treeは使用します。

```sh
npm test
npm run schema:check
npm run verify:filters:local
npm run verify:worker:local
npm run verify:plans
npm run benchmark:search
npm run release:verify -- --local
```

`verify:filters:local`は`verifyFilterMetadata(db, {snapshot, output})`を使用し、ローカルD1の全30カテゴリで契約・検証済みsourceとの候補/範囲一致・query plan・rows_read budget・rows_written=0・option上限を確認します。診断先は`.cache/filter-verification.json`です。
同じ関数をCIの固定実snapshot release gate、およびproduction公開前gateから呼びます。別DBを開かず、呼び出し元のDB/leaseを保持します。公開前の診断先は`.cache/release-filter-metadata.json`です。
`verify:worker:local` / production `verifyProduction`は共通Filter smokeを使用します。全30カテゴリのHTTP responseを独立source候補と比較し、代表8条件をPOST検索へ渡します（filters/ranges/facets、数値0/1、複数選択、片側range）。CORS/OPTIONS/400/404/405も確認します。
cache確認は初回HITも許容し、同一POPでの次回HITを要求します。POP移動時は最大3回、判定不能なら`inconclusive`を記録して検証を停止します。ローカルのexpiry/epoch/MISS→HITは決定的なテストで維持します。新しいbypassやTTL変更はありません。
一般検索/Detailサンプルとidentifierサンプルは分離し、検証済みsourceにも識別子がない場合に限りidentifierだけ`not_applicable`にします。
単体テストは全公開fieldの検索往復（filters/ranges/facets）、active限定、型、空/不正値、整合性検証、注入拒否、HTTP/CORS、cache epoch/expiry/HIT、障害時動作を検証します。

### 初回実装時の実測結果（ローカルD1、48,134 active製品）

|Category|MISS SQL数|MISS rows_read|HIT SQL数 / rows_read|
|---|---:|---:|---:|
|cpu|1|1,579|0 / 0|
|motherboard|1|7,403|0 / 0|
|gpu|1|7,675|0 / 0|
|storage|1|6,991|0 / 0|
|monitor|2|11,818|0 / 0|
|keyboard|2|14,827|0 / 0|
|mouse|2|19,957|0 / 0|

全30カテゴリを各1回cold取得した合計は120,819 rows_read、最大はmouseの19,957。全metadata queryでcatalog/facet full scanなし、rows_written=0です。
正確な全候補集計は小さな型番lookupより高コストですが、同snapshotのbrowse_filter検索p95（9,469 reads）に対し最大約2.1倍で、field数に比例した再scanはありません。600秒の内部cacheと既存MISS保護で頻繁な再集計を抑えます。
実HTTPで全カテゴリの200・direct D1一致・MISS→HITとWorker telemetryのHIT時D1 query/operation/readゼロを確認しました。

検証結果: `npm test` 185件成功（新規8件）、`schema:check`成功、`verify:plans` 45件成功、`verify:worker:local`成功（既存236検索ケース・30カテゴリDetail・resolve・新規30カテゴリfilters）、`benchmark:search`と`release:verify -- --local`成功。
ローカルD1を共有する検証ジョブの並列実行はMiniflareエラーになったため、D1検証は順次再実行しています。HTTP suiteは既存の3.5秒間隔を維持したまま完了できるよう、検証ジョブの上限を900秒から1,800秒へ延長しました。

差分snapshot B（48,223 active製品）の今回の測定は[差分release検証](incremental-release-validation.md)に分離しています。
直接検証の36 SQL / 36 adapter operationsと、Workerの36 SQL / 30 binding operations（各カテゴリ1 batch）は別の指標です。
欠けたメトリクスは`null`で不合格。EXPLAINおよびsync状態確認の診断queryはUI集計のrows_readから分離しています。
