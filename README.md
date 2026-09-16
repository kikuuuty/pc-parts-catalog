# PC Parts Catalog

[BuildCores OpenDB](https://github.com/buildcores/buildcores-open-db)をcommit固定で検証・正規化し、Cloudflare D1へ差分同期するPC製品カタログです。Node.js 24.x / Wrangler 4.131.1を使用します。

## 正式な検索構成

```text
category → category registry → category-specific FTS → candidate retrieval
  → typed filters / facets / ranges → stable display ordering
  → frontend selection → GET /v1/products/:id → identifiers → price Provider
```

全30カテゴリで検索対象とBM25 corpusを一致させます。FTS名は`ftsName(category)`から決定します。
FTSは`text, name, manufacturer, series, variant, family`、`unicode61`、prefix `2 3 4`です。
他カテゴリの追加・削除は、そのカテゴリのBM25統計に影響しません。

**今回の変更はローカル検証段階です。productionへのmigration・sync・deployは実行していません。**
現行production APIとこのcheckoutのschema/API世代は異なります。
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
|`GET /v1/search?category=cpu&q=9800X3D`|簡易検索|
|`POST /v1/search`|keyword、typed filters、ranges、facets、identifier、orderBy|
|`GET /v1/products/:id`|選択した製品の詳細とcanonical identifiers|

検索にはcategoryが必須です。通常候補一覧にはidentifierを付けません。必要なクライアントは既存の`include: ["identifiers", "facets"]`も使用できます。

```json
{
  "category": "motherboard",
  "keyword": "MAG",
  "filters": {"form_factor": "ATX", "chipset": "AMD B850"},
  "orderBy": "name",
  "limit": 20,
  "offset": 0
}
```

`MAG → ATX → B850`のように候補を絞り込む操作を主要UXとします。入力field名・値はtyped modelに従います（memoryは`ram_type: "DDR5"`, `capacity_gb: 32`）。

- `orderBy`: `relevance`、`name`、`manufacturer`、`series`、その他allowlist内のtyped field。常にproduct IDでtieを安定化します。
- 価格はcatalogに保持しません。将来のprice sortはProviderの価格データを統合する層の責務です。
- filtersは同field内OR・field間AND、rangeは包含境界。NULLは条件一致にしません。
- 既定20件、最大50件。keywordありは1,000件window、keywordなしのfilter/listは100,000件window（reviewed catalog上限）。`meta.next_offset`を使用してください。
- GET検索は標準20件・先頭6ページだけedge cache。POSTはBYPASS。ブラウザ向けは`no-store`、CORS `*`。
- 詳細なHTTP契約は[API文書](docs/cloudflare-production.md)、Product Detailは[詳細API文書](docs/product-detail.md)。

## 検索CLIと診断

```sh
npm run search -- --category cpu --keyword 9800X3D --verbose
npm run search -- --category motherboard --keyword MAG --order name
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
|identifier|Hit@1=100%、明示したequivalent SKU set|
|browse|Recall@10/20、Precision@10/20、relevant coverage、contamination|
|browse_filter|Recall/Precision、FP/FN、filter correctness、条件外製品0|
|filter_only|exact set equality、pagination correctness、deterministic sort|
|全intent|zero-result rate、rows_read/SQL duration median/p95、query plan、full scan、temp B-tree|

旧120件とextended102件のquery/expectedを保存し、新classificationで再利用します。`search-ux.json`に実利用の11ケースを追加しています。
Browseは特定expectedの細かな順位で判定しません。relevant setはsource snapshotの独立条件・明示ID集合から導出します。
extended102件は人間レビュー待ちとして可視化し、正式releaseを停止します。

```sh
npm run benchmark:search -- --output .cache/search-ux.json
npm run benchmark:search -- --category motherboard --verbose
npm run benchmark:ux
npm run release:verify -- --local
```

benchmarkは測定、release gateは合否判定です。未達・レビュー待ちを期待値の自動変更で隠しません。
定義・floor・大きな集合のRecall@20上限は[評価契約](docs/search-evaluation.md)を参照してください。

## Migration / sync / local data

`0001`〜`0007`は適用済みmigration履歴として保持します。`0008_category_fts.sql`をgeneratorで管理し、`schema:check`で一致を確認します。
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
管理CLIはWrangler OAuthまたは`CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN`を使用し、Worker runtimeはD1 bindingだけを使用します。

release pipelineはmigration履歴・catalog/FTS integrity・UX品質・performance gateを通過したときだけ、同期IDからepochを生成してdeployします。
epochは`sync-<id>-fts8-cache2`。migrationのproduction実行は別フェーズです。
運用・復旧・credential設定は[release手順](docs/catalog-release.md)。

## ライセンスと出典

BuildCores OpenDBの情報を含み、[ODC Attribution License 1.0](https://opendatacommons.org/licenses/by/1-0/)に基づき利用します。
再配布時は[NOTICE.md](NOTICE.md)、DBの`sources`、取得した上流noticeを保持してください。
