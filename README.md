# PC Parts Catalog

[BuildCores OpenDB](https://github.com/buildcores/buildcores-open-db)をcommit固定で検証・正規化し、Cloudflare D1へ差分同期するPC製品カタログです。Node.js 24.x / Wrangler 4.131.1を使用します。

## 正式な検索構成

```text
category → category registry → category-specific FTS → candidate retrieval
  → typed filters / facets / ranges → stable display ordering
  → cursor pagination (keywordはbounded OFFSET) → frontend selection
  → GET /v1/products/:id → canonical identifiers
  → GET /v1/products/:id/offers → JAN優先 / EAN-13 fallback exact lookup → Yahoo!ショッピング Offer

saved/shared build → source + upstream_key
  → POST /v1/products/resolve → current product ID/status
```

全30カテゴリで検索対象とBM25 corpusを一致させます。FTS名は`ftsName(category)`から決定します。
FTSは`text, name, manufacturer, series, variant, family`、`unicode61`、prefix `2 3 4`です。
他カテゴリの追加・削除は、そのカテゴリのBM25統計に影響しません。

**2026-09-18: production移行・HTTP検証完了。フロントエンドから利用開始できます。**
API: **https://pc-parts-catalog.kikuuuty.workers.dev**。48,134製品／30カテゴリ、FTS世代8、migration 0001〜0009。
切替・性能budget・復旧先・運用残件は[production移行記録](docs/production-transition.md)を参照してください。
設計・30 FTS一覧は[検索アーキテクチャ](docs/category-search.md)、実測と残件は[ローカル検証結果](docs/category-search-validation.md)を参照してください。

## ローカル開始

```sh
npm ci
npm run upstream:fetch -- --ref eec0df175504ebd15f0f3e3a8249a18a22f00940
npm run upstream:inspect
npm run db:migrate
npm run sync
npm run check
npm run verify:catalog
npm run verify:plans
npm run benchmark:search
npm run worker:dev
```

- 固定snapshotは48,134製品、30カテゴリ。上流の同commitのJSON SchemaをAjvで全件検証します。
- 取得先`.cache/upstream/`、ローカルD1`.wrangler/state/v3/d1/`。Cloudflare資格情報は不要です。
- `sync`は取得済みcommitを使用します。`--repo <path>`で既存のクリーンなcheckoutも指定できます。
- `.cache/`、`.wrangler/`、認証情報、データ本体はGit管理対象外です。
- 通常migrationと独立した既存snapshot cloneでupgradeを検証する場合:

```sh
npm run verify:search:local -- --source-location .cache/all-categories-fresh-location.json
```

このcommandはローカルsnapshotのコピーへmigrationを適用し、source照合、FTS integrity、UX品質、D1 cost、query plan、DBサイズを保存します。詳細は[検証手順](docs/category-search-validation.md)。

## 検索API

|Endpoint|用途|
|---|---|
|`GET /v1/health`|D1接続確認|
|`GET /v1/categories`|registry由来の30カテゴリ|
|`GET /v1/categories/:category/filters`|UI向けfilter定義・active catalogの選択肢・数値範囲|
|`POST /v1/categories/:category/facets`|現在条件と両立するmulti_select候補・件数（self-excluding）|
|`GET /v1/search?category=cpu&q=9800X3D`|簡易検索|
|`POST /v1/search`|keyword、typed filters、ranges、facets、identifier、orderBy|
|`GET /v1/products/:id`|選択した製品の詳細とcanonical identifiers|
|`GET /v1/products/:id/offers`|canonical JAN優先／EAN-13 fallback完全一致のYahoo販売候補（価格昇順、最大50件）|
|`POST /v1/products/resolve`|最大64 stable refsを現在のIDとactive/inactive/missingへ一括解決|

検索にはcategoryが必須です。通常候補一覧にはidentifierを付けません。必要なクライアントは既存の`include: ["identifiers", "facets"]`も使用できます。

```json
{
  "category": "motherboard",
  "keyword": "MAG",
  "filters": {"form_factor": "ATX", "chipset": "AMD B850"},
  "limit": 20,
  "offset": 0
}
```

`MAG → ATX → B850`のように候補を絞り込む操作を主要UXとします。入力field名・値はtyped modelに従います（memoryは`ram_type: "DDR5"`, `capacity_gb: 32`）。

- keywordなしdefault: manufacturer → series（NULLS LAST）→ name → id ASC、文字列はNOCASE。明示的`orderBy`はこのtupleの前に指定fieldを追加します。
- keywordあり: relevance → manufacturer → series → name → id。`orderBy`指定でもrelevanceが最優先です。
- 価格はcatalogに保持しません。将来のprice sortはProviderの価格データを統合する層の責務です。
- filtersは同field内OR・field間AND、rangeは包含境界。NULLは条件一致にしません。
- 既定20件、最大50件。keywordありは1,000件window＋`meta.next_offset`。keywordなしはwindowを持たず、`meta.next_cursor`を同一条件と送信します。nonzero OFFSETは400です。
- `window_exhausted=true`は絞り込みを促すUI状態です。詳細は[pagination契約](docs/pagination.md)。
- keyword GET検索は標準20件・先頭6ページだけedge cache。cursor・POST・resolveはBYPASS。ブラウザ向けは`no-store`、CORS `*`。
- 詳細なHTTP契約は[API文書](docs/cloudflare-production.md)、Product Detailは[詳細API文書](docs/product-detail.md)。

Yahoo!ショッピングProviderはcanonical `jan`のexact lookupを最優先し、選択できるJANがない場合だけ
安全なcanonical `ean`（EAN-13、region `jp`／`all`）へfallbackします。両方ない製品は外部検索せず
`lookup.status=unsupported`と空の`offers`を返します。価格はYahoo表示価格、送料は区分だけを保持し、
推定送料・PayPayポイント込み実質価格は計算しません。Offer cacheは既定30分、専用MISS予算は30回/60秒。
`YAHOO_SHOPPING_APP_ID`はsecretとして設定します（local: `.dev.vars.local`）。
API契約・照合／cache／保護の範囲・secret設定・任意の実API smokeは[Product Offers](docs/product-offers.md)を参照してください。
MPN/name fallbackとYahoo以外のProviderは未実装です。
どちらもYahooの`jan_code`へコード文字列を渡し、返却`janCode`の完全一致を必須とします。
canonical DBのEANをJANへ変換・追加せず、UPC／GTIN-14／EAN-8からの変換も行いません。
API／telemetry／cacheのstrategyは`jan`と`ean13_as_jan`を区別します。
AMD Ryzen 7 9800X3D（確認時product ID 372）のEAN `0730143315289`が代表例です。

カテゴリ別filter UIは`GET /v1/categories/:category/filters`の`control`・`target`・`value_type`・`options` / `range`から構築できます。
メーカーを含むcurated定義をbackendで管理し、選択値を`POST /v1/search`の`filters` / `ranges` / `facets`へ送ります。
初期候補はactive catalog全体が基準です。条件変更時には`POST /v1/categories/:category/facets`へ同じ`filters` / `ranges` / `facets`を送り、multi_selectの候補を`{value, label, count}`で更新できます。各field自身の条件だけを除外するself-exclusion方式です。rangeのmin/maxは引き続きstatic metadataを使用します。
空の候補・range、cache、カテゴリ別項目、送信例は[Filter metadata API](docs/category-filters.md)を参照してください。
Dynamicの契約・SQL設計・D1実測値は[Dynamic Facet API](docs/dynamic-facets.md)を参照してください。

**numeric id = current DB/runtime ID、source + upstream_key = durable shared reference**。
search/detailの両responseにidentity fieldsを含みます。共有URL・保存構成・favorites・localStorage・export/importはpairを保存し、復元時にbatch resolveします。
[Product Reference仕様](docs/product-reference.md)と[ブラウザ用adapter](examples/shared-build.js)を参照してください。

## 検索CLIと診断

```sh
npm run search -- --category cpu --keyword 9800X3D --verbose
npm run search -- --category motherboard --keyword MAG
npm run search -- --category cpu --identifier-type mpn --identifier BX80768285K
npm run search -- --query-file examples/gpu-search.json --explain
npm run stats
```

CLIとHTTPは同じ`searchQuery()`を使用します。`debug: true` / `--verbose`は内部診断用のscore、match type、BM25、spec scoreを返します。
`990pro`/`990 pro`等の限定した型番展開、exact identifier/name boost、strictゼロ時だけの限定fallbackを維持します。
queryのspec解釈は候補追加・加点であり、UIの厳密なtyped filterと同じ意味ではありません。

identifier exact keyはNFKC・前後trim・ASCII大文字化です。先頭0、ハイフン、内部空白を保持し、barcodeを数値化しません。
local identifierは別の索引で候補に加わりますが、製品BM25には参加しません。

## UX基準の品質評価

|Intent|主要指標|
|---|---|
|lookup|Hit@1/3/5、MRR、zero result|
|identifier|固定source snapshotのnormalized identifier所有集合に対してHit@1=100%|
|browse|candidate-window relevant coverage / precision、unexpected zero、contamination、window exhaustion|
|browse_filter|Recall/Precision、FP/FN、filter correctness、条件外製品0|
|filter_only|exact set equality、pagination correctness、deterministic sort|
|全intent|zero-result rate、rows_read/SQL duration median/p95、query plan、full scan、temp B-tree|

旧120件とextended102件のsource fixtureを保持し、UX overlayで旧10 browse failureを再分類しています。`search-ux.json`に実利用の11ケースがあります。
Browseは特定expectedの細かな順位で判定しません。relevant setはsource snapshotの独立条件・明示ID集合から導出します。
**人間による確認・承認はrelease条件にしません。** lookup111件を含め、品質チェックは機械評価します。
検索に違和感があるときだけ`npm run diagnose:search`を実行し、`http://127.0.0.1:8788`でカテゴリと検索語を試せます。
確認者名・理由・ノルマはありません。[ローカル検索チェック](docs/search-diagnostics.md)を参照してください。

```sh
npm run benchmark:search -- --output .cache/search-ux.json
npm run benchmark:search -- --category motherboard --verbose
npm run benchmark:ux
npm run benchmark:facets
npm run verify:ux:local
npm run release:verify -- --local
```

benchmarkは測定、release gateは自動チェックの合否判定です。人間の確認状態は読み込みません。
定義・floor・旧10件のbefore/after/UX理由・remote performance budget構造は[評価契約](docs/search-evaluation.md)を参照してください。

## Migration / sync / local data

`0001`〜`0007`は適用済みmigration履歴として保持します。`0008_category_fts.sql`をgeneratorで管理し、`schema:check`で一致を確認します。
今回追加の`0009_display_order.sql`は一覧用indexのみで、既存migrationは変更していません。
既存製品ID/raw/spec/identifier/facetを保って検索索引を移行します。normalizer versionは1です。

- `ingest`への1 SQL statementがproduct・raw・identifier・facet・typed spec・FTSをatomic更新。
- category変更は旧FTS/specを削除して新カテゴリへ登録。inactiveではFTSから削除、reactivateで復帰。
- hard deleteは依存行・FTSを削除。numeric IDのhigh-water markを保存して再利用を防止。
- partial syncはhashからresume。全追加更新完了後だけ削除を適用。lease/deletion guard/write budgetを維持。
- `local_identifiers` / `local_enrichments`は物理分離し、upstream syncでは上書きしません。
- local enrichmentをcanonical specへ暗黙に混ぜません。canonical identifier追加には`src/enrichment.js`を使用します。

```sh
npm run sync -- --dry-run
npm run sync -- --max-products 1000 --write-budget 80000
npm run audit:completeness -- --category gpu --field length_mm --by-manufacturer
npm run audit:duplicates -- --category gpu --manufacturer ASUS
```

完全性は値の存在率、重複監査は候補検出です。仕様の正しさや同一SKUの確定を意味しません。

## Releaseと運用

正式remote bindingは`wrangler.json`の`DB`、ローカルは`env.local`です。
管理CLIはWrangler OAuthまたは`CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN`を使用します。
Worker runtimeはD1・Rate Limiting bindingと、Yahoo用secret `YAHOO_SHOPPING_APP_ID`を使用します。

release pipelineはmigration履歴・catalog/FTS integrity・UX品質・performance gateを通過したときだけ、同期IDからepochを生成してdeployします。
releaseのepochは`sync-<id>-fts8-cache3`。現在のproduction D1は`pc-parts-catalog-fts8`です。
旧D1はrollback用に保持しています。intent別budgetは`docs/production-performance-budgets.json`が正式な既定値です。
production promotion commit `b08c5b416cfdd48fc36a13c0a288e39abbe943b9` はdefault branch `main`へpush済みです。
repositoryのD1 bindingは昇格済みproduction D1と一致し、scheduled/manual releaseはFTS8 generationを使用できます。
運用・復旧・credential設定は[release手順](docs/catalog-release.md)。

差分同期の更新履歴、source integrity診断、Filter API公開gate、固定snapshot間の検証・復旧は
[差分release検証](docs/incremental-release-validation.md)を参照してください。
`npm run verify:release:cross-snapshot`は専用ローカルDBを作り、固定A→Bの同期から全gate・Worker HTTPまで検証します。
通常CIの`cross-snapshot`ジョブでも実行し、既存の利用者用ローカルDBは使用しません。

## ライセンスと出典

BuildCores OpenDBの情報を含み、[ODC Attribution License 1.0](https://opendatacommons.org/licenses/by/1-0/)に基づき利用します。
再配布時は[NOTICE.md](NOTICE.md)、DBの`sources`、取得した上流noticeを保持してください。
