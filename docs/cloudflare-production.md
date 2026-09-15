# Cloudflare D1 / Worker production運用

通常のsync→epoch→deployは [catalog release自動化](catalog-release.md) を利用する。
consumer向け基本契約は本documentの [API v1](#api-v1)。

最新の全量同期・deploy・実HTTP検証は [production-paid-baseline.md](production-paid-baseline.md)。
現在のGET cache設計・最新deploy・D1 read削減実測は [production-cache.md](production-cache.md)。
最新のD1 MISS/POST Rate Limiting・deploy・stampedeの未達事項は [production-rate-limiting.md](production-rate-limiting.md)。
最新のSQL read最適化・deploy・CPU/Free評価は [broad-query-read-optimization.md](broad-query-read-optimization.md)。
`ddr5` MISSは35,963→16,568 reads、broad corpus合計48.80%削減。候補・ranking・API/cache/rate契約は維持。
初回Free/partial時点の履歴は [production-baseline.md](production-baseline.md)。
派生FTSの現在の生成規則と0006適用結果は [FTS projection consistency](fts-projection-consistency.md)。
検索SQL、ranking、Golden expected、カタログ正規化は既存Phase 2を共有する。

## 認証・bindingの責務

|実行場所|接続|認証|
|---|---|---|
|Worker|`env.DB` D1 binding|API token不要|
|管理CLI / CI|`src/database.js` → D1 REST query API|API token環境変数、またはWrangler OAuth|
|provision / migration / deploy|Wrangler CLI|Wrangler OAuthまたはAPI token|

- `wrangler.json`: account ID、`DB → pc-parts-catalog` と実database UUIDのsource of truth。
- `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_D1_DATABASE_ID`: 管理CLIで明示した場合に優先。
- `CLOUDFLARE_API_TOKEN`: 管理CLI/CIの明示的認証。省略時はWranglerの公式authコマンドを
  子プロセスで実行し、OAuth tokenをメモリ内で取得する。子プロセスのstdout/stderrや例外詳細は公開しない。
- Workerにはtokenをsecret/varsとして登録しない。`.env*` / `.dev.vars*` / `.wrangler/` / `.cache/` はGit対象外。
- `env.local.d1_databases` はローカル専用環境。以前のローカルDBを再インポートせず使うため永続化キーを保持している。
  rootのproduction bindingには実UUIDだけを置き、preview_database_idは使わない。
  ローカルWranglerは `--local --env local`、本番はroot環境の `--remote` / deployを使う。
  各環境にはDB bindingが1つずつあり、同一環境で重複するbindingはない。
- `nodejs_compat` は共有 `queries.js → normalize.js` にある `node:crypto` importとの互換用。
  Worker bundleに管理CLI、Wrangler、sync、REST接続処理は含まれない。

## D1 provisioning / resume

リポジトリルート、Node 24 / npm / Wrangler 4.131.1で実行する。

```sh
npx wrangler whoami
# 未認証の場合のみ、ブラウザで承認
npx wrangler login
npx wrangler d1 list --json
```

同一アカウントの `pc-parts-catalog` があればUUIDを再利用する。
**存在しない場合だけ**次を実行する（自動binding追加による二重設定を避ける）。

```sh
npx wrangler d1 create pc-parts-catalog --location=apac --update-config=false
```

既存の `DB` entryの `database_id` と `account_id` を設定し、確認する。
Wranglerは名前よりconfigのUUIDを優先することがあるので、古いdummy UUIDのままinfoを実行しない。

```sh
npx wrangler d1 info pc-parts-catalog --json
npx wrangler d1 migrations list DB --remote
npm run db:migrate -- --remote
npx wrangler d1 migrations list DB --remote
npx wrangler d1 execute DB --remote --command "SELECT name,type FROM sqlite_schema ORDER BY type,name; SELECT * FROM d1_migrations ORDER BY id;"
```

0001〜0005はimmutableのまま、0006でFTSのbackfill/ingest投影を共通viewへ統一する。
適用済みmigrationはWranglerがskipする。0006は元データの再同期を要求しない。
products、全9 typed tables、identifiers view、両FTS、indexes、ingest/local identifier triggersを確認する。
失敗時は対象migrationと状態を調べる。DB削除/再作成、Time Travel restore、全件削除による復旧は行わない。

```sh
# 取得済みsnapshotのcommitと件数を確認。初回resume中はupstream:fetchでmainへ更新しない
npm run upstream:inspect
npm run sync -- --remote --dry-run
npm run sync -- --remote
npm run stats -- --remote --output .cache/stats-remote.json
npx wrangler d1 info pc-parts-catalog --json
```

新規環境へ同じsnapshotを取得する場合:

```sh
npm run upstream:fetch -- --ref eec0df175504ebd15f0f3e3a8249a18a22f00940
```

### Freeの日次予算

Freeはread 500万行/日、write 10万行/日、500MB/DB。日次リセットは00:00 UTC（09:00 JST）。
公式 [Pricing](https://developers.cloudflare.com/d1/platform/pricing/) / [Limits](https://developers.cloudflare.com/d1/platform/limits/) とDashboardの契約・残量を確認する。
`d1 info` の24h値はrolling windowで、UTC日の残予算そのものではない。Insightsにも反映遅延/集計差がある。

同期は既定1,000製品・run単位80,000 writesで `partial` を正常終了する。
日次予算を自動管理する機能ではないため、同日に無条件ループしない。
初回同期は数日に分け、同じsnapshotを再実行する。hash一致済み製品を再書込しない。
更新応答が失われてもwriteを盲目的retryせず、次runの保存済みhashでresumeする。

翌UTC日、他のwriterやmigrationに予算消費がなく、8万行を割り当てられる場合の例:

```sh
npm run sync -- --remote --max-products 4000 --write-budget 80000 --output .cache/sync-remote.json
npm run stats -- --remote --output .cache/stats-remote.json
```

最大製品数を増やしても実測write budget、25製品chunk、1.8MB bound値上限、lease、削除率guardは維持される。
80,000は次バッチの費用を厳密に保証する上限ではない。十分な余裕を残す。
日次枠エラー後は翌UTC日に再開し、leaseが残った場合は15分の期限を待つ。
初期sampleのwrite単価・所要日数・`perProductEstimate=500`評価は[実測](production-baseline.md#remote-syncのwrite実測とfree日数)を参照。

### Paidでの初回同期resume

Paidへ変更してもCLIの既定1,000製品/80,000 writesは自動変更されない。
今回の残26,690件は、同snapshotのdry-runで既存2,909件がunchanged・削除0を確認後、次で完了した。

```sh
npm run sync -- --remote --max-products 30000 --write-budget 2000000 --output .cache/sync-remote-paid-complete.json
npm run sync -- --remote --dry-run --output .cache/sync-remote-paid-confirm.json
npm run stats -- --remote --output .cache/stats-remote-paid-complete.json
```

実際のwriteは740,446行、約7分32秒。予算・chunk・lease・hash resumeの実装は変更していない。
以後の差分同期も、差分量と割当予算に応じて上限を指定する。PaidでもAPI/DBの技術的上限は残る。

## Remote品質・性能 baseline

全量同期が `complete` になりwriterが停止してから、各監査はbaselineとして一度実行する。
各コマンドは全カタログを読むので、繰り返す前にread残量を確認する。

```sh
npm run audit:completeness -- --remote --output .cache/completeness-remote.json
npm run audit:duplicates -- --remote --output .cache/duplicates-remote.json
npm run benchmark:search -- --remote --summary-only --output .cache/search-remote-phase2.json
npm run verify:plans -- --remote --summary-only --output .cache/plans-remote.json
node scripts/compare-search-runs.js .cache/phase2-expanded-after.json .cache/search-remote-phase2.json
npm run verify:api -- --remote --direct-only --output .cache/d1-remote-performance.json
npx wrangler d1 insights pc-parts-catalog --time-period=1d --json
```

`compare-search-runs.js` はfixture/検索実装hashとquery集合を検証し、Hit/MRR、0件検索、read行数、
SQL時間、query elapsed合計・p50/p95/max、top 10の `upstream_key` 順、commit/製品数差を保存する。
同じcomplete snapshotで順位差があれば非0終了する。DB内部IDや同期時刻が違うのでcatalog hash単独では一致判定しない。
同commitでも独自identifier、欠落行、ID tie-breaker、FTS corpusの差を調べる。ranking/expectedを変更して合わせない。

0006適用前は厳密top 10比較で5件の差があり、[当時の診断結果](production-paid-baseline.md#local-phase-2との厳密順位差)を履歴として保持している。
0006適用後はlocal upgraded / fresh / remoteの全FTS内容と120 queryのtop 20順が一致した。
その後のread最適化では、local161ケース・remote代表19ケースの全候補/score/結果不変を確認した。
query plansはbroad/generic等を追加して37件。新INDEX/migrationなし、CPU最大値とlatencyの非悪化は未証明なのでFree判断には実traffic観測も必要。
数値のstrict比較・跨runtimeの微小浮動小数差・費用計測手順は[0006検証結果](fts-projection-consistency.md)を参照。

`verify:api --direct-only` は主要11検索を既定3回ずつ、APIと同じLIMIT 21＋bound OFFSET 0で計測する。
認証取得時間をquery latencyには含めない。SQL durationとREST往復を含むelapsedを分ける。
partial DBの診断だけを行う場合は `--allow-partial` を明示できる。この場合の0件や時間は全量baselineではない。

## Worker development / deploy

手動で開発するターミナル:

```sh
npm run db:migrate
npm run worker:dev
# または npx wrangler dev --local --env local --persist-to .wrangler/state
```

`wrangler dev` は常駐しCtrl+Cまで終了しない。AI/CIによる自動検証には次を使う。

```sh
npm run verify:worker:local
```

8787がcatalogとして正常なら既存Workerを再利用し、そのプロセスを終了しない。
ポートが空いていればstdioを `.cache/worker-dev.stdout.log` / `.cache/worker-dev.stderr.log` へredirectし、
ウィンドウを開かず起動する。60秒以内のhealth確認、600秒以内のpaced HTTPテスト、所有プロセスtreeの終了までを行う。
既存の別サービスが8787を使っていれば停止・再起動せずエラーにする。
`npm run stats` や `verify:plans` など、別workerdを作るローカル管理コマンドは原則直列に実行する。

```sh
npm run check
npm run verify:plans -- --summary-only
npx wrangler deploy --env="" --dry-run --outdir .cache/worker-build
# remote full sync・品質確認後のみ
npm run worker:deploy
```

`worker:deploy` は `npm run check` → `scripts/catalog-release.js deploy`。
completed sync由来epochを自動設定し、release lease内でreadiness/FTS/integrity、37 plans、
固定120 Golden gate、config dry-run、Worker deploy、production smoke/contract/Goldenを実行する。
`scripts/worker-predeploy.js` は共有readiness gateのread-only入口として残す。
詳しいretry、設定保全、rollback手順は [release運用](catalog-release.md)。

deploy出力の実workers.dev URLで検証する（下記は今回公開したURL）。

```sh
npm run verify:api -- --url https://pc-parts-catalog.kikuuuty.workers.dev --remote --golden --paced --baseline .cache/search-fts-remote-after.json --output .cache/api-production.json
```

health/categories、主要11検索×3回、高度POST、固定120 Golden Queryの上位20件をremote directと比較する。
`--paced`は検証clientだけを間引き、本番limiterを有効のまま検証する。429を自動retryして隠さない。
baseline指定時は保存済みbenchmarkのtop 10順とも一致を要求する。
全量snapshotを要求し、測定前後のsync run/leaseの変化を検知したら失敗する。
同時syncや、同期経由でない手動補完を避けて測定する。

## API v1

### Frontend integration quick reference

- Base URL: **`https://pc-parts-catalog.kikuuuty.workers.dev`**。認証不要、credentialsなし。
- `GET /v1/categories` → `{"categories":["cpu","memory","motherboard","gpu","storage","psu","case","case_fan","cpu_cooler"]}`。
  UIはここからcategoryを取得する。category labelの表示方法はconsumer側で決められる。
- 基本形: `/v1/search?category=cpu&q=9800x3d&limit=20&offset=0`。
  `URLSearchParams`でencodeする。GETは`category`必須、`q`任意、`limit`既定20/最大50、`offset`既定0。
  同じparameterの重複、未知parameter、空文字qは400。q省略はcategory一覧。
- `data`と`meta`を読む。`meta.returned`は今回の件数で総hit数ではない。
  次ページは同条件/limitの`meta.next_offset`を使い、nullなら停止する。
  `has_more=true`でも1,000件windowに達すると`next_offset=null`になる。
- 製品参照には`upstream_key`（上流category/UUID）を保存する。UUID単体はcategory間重複があり、
  `id`はこのDB内だけで安定する。inactive化やcategory移動を跨ぐ永久存在保証はない。
  未知specはnull。spec queryはsoft boostで、下位結果まで必ず条件を満たす保証はない。
- `meta.source`のname/url/license/license_url/attributionをユーザーが確認できる場所へ表示する。
- 検索はGET/POSTともbrowser向け`no-store`。`X-Cache`、`X-Cache-TTL`、`Age`はedge cacheの観測用。
  `X-Request-ID`は障害照会用。これらをUIの正しさや永続キャッシュのversionとして使わない。
- CORSは`*`。POSTは`Content-Type: application/json`でpreflightされる。credential/custom認証headerは不要。

Frontend retry policy:

|応答|扱い|
|---|---|
|200、data=[]|正常な検索結果0件。障害扱いでretryしない。|
|400 / 404 / 405 / 413 / 415|入力・endpoint・method・bodyを修正。同じrequestを自動retryしない。|
|429|`Retry-After`を尊重し、同時検索を減らしてbounded retry。即時ループしない。|
|503 / 502 / 504 / network error|GETとread-only POST検索はbounded exponential backoff＋jitterでretry可能。Retry-Afterがあれば優先。|
|500|連続retryで隠さずエラー表示・request ID記録。利用者による再試行は可能。|

検索入力をdebounceし、古いin-flight requestをAbortControllerで破棄する。
上限回数/待機時間に達したら一時エラーとして表示する。失敗を製品0件へ変換しない。
同期を跨ぐpaginationで重複/欠落を検知したら先頭から再検索する。
価格・販売店在庫・BIOS/物理干渉まで含む互換性判定はこのAPI契約に含まれない。

### Endpoints

```http
GET /v1/health
GET /v1/categories
GET /v1/search?category=cpu&q=9800x3d&limit=20&offset=0
GET /v1/search?category=storage&q=990pro
GET /v1/search?category=gpu&q=rtx5080
```

healthは `SELECT 1 AS ok` を実行し、`{"ok":true,"database":"available"}` を返す。
実行直前に専用`HEALTH_LIMITER`（coloあたり60回/60秒）を判定する。拒否時は429、D1=0。
接続確認であり、全カタログ同期完了の判定ではない。categoriesは `src/model.js` 由来。
GET検索に指定できるのは `category` / `q` / `limit` / `offset`。qを省略するとカテゴリ一覧。

```http
POST /v1/search
Content-Type: application/json

{
  "category": "gpu",
  "keyword": "rtx 5080",
  "filters": { "chip_vendor": "NVIDIA" },
  "ranges": { "vram_gb": { "min": 16 } },
  "limit": 20,
  "offset": 0
}
```

POSTはcategory、keyword、filters、ranges、facets、identifier、orderBy、limit、offset、includeを受理する。
全カテゴリ拡張とincludeはローカル実装済み・production反映前。適用状況は [全カテゴリ対応レポート](all-categories.md) を参照。
URLへの追加query parameterは不可。filter/range/facet/identifierの意味とorderBy allowlistは既存検索契約と同じ。
`990 pro 2tb` のspecはsoft boostで、厳密な容量制約には `ranges` / `filters` を使う。

### Response

```json
{
  "data": [{
    "id": 123,
    "upstream_id": "<upstream UUID>",
    "upstream_key": "CPU/<upstream UUID>",
    "category": "cpu",
    "manufacturer": "AMD",
    "name": "AMD Ryzen 7 9800X3D",
    "series": "...",
    "variant": null,
    "release_year": 2024,
    "manufacturer_url": null,
    "specs": { "socket": "AM5", "core_count": 8 }
  }],
  "meta": {
    "limit": 20, "offset": 0, "returned": 1,
    "has_more": false, "next_offset": null,
    "window_limit": 1000, "window_exhausted": false,
    "source": {
      "name": "BuildCores OpenDB",
      "url": "https://github.com/buildcores/buildcores-open-db",
      "license": "ODC-By 1.0",
      "license_url": "https://opendatacommons.org/licenses/by/1-0/",
      "attribution": "Contains information from BuildCores OpenDB, made available under the ODC Attribution License."
    }
  }
}
```

表示例はspecsを省略。実際はcategoryのmodel定義にある全spec列を返し、欠損はnull。
共通製品列＋specsのallowlistでserializeし、raw、同期内部列、debug score、SQL、paramsは返さない。
POSTで `"include":["identifiers","facets"]` を指定すると、要求した情報を各製品に追加する。
identifiersはtype/value/region/origin/origin_fieldの配列、facetsはattributeごとの文字列配列。
include省略時の既存レスポンスは維持する。共通情報中心のカテゴリのspecsは `{}`。
`id` はこのDB内のID。DB間の製品比較にはcategoryを含む `upstream_key` を使う。
API利用サイトはユーザーが確認できる場所にsource attributionを表示する。

### Validation / cost limits

|入力|上限・契約|
|---|---|
|category|必須・model定義にあるカテゴリ（全カテゴリ拡張後30、`/v1/categories`参照）|
|keyword|非空、最大200 UTF-16 code units、NFKC後1〜12文字/数字tokens|
|limit|整数1〜50、既定20|
|offset|非負整数、既定0、offset + limit ≤ 1000|
|URL|4096文字以下、未知/重複query parameter不可|
|JSON|16,384 bytes以下、UTF-8、Content-Type application/json|
|filters / ranges / facets|それぞれ最大8 / 8 / 4 fields、合計16 fields|
|選択値|各field最大10、filters＋facets合計40、文字列最大200文字|
|ranges|min/maxのみ、有限number、min ≤ max|
|identifier|value必須・非空200文字以下、typeは既存allowlist|
|include|POSTのみ・identifiers/facetsの重複なし配列（最大2）。返却pageの取得に最大1 D1 query追加|
|未知field・不正型|HTTP境界で拒否。debug optionなし|

Content-Lengthだけに依存せず、streamをbyte計測して超過時に中止する。
さらに `searchQuery()` の列名/type/orderBy allowlistと100-bind制限を使う。
すべてのユーザー値とOFFSETはbound parameter。検索SQL/WHERE/ORDER BYを別実装しない。

### Pagination

同じ条件・同じlimitで `meta.next_offset` を次requestへ渡す。
既存relevance＋product IDのstable orderに `OFFSET ?` だけを付加する。
1回の検索でlimit+1件を取得し、COUNT(*)なしで次ページを判定する。
`has_more` は候補がさらにあること、`next_offset` は同じlimitで許可される次ページ。
同じlimitで次ページが1,000件window内に収まらなければnext_offset=null、window_exhausted=true。
深いoffsetでも候補のranking計算は必要。上限はread costを一定にする保証ではない。
同期中のページ間スナップショットは保証しない。同期直後やcache跨ぎでは重複/欠落があり得るので再検索する。

### HTTP / CORS / cache / observability

|Status|用途|
|---|---|
|200|正常|
|204|OPTIONS preflight|
|400|query、JSON形式、未知field、不正型、複雑度超過|
|404|不明endpoint|
|405|method不正（Allow header付き）|
|413|body size超過|
|415|Content-Type不正|
|500|想定外・非一時的DBエラー|
|503|DB timeout/一時障害/枠超過などはRetry-After: 30。rate binding障害はPROTECTION_UNAVAILABLE、10/60秒|
|429|RATE_LIMITED。refill/in-flightはRetry-After: 10、全MISS/expensive/healthは60。no-store、D1=0|

エラー形式は `{"error":{"code":"...","message":"..."},"request_id":"..."}`。
D1例外のSQL/stack/内部messageをクライアントへ返さず、エラーはno-store。

public read-only catalogとしてCORS `*`、credentialsなし。OPTIONSはrouteの許可methodとContent-Typeのみを受理する。
管理APIは別Worker/originと認証で分離する。CORSはrate limitやアクセス制御ではない。
Workers Rate Limiting bindingをvalidation→cache HIT判定の後、D1実行直前に適用する。
HITはlimiterを呼ばずD1=0。全MISS 60/60秒、expensive/POST/非cache paginationは追加20/60秒、refillは同key 2/10秒。
IPは使わない。colo-local / eventualなresource protectionであり、正確な課金quotaではない。
isolate内in-flight guardも併用するが、productionの6並列cold MISSではD1実行6のままで、stampede削減は未達。
binding/閾値根拠・障害時fail closed・Free availability要再確認は[rate protection詳細](production-rate-limiting.md)を参照。

GET検索の200だけを `caches.default` で300秒edge cacheする。対象はlimit=20、offset=0/20/40/60/80/100。
既存のAPI limit/offset上限は維持し、対象外pageは通常のD1検索を行う。
keyはorigin＋cache schema version＋catalog epoch＋TTL＋category/q/limit/offset。
parameter順、default値、encoding、q前後空白だけをcanonical化する。compact/spaced modelや内部空白は同一視しない。
検索のbrowser-facing responseはGET/POSTとも `Cache-Control: no-store`。Cache API保存responseだけ `public, max-age=300`。
categoriesの60秒HTTP headerは維持し、Cache APIには入れない。health、OPTIONS、全errorも保存しない。

同期完了後の `CATALOG_CACHE_EPOCH` は [release pipeline](catalog-release.md) がcompleted sync IDと
FTS/cache generationから決定し、一時deploy configへ適用する。Git上のepoch編集は不要。
requestごとのD1 version取得やKVは使わない。
更新を忘れた場合も各entryは保存時点から最大300秒で失効する。HITでTTLを延長せず、stale responseも返さない。
詳細なTTL比較・同期後手順・stampede制約は [cache運用](production-cache.md) を参照。

`X-Cache: HIT/MISS/BYPASS`、対象GETに `X-Cache-TTL`、HITに保存時点からの `Age` を返す。
`X-Request-ID` はHITでも毎回新規、`Server-Timing: d1;dur=...` は今回D1を実行した場合だけ返す。
Workerは構造化ログにroute、method、category、limit、offset、status、elapsed、rows_read/written、SQL duration、
cache_status、d1_queries、cache障害時のboundedなcache_errorを出す。HITはd1_queries=0、rows_read=0。
rate_limit_status、rate_limit_class、search_cost_classを追加。HITはnot_checked/not_classifiedで、classifier/hashも省略する。
URL全文、keyword、filter値、SQL、stack、token、IP、rate-limit keyはログに含めない。
Wrangler observabilityは初期診断用にlog sampling=1、invocation_logs=false。利用増加後は費用・保持量に応じsamplingを調整する。
Dashboard / `npx wrangler tail` でrequest IDを照合できる。health/categoriesやvalidation失敗に検索readを課さない。

`verify:api` はHTTP応答本文までの時間を取り、nearest-rank p50/p95/max、初回/反復を分ける。
Node fetchにbrowser cacheはなく、初回/反復はisolate cold/warmやcache hitの証明ではない。
CF-Cache-Status/Age/X-Cacheも保存する。`--golden --cache-repeat` は本文一致とGET HIT/POST BYPASSを検証する。
production HIT/MISS別のWorker metadata測定は `scripts/measure-api-cache.js` のrequest ID/tail照合で行う。
rows_read/writtenのdirect計測は比較用SQLの値。Worker側の値は構造化ログ/Insightsから別途確認し、同じものと断定しない。
Insightsはexperimentalの診断手段で、アプリの正しさや運用制御に依存させない。

## GitHub Actions

CIはtest/schema/local migration/全件syncに加え、共有release gateでplansと120 Goldenをfail-closedに評価する。
`.github/workflows/sync.yml` は週次/手動のpin→sync→検証→epoch→deploy→production検証を実行する。
既存名のCloudflare tokenにD1 EditとWorkers Scripts Editが必要。設定、retry、予算、
production変更記録は [catalog release運用](catalog-release.md) を参照。
