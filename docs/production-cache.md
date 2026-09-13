# Production GET search cache — 2026-09-13

> 以下はcache導入時の記録です。現在は[Rate Limiting保護層](production-rate-limiting.md)を追加済みで、
> HITをlimiterへカウントせず、通常mixedの64 HIT / 36 MISS / 50,564 readsを維持しています。
> ただしproductionの分散cold stampede削減は未達です。

## 結果

**GET検索をCloudflare Cache APIでedge cacheし、HIT時のD1呼出し0をproduction tailで確認した。**

- URL: **https://pc-parts-catalog.kikuuuty.workers.dev**
- 最終Worker version: `9bee82dd-249d-44a2-b12f-3013ee59ad45`
- 最終TTL: **300秒**。browserは検索を `no-store`、Cache API内だけ300秒保持。
- `ddr5` 10回: **359,630 → 35,963 rows read（90%削減）**。
- 同一mixed 100 request: **753,939 → 50,564 rows read（93.2934%削減）**、64 HIT / 36 MISS。
- 120 Golden Queryのtop 20がremote directと一致。GET 119件のMISS/HIT本文一致、POST 1件の反復本文一致。
- 検索SQL・ranking・BM25・boost・fallback・FTS・migration・Golden/expected・製品データは不変。
- remoteは0001〜0006適用済み、sync complete、active=29,599、FK=0、live lease=0。
- **当面Paid維持を推奨**。D1費用は改善したが、Free CPU 10msに対して1件14msを観測し、日常trafficのhit率も未測定。

前提は [0006検証](fts-projection-consistency.md)、旧cache未実装時の履歴は [Paid baseline](production-paid-baseline.md)。

## Cache mechanismの選択

2026-09-13に以下の現行公式仕様を確認した。

- [Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)
- [How the Cache works](https://developers.cloudflare.com/workers/reference/how-the-cache-works/)
- [Workers Cache](https://developers.cloudflare.com/workers/cache/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)

|方式|今回の判断|
|---|---|
|HTTP `Cache-Control` のみ|旧productionは60秒headerがあっても全反復でD1実行。既存設定ではedge read削減なし|
|`caches.default` / Cache API|**採用**。D1 bindingで生成したJSONを直接保存。validation後のkey、GET/200限定、epochを既存Worker内で制御できる|
|zone Cache Rules / CDN `fetch` cache|外部originをfetchする構成ではない。workers.devを対象にユーザー所有zoneのrulesを置く構成にも合わない|
|現行Workers Cache (`cache.enabled`)|workers.dev対応、Worker実行前のcache、tiered cache、request collapsingが公式にある。ただしGET/HEADがentryを共有し、既存HEAD=405契約との調整が必要。validation後canonicalizationにはgateway/inner entrypoint等の追加構成が必要なためPhase 1では採らない|

Workers CacheとCache APIは別機構。今回 `cache.enabled` は有効にしていない。
Cache APIは**colo-local、best effort、tiered replicationなし、concurrent request collapsingなし**。
production workers.devで実動作を確認した。独自ドメイン移行後も同じ実装で使えるが、originをkeyに含むため新ドメインはcold startになる。

Cache API HITでもWorkerは実行される。HTTP request料金/Free request枠が消える設計ではない。
省略されるのはD1実行と結果の整形。既存validation（SQL生成を含む）はHIT前にも実行する。

## Cache design / HTTP契約

実装: `src/search-cache.js` と `src/worker.js`。

|項目|設定|
|---|---|
|対象|成功した **GET /v1/search、status=200** のみ|
|pagination admission|**limit=20、offset∈{0,20,40,60,80,100}**（default省略可）|
|対象外|POST、health、categories、OPTIONS、HEAD、全error、対象外pagination|
|API上限|従来どおりlimit=1〜50、offset+limit≤1000。cache対象外でも有効検索は通常実行|
|edge TTL|`SEARCH_CACHE_TTL_SECONDS="300"`。60/300/600を許可。`"0"`は運用上のcache停止用|
|epoch|`CATALOG_CACHE_EPOCH="sync-34aa2c91-d6eb-448b-8ece-05f027a156c2-fts6-cache1"`|
|browser / downstream|検索responseは **`Cache-Control: no-store`**。利用端末や別shared cacheへ古い検索を保持させない|
|Cache API保存response|`Cache-Control: public, max-age=300`。外向けresponseとは別に生成|
|観測|`X-Cache: HIT / MISS / BYPASS`、対象GETに `X-Cache-TTL: 300`、HITに `Age`|
|鮮度延長|stale-while-revalidate / stale-if-errorは使わない。HITでTTLを更新しない|
|cache障害|match/put例外はfail openして通常検索200を維持。ログにboundedな`cache_error=match/put`|

categoriesはmodel由来でD1を読まないためCache APIへ入れない。既存の60秒HTTP cache headerを維持。
POST/health/errors/OPTIONSはno-store。400/404/405/413/415/429/500/503を保存する経路はない。
cache導入時は429未実装だった。現在はrate protectionが429を返し、Cache APIへ保存しないことを検証済み。

### Canonical key

概念上の形式（実際は `URLSearchParams` による固定順のencoding）:

```text
https://<request-origin>/__catalog_cache/search/v1
  ?epoch=<catalog-epoch>&ttl=300&category=<category>&q=<trimmed-q>&limit=20&offset=<offset>
```

- category/q/limit/offsetのvalidation、未知・重複parameterの拒否を**先に**行う。
- parameter順、default limit=20/offset=0の明示/省略、paginationの先頭0、`+`と`%20`等をcanonical化。
- qは**前後trimだけ**。既存のname/identifier比較は前後trim、FTSはtoken化済みであり、実DBテストでも結果一致を確認。
- qの大小文字、NFKC、内部空白をcache側で統一しない。`990pro` / `990 pro` / `990  pro`は別key。
- q省略のcategory listingはq付き検索と分離。空q/空白のみqは従来どおり400。
- limit/offsetは必ずkeyに保持。limit≠20は今回cache対象外。offset=0と20は別entry。
- schema namespace `v1` は検索/response実装が変わる際に更新。epochはcatalog更新用、TTLもkeyへ入れて短縮時に古い長TTL entryを再使用しない。
- keyは元requestのheadersを複製しない新しいGET Request。Range/conditional headersによる206/304化やCookie/Origin別entryの乱造を防ぐ。
- 現APIは認証による個人別responseを持たず、CORS `*` のpublicな同一本文。将来認証/個別表示を追加する場合はcache契約も再設計する。
- 内部key pathを公開APIとして提供しない。外部から同pathへアクセスしても404。

全ての合法limit/offsetをcacheすると、1検索語だけで数万通りのentryを作れる。
今回は標準20件・先頭6ページへ限定。`offset<=100, limit<=20`だけよりfanoutが小さい。
q自体の種類は依然無制限であり、これはrate limiterの代替ではない。

### Response equality / CORS / telemetry

cacheには成功JSON本文とContent-Type、内部保存時刻のみを保存する。
HITでは本文をそのまま返し、現在request用のheadersを新規生成する。

- `data`の全spec、`returned/has_more/next_offset/window_limit/window_exhausted`、source/license/attributionを保持。
- `X-Request-ID` は毎回新規。MISSのIDやD1 `Server-Timing`をHITで再利用しない。
- `Age` は保存時刻から算出した秒数。`X-Cache-TTL`とともにCORS exposeする。
- `CF-Cache-Status` はこのCache API利用の状態を保証しない。`X-Cache`＋request ID照合を使う。
- structured logに `cache_status`, `d1_queries`, `rows_read`, `rows_written`, `sql_duration_ms` を記録。
  HITは呼出しcounter=0、read/write=0、SQL duration=null。MISSは実際のD1 response metadata。
  失敗したD1の費用はunknown（null）で、0として集計しない。
- 公開responseへrows_read、DB内部情報、SQL、debug scoreを追加しない。
- CORS `*`、credentialsなし、Allow/OPTIONSの既存契約を維持。

小さな `cache.put` はawaitしてからMISS responseを返す。直後の逐次requestがfill完了前に再MISSするraceを減らすため。
その分MISS latencyへ書込時間が加わる。concurrent requestへのlockではない。

## TTL比較 — 実production

同Workerコードを60/300/600秒のvarでdeployし、各deploy前に既存predeploy gateを実行。
5 query（ddr5 / rtx 5080 / ryzen 7 / 14900k / 990pro）、各3回の15 requestを2wave、wave間は65秒待機した。
TTL比較は他workloadから独立した **offset=80, limit=20**。結果が空になる型番ページも通常の200で、D1費用は実metadataを使用した。

|TTL|Requests|HIT|MISS|Hit率|D1 rows_read|HTTP p50 / p95 / max ms|
|---|---:|---:|---:|---:|---:|---|
|60秒|30|20|10|66.67%|74,948|18.79 / 214.49 / 308.13|
|**300秒**|30|25|5|83.33%|37,474|22.97 / 151.06 / 169.82|
|600秒|30|25|5|83.33%|37,474|22.65 / 149.65 / 155.13|

60秒は2wave目で再MISS、300/600秒は2wave目もHIT。全90 requestをtail照合し、HITのD1呼出し0をassert。
2wave目のHIT Ageは300秒TTLでp50=67/max=68秒、600秒TTLでp50/max=67秒。60秒TTLはrefill後のAge=0秒だった。
この時間幅では300→600の追加read削減はなく、鮮度の上限だけ倍になるので**300秒を採用**。
長時間の実trafficで300/600が常に同率という結論ではない。latencyは時刻/接続状態が異なる小標本。
別の300秒production計測では305秒待機後に再MISSを確認。offlineでは60/300/600のTTL境界をfake clockで確認。

## Catalog更新時の鮮度

|方式|実装・運用費用|鮮度|
|---|---|---|
|Option A: TTL only|最小。sync後deploy不要|同期完了前にfillしたentryが保存時点から最大300秒残る|
|**Option B: TTL + epoch**|**採用**。Worker var 1個＋sync完了後の明示deploy。D1/KVのrequestごとのversion readなし|新epoch適用後のrequestは旧entryを使わない。epoch更新を忘れてもTTLがfallback|

source_commitだけでは同commitでのlocal identifier追加や再処理を区別できないため、完了sync ID＋projection generation＋手動serialを使用する。
KV/DO等の新サービスは追加しない。catalog version取得のためのD1 queryも追加しない。

### 同期後の運用契約

1. 通常の同期を完了させ、latest sync=complete・writer/leaseなしを確認する。
2. `wrangler.json` rootの `CATALOG_CACHE_EPOCH` を **再利用しない新しい値** に更新する。
   例: `sync-<new-completed-sync-id>-fts6-<serial>`。英数字/`_`/`-`、1〜100文字。
3. 通常の品質確認後 `npm run worker:deploy`。既存migration/sync/FK/lease gateを通す。
4. GETのMISS→HITと、POSTとの本文一致を確認する。

同期やlocal identifier更新を行ってもWorker varは自動更新されない。既存週次sync workflowを含め、epoch deployは今回手動。
低頻度同期で即時freshnessが不要ならTTLに任せられるが、その場合は**各entryの保存時点から最大300秒**が契約。
検索処理中のrequestやdeploy伝播中の旧versionは旧結果を返し得る。新versionへ切り替わったrequestから新namespaceが有効。
同期中の新旧行混在・ページ間snapshot非保証は既存どおりで、完了後に検索をやり直す。
rollback時も古いepochへ戻さず新しいserialを使う。

誤設定でepoch欠落/不正、TTL許可外の場合はcacheをBYPASSして検索を継続する。
緊急cache停止はTTLを `"0"` にして通常gate経由でdeployする。無効化中に返す検索もno-store。

鮮度テストは実データの不要syncではなく、fake D1 responseを更新し、旧epochでは旧本文HIT、新epochではD1を1回だけ実行して新本文MISSとなることを検証した。
本番も最終deployでepochを更新し、Golden GET119件が全てcold MISSになった。全削除/purgeやDB書込は行っていない。

## Baseline / D1 read reduction

コード変更前にNode fetchでproductionを実測。HTTP本文受信完了までのelapsedと全headersを保存した。
`wrangler tail --format json` の `catalog_api.request_id` をHTTP `X-Request-ID`と照合し、**Worker自身のD1 metadata**を使用。
比較用remote direct SQLの費用をWorkerの費用として代入していない。

変更前122 request（repeated22＋mixed100）全てでD1実行・rows_written=0。
CF-Cache-Status/Ageはなし。異なるrequest IDと各回のD1 metadataがあり、60秒headerだけではedge cacheしていなかった。

### 同一検索のMISS / HIT

下表はGET limit=20 / offset=0。HIT時間は反復のnearest-rank p50。

|Query|Before reads/回|MISS reads|HIT reads|MISS HTTP ms|HIT HTTP p50 ms|反復|
|---|---:|---:|---:|---:|---:|---|
|ddr5|35,963|35,963|**0**|188.27|30.83|MISS＋9 HIT|
|rtx 5080|931|931|**0**|140.84|31.09|MISS＋2 HIT|
|ryzen 7|452|452|**0**|128.22|31.22|MISS＋2 HIT|
|14900k|49|49|**0**|123.37|33.94|MISS＋2 HIT|
|990pro|79|79|**0**|146.78|29.56|MISS＋2 HIT|

全てX-Cache-TTL=300、直後HITのAge=0〜1秒。HITはD1 counter=0、Server-Timingなし。
全本文が変更前baselineとdeep equality一致（全spec、pagination、attributionを含む）。

例: `ddr5` のrequest ID照合:

|Request ID|状態|D1 queries|D1 rows_read|Worker elapsed|
|---|---|---:|---:|---:|
|`ec7d2d3d-c4c7-4cdf-8366-955abc75e694`|MISS|1|35,963|156ms|
|`496a44ee-cc6a-4c23-a3ba-c784393a080b`|HIT|0|0|4ms|
|`f369a8d3-d002-4b66-be4f-b4e911ea4ecd`|HIT|0|0|4ms|

Cache HITにD1 response metadataは存在しない。実測の根拠は、MISSで取得したD1 metadataと、
HITで実行handlerへ入っていないcounter/log、さらにofflineのDB呼出しspyである。

|ddr5|Cacheなし|Cacheあり|削減率|
|---|---:|---:|---:|
|cold 1 request|35,963|35,963|0%|
|warm 1 request|35,963|0|100%|
|同条件10 request|359,630|35,963|**90%**|

## Mixed workload

同一順序・同一query/parameterの100 request:
ddr5×20、rtx 5080×15、ryzen 7×10、14900k×10、990pro×10、b650e wifi×5、他30 unique。
他30件は既存Golden fixtureから重複なしで選び、固定置換 `(i*37)%100` でinterleaveした。fixture自体は変更していない。
Nodeにはbrowser cacheなし。逐次送信し、tail到着確認後に次requestを送る小規模workload。
cacheあり側は先行repeated計測後305秒待ってcoldから開始した。負荷耐性や世界全体のtraffic比率を表すものではない。

|指標|Cacheなし|Cacheあり|
|---|---:|---:|
|HTTP searches|100|100|
|Cache HIT|0|64|
|Cache MISS|機構なし（全100件D1実行）|36|
|Hit rate|0%|64%|
|D1 rows_read|753,939|**50,564**|
|rows_read / HTTP request|7,539.39|**505.64**|
|D1 rows_written|0|0|

read削減は **703,375行 / 93.2934%**。高readのddr5を多くHITしたため、read削減率はHTTP hit率64%より大きい。
全100件の変更前/後の本文一致をassert。計測前後のsync run/lease状態も一致。

### Performance

HTTP本文受信完了まで。nearest-rank、単位ms。同一クライアント、CF-Rayは全てNRT。

|Mixed HTTP|件数|p50|p95|max|
|---|---:|---:|---:|---:|
|Before（cacheなし）|100|132.80|168.79|187.65|
|After MISS|36|143.26|200.36|767.57|
|After HIT|64|35.97|41.28|42.62|
|**After overall**|100|**37.90**|**164.62**|**767.57**|

Worker elapsedの全体p50/p95/maxはbefore **100/131/152ms** → after **8/129/647ms**。
HITは明確に短縮。MISSにはcache lookup/write費用が加わり、最大latencyの改善はない。
最大値は305秒待機後のddr5 MISS（request `75646721-e969-4ec9-b4f2-f98d7f1193c1`）。
SQL=202.2698ms、Worker elapsed=647ms、tail wall=660ms、CPU=14ms、rows_read=35,963。
この1点を除外して良い数字に置換していない。待機後の処理/通信変動を含み、原因をcold isolateと断定しない。

## Golden regression / smoke / tests

最終300秒deployで:

|指標|結果|
|---|---:|
|Query count|120|
|Hit@1|98.3333%|
|Hit@5 / Hit@10|100% / 100%|
|MRR|0.9895833333|
|Zero|0|
|API top20 = remote direct|**120/120**|
|保存済み0006後baseline top10一致|120/120|
|GET cache MISS→HIT、全本文一致|**119/119**|
|POST Golden BYPASS→BYPASS、全本文一致|1/1|

固定Goldenの1件は高度POSTであり、cache HITに変えていない。
Hit/MRRは保存済みbaselineのresolved expected製品集合に対し今回HTTPの順位から計算し、baseline rankもassertした。
測定中のcatalog状態を前後確認し、remote direct top20も今回実行した。

成功した検証:

- `npm test` / `npm run check`: **69 tests**、schema generator一致。
- `npm run verify:plans -- --summary-only`: **28/28**。
- `npm run verify:worker:local`: local Worker起動、120 HTTP/direct比較、所有プロセス終了まで成功。
- cache tests: canonical、順序/encoding/default、page別key、DB呼出しspy、TTL 3値、epochによる本文更新、POST/error拒否、CORS、pagination、response equality、cache failure fallback。
- 各production deploy前に既存 `worker-predeploy.js` を実行。gateコードは不変。
- 最終production smoke **30/30**、tail **30/30**照合。health/categories、GET、advanced POST反復、offset=0/20の40件非重複、canonical variant、cache対象外page、CORS/OPTIONS、400/404/405/413/415の各反復を確認。
- 実production障害を発生させる503/500注入は行わず、fake D1でno-storeを確認。

## Free plan換算 / Paid判断

公式Free枠: **D1 5M rows read/day、100k rows written/day、500MB/DB**、Workers **100k HTTP requests/day、CPU 10ms/request**。
枠は00:00 UTCでreset。HITでも本構成はWorker requestを消費する。

未cache workloadの平均 **7,539.39 rows/request** を基準に、queryのread単価とhit確率が独立の場合:

```text
mean rows per HTTP = 7,539.39 × (1 - hit rate)
daily HTTP searches = floor(5,000,000 / mean rows per HTTP)
```

|仮定hit率|平均reads/HTTP|5M reads相当のHTTP検索/日|
|---|---:|---:|
|0%|7,539.39|663|
|50%|3,769.695|1,326|
|80%|1,507.878|3,315|
|90%|753.939|6,631|
|**今回の実測64%（高read queryが多くHIT）**|**505.64**|**9,888**|

最後の行は上の独立モデルとは異なる**実測query別hit分布**。64%だけを他trafficへ当てはめて9,888件を保証しない。
地域分散、TTL切れ、eviction、unique query、POST/深いpage、stampedeで費用は変わる。
表はread枠を検索に100%使う上限試算。health、監査、sync、CLI、他DBのread用余裕を別途差し引く。
例えば今回分布が続くとしてread枠の半分を検索へ割当てると約4,944検索/日。

|判断材料|今回の観測|
|---|---|
|DB size|**141,815,808 bytes**（約135.25MiB）、Free 500MB/DB内|
|D1 read|cacheで大幅削減。ただし未cache ddr5相当のbroad queryが分散して来るとFree枠は依然小さい|
|Worker requests|上記試算では100k/dayより先にD1 readが制約になる|
|Worker CPU（mixed）|HIT p50/p95/max=**1/2/3ms**、MISS=**2/5/14ms**。100件中1件が10ms超|
|writes / sync|今回のAPIは全て0 writes。既存初回syncは813,837 writesで1日Free枠超。差分同期は変更頻度/量次第で、週次であるだけでは100k/day内を保証しない|

**現時点で「Freeへ戻して問題なし」とは判断しない。Paidを当面維持する。**
低traffic・高いlocal hit率・小さな差分同期でFree運用できる見込みは改善したが、CPU外れ値と実trafficのread分布を確認してから判断する。
D1 SQL待ち時間とWorker CPUを混同しない。Freeのruntimeには一時的CPU超過への柔軟性があるが、14msの観測を無視して安全を保証しない。
Cloudflareプラン設定は変更していない。

## Remaining issues

1. **Cache stampede**: Cache APIにはrequest collapsingなし。await putは逐次fill raceだけを抑える。分散lockやisolate内singleflightは未実装。現行Workers Cacheのgateway/inner entrypoint方式は将来比較候補。
2. **Rate limiting**: 後続の[rate protection](production-rate-limiting.md)で実装済み。unique q/POST/bypass pageをcolo-local limiterで保護。正確な課金quotaや分散mutexではない。
3. **D1 broad query自体のread最適化**: MISSのddr5は35,963 readsのまま。検索品質を変えない別タスク。
4. **同期運用**: 既存週次workflowはあるが、remote sync→complete確認→epoch deployの自動化は未対応。
5. **Free downgrade**: 実traffic観測、CPU外れ値の確認、read/write余裕の確保後にユーザー判断。
6. **Phase 3 fuzzy/typo search**、見積もりサイト連携等は別タスク。

## 再現コマンド / artifacts

計測はwriter停止中・Paid等でread予算を確保して行う。親 `.cache/` を事前に用意する。
`--baseline` は**cache実装前のWorker**で使う測定モードであり、production cacheを無効化するAPI bypassではない。
再実測のcold条件には全entryのTTL経過または新epochを使用する。任意のcache-buster parameterはAPIが拒否する。

```sh
# 実装前に取得したbaseline
node scripts/measure-api-cache.js --baseline --output .cache/cache-before-complete.json
# cold開始。repeated後305秒待ち、expiryとmixedを検証
node scripts/measure-api-cache.js --compare .cache/cache-before-complete.json --output .cache/cache-after.json
# TTLプローブ: 対応するTTLをdeployしてから実行（各deployに既存gate必須）
node scripts/measure-cache-ttl.js 300
node scripts/measure-cache-ttl.js 60
node scripts/measure-cache-ttl.js 600
# 最後にwrangler.jsonの300秒/最新epochへ戻し通常deploy
npm run worker:deploy
npm run verify:api -- --url https://pc-parts-catalog.kikuuuty.workers.dev --remote --golden --golden-only --cache-repeat --baseline .cache/search-fts-remote-after.json --output .cache/api-cache-golden.json
node scripts/verify-cache-smoke.js
node scripts/report-api-cache.js
```

各測定scriptはtailを時間制限付きで起動し、finallyで所有process treeを停止する。
保存するtail情報はapplication eventとCPU/wall/outcomeだけで、raw request headersや認証tokenを保存しない。
HTTP response headers、request ID、本文、実測D1 metadataは `.cache/` のJSONに保存。
tailイベント欠落を0 readsに置換せず失敗する。探索中にtail欠落と一時的D1 REST 403があり、そのrunは成功baselineに含めず、認証確認後の全件照合runを採用した。

|Artifact（Git外）|内容|
|---|---|
|`.cache/cache-before-complete.json`|実装前122 HTTP＋tail metadata|
|`.cache/cache-after.json`|最初の300秒deployでの122 HTTP、expiry、全本文比較|
|`.cache/cache-ttl-{60,300,600}.json`|各30 HTTP、2wave、TTL/age/D1比較|
|`.cache/api-cache-golden.json`|最終versionの120 query×2、remote direct top20、Hit/MRR|
|`.cache/cache-production-smoke.json`|最終versionの30 HTTP＋tail照合|
|`.cache/cache-summary.json`|read削減、latency、Free試算、CPU外れ値|

Deploy履歴: 最初の300秒 `18410638-f40b-4bf1-bda3-499c98430949` → 60秒 `cb821cce-6c41-4694-a809-bb0ab3a17e00`
→ 600秒 `437b36a1-113a-4cb7-a994-20b742544975` → 最終300秒/新epoch `9bee82dd-249d-44a2-b12f-3013ee59ad45`。
全て同じWorker bundle、実DB binding。検索データのsync/migrationはこの作業では実行していない。

Contains information from [BuildCores OpenDB](https://github.com/buildcores/buildcores-open-db),
made available under [ODC-By 1.0](https://opendatacommons.org/licenses/by/1-0/).
# 現在の同期後運用

epochの手動編集は [catalog release pipeline](catalog-release.md) に置き換わりました。
以下の計測値・cache設計はそのまま保持し、同期後の実行手順はrelease documentを参照してください。
