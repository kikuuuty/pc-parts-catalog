# Production D1 read protection — 2026-09-13

## UI bootstrap resource分離（2026-09-23、実装・offline検証）

**bounded-cardinalityかつcacheableなUI bootstrap trafficを、任意にunique queryを生成できるexpensive Searchからresource isolationします。** UI初期表示時のmetadataと初期一覧がSearchの20/60秒budgetを共有していたため、専用40/60秒へ分離します。Dynamic Facetの呼出し有無や、特定のカテゴリ数・開く順番に依存する特例ではありません。

```text
Bootstrap cold MISS → QUERY_REFILL_LIMITER 2/10
                    → BOOTSTRAP_MISS_LIMITER 40/60 → D1_MISS_LIMITER 60/60 → D1
Expensive Search    → EXPENSIVE_MISS_LIMITER 20/60 → D1_MISS_LIMITER 60/60 → D1
Dynamic Facet       → FACET_MISS_LIMITER 30/60     → D1_MISS_LIMITER 60/60 → D1
```

Searchもcache keyがあれば既存query refill / in-flight guardを先に適用します。normal Searchは専用tierなしで共通D1を通ります。

bootstrap対象はvalidation済みの次の2種類のみです。

- `GET /v1/categories/:category/filters`: category allowlist内、query parameterなし、内部Cache API MISS。
- `GET /v1/search`: allowlist内category、keywordなし、cursorなし、offset=0または省略、limit=20または省略、追加検索条件なし、cache eligibleかつlookup MISS。正規化後の入力fieldを`category / limit / offset`に限定します（undefinedは条件なし）。`filters / ranges / facets / identifier / orderBy / include`や将来追加されるfieldがあればbootstrapにしません。

既存GET contractで数値表記・parameter順序・default省略をcanonical keyへ正規化するため、別表記によってkey空間を増やせません。カテゴリごとにmetadataと初期一覧の2 keysだけです（同一origin / release / server-side cache policy内）。単なるGET・cacheable判定ではありません。
keywordは既存normal/expensive classifier、POST Searchはuncached/expensive、cursorと非標準paginationは既存保護を使います。Product Detailは高cardinalityなので従来のexpensive保護、Product resolveも従来どおりです。Dynamic Facetは独立30/60秒を維持します。

`protectBootstrap()`はrefill → bootstrap専用 → 共通D1の順です。専用拒否ではD1 token追加消費0。後段D1拒否ではbootstrap tokenを返却できません。Cache APIなし・設定不正/無効・lookup例外では既存uncached/expensive保護へ戻り、HITでは全limiter・D1を省略します。put例外もD1前の保護を通過済みです。

設定はproduction `29599006` / local `29599106`、両方40/60秒。既存namespaceは維持し、6 bindings × 2環境の全12 namespacesをstrict validationします。欠落・namespace/limit/period相違・重複は失敗し、`check-rate-namespaces.js`もproduction/local全IDのaccount内衝突を検査します。
telemetryは`search_cost_class=bootstrap`を追加し、専用許可/拒否は`rate_limit_class=bootstrap_miss`、後段拒否は`d1_miss`。429の公開契約とD1 queries/read/write=0を維持します。IP tracking、client指定budget key、public/admin bypassは追加しません。

deterministic testsは40許可→41件目専用拒否、20 Search＋20 Bootstrap＋20 Facetの独立budgetと61件目D1拒否、token非返却、canonical refill、in-flight、HIT token/D1=0、分類境界、fail closedを検証します。
既存`verify-rate-smoke.js`はSearchの`EXPENSIVE_MISS_LIMITER` contract smokeのままです。bootstrapのproduction 40→41 probeは追加しません。metadataのcold read量は大きくなり得るため、将来のproduction確認は1〜数requestで200 / allowed / bootstrap_miss、MISS時のみD1、次回HITならD1=0の観測に限定します。このbootstrap実装作業ではproduction deployを行いません。

実装後の検証結果:

- `npm run check`: schema一致、252 tests成功（skip 0）。`npm run verify:protection`: 29 tests成功。
- `node scripts/check-rate-namespaces.js`: account内1 Worker、production/local全12 namespacesで衝突0。strict configの欠落・namespace/limit/period相違・重複拒否は両環境でテスト成功。
- `node --check src/search-protection.js`、`git diff --check`: 成功。
- `npm run verify:worker:local`: 新40/60 bindingを含むWorker起動成功。ただし既存検証snapshot `992dacfa…`とlocal D1 `eec0df17…`が不一致のため、拡張HTTP suite前に停止（`.cache/api-local-production.json`）。
- 追加のlocal Worker限定確認: CPU metadataと初期一覧を各MISS→HITで取得し、全200・MISSのallowed/bootstrap_miss・HITのnot_checkedとD1 query/read/write=0・本文一致を確認。metadata MISSは1 query / 1,579 reads、初期一覧MISSは1 query / 42 reads。`q=ryzen`はexpensive_missを維持。これは拡張HTTP suiteの成功を代替するものではない。起動したWorker process treeは終了済み。

## Dynamic Facet rate分離（2026-09-23）

現行コードではDynamic Facetのbudgetを通常Searchから分離しています。以下のproduction実測・version情報は2026-09-13の導入時記録であり、この分離のdeploy実績ではありません。

```text
Facet → FACET_MISS_LIMITER (30/60秒) → D1_MISS_LIMITER (60/60秒) → D1
Search (expensive / uncached) → EXPENSIVE_MISS_LIMITER (20/60秒) → D1_MISS_LIMITER → D1
```

`protectFacet()`はvalidation後、Facet専用→共通D1の順で判定し、Searchのexpensive budget・query refillは使用しません。Facet専用拒否はD1 tokenを消費せず、D1実行0で429。後段D1拒否では前段Facet tokenは返却できません。
`POST /v1/search`とexpensive GET MISSの20/60秒、normal GET MISSのD1保護、cache HITのtoken消費0、query refill guardは維持します。
共通D1はFacet・Search・Bootstrapの合計request admissionを制限します。1 requestが複数SQLを実行してもtokenは1つです。「global」は全検索系で共有する意味であり、bindingのcolo-local / eventualな性質は変わりません。

**Facetの30/60秒は恒久値ではなくproduction telemetryを見て調整する初期threshold**です。route/colo別の`facet_miss`・`expensive_miss`・`d1_miss`の429率を分け、許可時の`rows_read`、`d1_queries`、SQL/HTTP latency、runtime CPU p95/max、503 `unavailable`を併せて確認します。Facetの拒否率だけを見てD1全体の余裕を判断しないでください。
threshold変更は`protectionBindings`・Wrangler production/localを同時に更新し、厳密なpredeploy検証を維持します。Facet分離時は5 bindings / 合計10 namespaces、上記bootstrap追加後は6 bindings / 合計12 namespacesです。

分離実装の検証（2026-09-23、production deploy前）:

- `npm run check`: schema check・233 tests成功（skip 0）。`verify:protection`は17件、Worker＋Dynamic Facet単独実行は26件成功。
- deterministic fake limiter: Facet 30件200、31件目429 / `facet_miss` / D1=0 / D1 token追加消費0。20 Search＋20 Facetは全件200。normal検索も合算したD1上限で`d1_miss`、後段拒否時のFacet token返却なしを確認。
- `worker-predeploy.js`: remote readiness成功。`check-rate-namespaces.js`: 現account 1 Worker、新Facetを含むproduction 5 namespacesの衝突0。production/local全10 namespacesの一意性は自動テストで確認。Wrangler dry-runで5 bindingsを確認。
- `npm run lint`はscript未定義。tracked JavaScriptの`node --check`と`git diff --check`は成功。
- 分離実装時の`verify-rate-smoke.js`は最初の200応答で`rows_read`の固定期待値49と実測29が不一致となり停止。そのrunは429 probe完了とは扱わない。後述のcontract smoke更新で固定値依存を解消。
- `verify:worker:local`の拡張API smokeは検証snapshot `992dacfa…`とlocal D1 `eec0df17…`の不一致でHTTP検証前に停止。別途、local Workerに対する既存`verify-api.js --url http://127.0.0.1:8789 --paced --rounds 2`は11検索×2回＋advanced POSTのHTTP/direct-D1照合に成功（`.cache/api-facet-rate-basic.json`）。拡張smokeの成功を代替するものではない。

deploy前にはcontract smokeと、検証snapshotの整合を取った拡張API smokeを実行する。新Facet bindingのproduction動作・telemetryはdeploy後に確認する。

## 結果と到達範囲

**Workers Rate Limiting bindingをproductionへdeployし、cache HITがD1保護tokenを消費しない経路、unique/uncached burst制限、429のD1実行0を検証した。**
Workers HTTP request料金はHITでも残る。

- URL: https://pc-parts-catalog.kikuuuty.workers.dev
- 最終Worker version: **`38fb9583-e54f-4614-a713-6af83afcf997`**。
- mixed 100件: **200=100 / 429=0 / 64 HIT / 36 MISS / 50,564 reads**。既存cache baselineと同じ。
- `ddr5` 10回: **1 MISS / 9 HIT / 35,963 reads**。cacheなし比90%削減を維持。
- 120 Golden Query: **top20 remote direct一致120/120**、Hit@1=98.3333%、Hit@5/10=100%、MRR=0.9895833333、Zero=0。
- 100 unique expensiveの**fake D1・deterministic limiter**: D1実行100→20、429=80、割当read 3,596,300→719,260（80%削減）。productionの課金実測ではない。
- 安価なproduction POST 24件: **200=21 / 429=3 / 1,029 reads**。429はD1=0、no-store。20設定に対する1件の超過も観測した。
- **production stampede抑制は未達**。6並列cold MISSは変更前・bindingのみ・isolate内guard追加後の全てでD1=6 / 294 reads。offlineでは2件へ抑えるが、本番の分散burstで「大幅削減」を実証できなかった。
- **Free downgradeは引き続き見送りを推奨**。Free binding利用可否は公式資料で要再確認、CPU 10ms超過も残る。

検索SQL、`searchQuery()`、ranking/BM25/boost/compact/spec/freshness/fallback、FTS、migration、Golden/expected、products/specs/identifiersは変更していない。
通常の成功本文は従来どおり。rate拒否は429、保護機構の障害は503。Cloudflareプランは変更していない。

## 公式仕様とmechanismの選択

2026-09-13に確認した一次資料:

1. [Workers Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
2. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
3. [WAF Rate Limiting Rules / availability](https://developers.cloudflare.com/waf/rate-limiting-rules/)
4. [workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)
5. [D1 pricing / daily limits](https://developers.cloudflare.com/d1/platform/pricing/)

|項目|確認した仕様 / 今回の判断|
|---|---|
|Wrangler|**4.36.0以上**。repositoryは4.131.1|
|設定|`ratelimits[]`、`name`、positive integer **string**の`namespace_id`、`simple.limit`、`simple.period`|
|period|**10秒または60秒のみ**|
|limit / key|`limit({ key: string }) → { success: boolean }`。callsを数える。remaining/reset時刻は返さない|
|namespace|同accountで同namespace＋同keyを使うbindingは、別Workerでもcounterを共有する|
|locality|**colo-local**。constant keyでもworldwide global counterにはならない|
|accuracy|**permissive / eventually consistent**。正確な会計counterや分散mutexではない|
|latency|同じmachine上にcounterをcacheし、colo内backing storeへ非同期更新。公式では`await limit()`はnetwork round trip待ちを加えない設計。絶対的なlatency数値の保証ではない|
|observability|binding自体はdashboardに表示されない。Worker Logs/Tracesの429またはAnalytics Engineで観測|
|Paid|今回のaccountでdeploy、binding呼出し、429を実確認|
|Free / 追加料金|確認したbindingページとWorkers pricingページには、bindingのFree利用可否・独立した料金の明記を確認できなかった。**要再確認**。Paid成功からFree対応/無料と推論しない。downgrade前にCloudflareの現行公式回答・契約とFree検証環境で確認する|

|方式|今回の適合性|
|---|---|
|**Workers Rate Limiting binding**|Worker内の任意の処理点で呼べる。validation→Cache API HIT判定後、D1直前にresource class別で適用でき、workers.devで動作確認済み|
|WAF Rate Limiting Rules|ユーザー管理zoneのsecurity rulesが基本。現在のworkers.devは管理する独自zoneではなく、公式上Free website扱い。Workers Paidとは別契約。Free WAFは1 rule、IP characteristic、10秒、cache exclusionなし。上位planのcache exclusionもこのWorker内部の`caches.default.match()`結果と同一だとは保証できない。**今回のD1直前admissionには採用しない**|

将来custom domain上でWAFを追加する場合も、HTTP request abuseとD1 read保護は別責務とする。

## Architecture

実装: `src/worker.js` / `src/search-protection.js`。既存`src/search-cache.js`を使用。

```text
Search / Filter metadata request（Dynamic Facetは上記の独立経路）
  ↓ route/method/body/HTTP validation
  ↓ searchQuery validation・SQL生成（DB実行なし）
  ↓ GET Cache API lookup
  ├─ HIT → 200（D1=0、classifier/guard/hash/limiterを全て省略）
  └─ MISS / BYPASS
       ↓ request-derived cost classification
       ↓ cache keyあり: isolate内 in-flight guard
       ↓ cache keyあり: QUERY_REFILL_LIMITER
       ↓ bootstrap: BOOTSTRAP_MISS_LIMITER / expensive・uncached: EXPENSIVE_MISS_LIMITER
       ↓ 全検索・bootstrap: D1_MISS_LIMITER
       ├─ denied → 429 / no-store / D1=0 / cache put=0
       ├─ unavailable → 503 / no-store / D1=0
       └─ allowed → 既存SQLを実行 → 同一JSON生成
                      ↓ eligible GET 200のみcache put
                      ↓ finallyでin-flight guard解放
```

「MISS budget」はcache非対象・cache障害も含む**D1検索admission budget**。
POST / `limit != 20` / offsetが0,20,40,60,80,100以外 / cache無効化はBYPASSだが必ず保護する。
cache match例外はuncached扱い。put例外が後で発生しても、D1実行前の全MISS制限は必ず通っている。
categories/OPTIONS/validation失敗はbindingもD1も呼ばない。healthは独立tier。

### Bindings / keys

|binding名|namespace|period|limit|key|対象|
|---|---:|---:|---:|---|---|
|`QUERY_REFILL_LIMITER`|`29599001`|10秒|2|canonical Cache API request URLのSHA-256、64 hex文字|cache keyを持つ非HIT検索|
|`D1_MISS_LIMITER`|`29599002`|60秒|60|`search-d1-miss`|D1へ進むSearch・Bootstrap・Facet・Detail/resolve|
|`EXPENSIVE_MISS_LIMITER`|`29599003`|60秒|20|`search-expensive-miss`|expensive GET MISS、Detail MISS、Search/resolve POST、非cache pagination、cache障害/停止（Dynamic Facetを除く）|
|`HEALTH_LIMITER`|`29599004`|60秒|60|`d1-health`|GET `/v1/health` のSELECT 1直前|
|`FACET_MISS_LIMITER`|`29599005`|60秒|30|`facet-miss`|POST `/v1/categories/:category/facets`|
|`BOOTSTRAP_MISS_LIMITER`|`29599006`|60秒|40|`bootstrap-miss`|cache eligibleなFilter metadata・canonical初期category listingのMISS|

namespaceはsecretではなくrepository内でstable。local環境は別namespace **29599101〜29599106**、同じthreshold。Facet用はproduction `29599005` / local `29599105`、Bootstrap用は`29599006` / `29599106`。既存IDは維持します。
`scripts/check-rate-namespaces.js`でaccountの現在のWorker設定をread-only列挙し、**1 Worker、他bindingとの衝突0**を確認した。
将来の別Worker/過去version/手動設定まで永続予約するregistryではない。新規namespace導入時・他Worker追加時にも照合する。

isolate内guardは同keyで同時2件、最大128 active keys。requestのD1・cache put完了/失敗時に解放する。
上限到達は`query_inflight`として429。時間window counterや永続mapではなく、使うのはin-flight時だけ。
128はquery費用からのquotaではなく、eventualな超過や遅いD1でもisolate内メモリを有限にする防御上限。

refillを先に判定し、同一keyの拒否が他の予算を消費するのを避ける。
expensive / bootstrap / facetの専用tierを共通D1より先に判定し、専用拒否で他class用のD1 tokenまで枯らさない。
各bindingは非transactionalで、後段で拒否されても前段のtokenは返却できない。
refill token取得後にexpensive/bootstrap/globalが拒否すると、そのkeyの次のrefillが10秒window内で拒否される可能性がある。
**その場合も既存HITは通す**。上限はD1成功件数ではなく各binding呼出しadmissionに対する近似値。

### Identity / privacy / fairness

**IPを使用しない**。`CF-Connecting-IP`、IPv4/IPv6の表記、NAT/VPN/proxy、任意のclient headerでbudgetを分割しない。
mobile carrier NAT、corporate NAT、VPN、privacy proxyの共有IPで無関係ユーザーを個別ユーザーと誤認する問題を避ける。
安定user ID/API keyがないため、今回の中心はresource protectionであり、ユーザー別fairnessは実現しない。
同colo内で攻撃者がresource予算を消費すれば、他の正当なMISSも429になり得る。人気HITは維持できる。

query hashはbinding呼出しだけに使用し、ログ・D1・KV・Analyticsへ保存しない。
in-flight mapのcanonical keyも処理中メモリだけで解放する。raw IP、user tracking、persistent query registryは作らない。
hashは匿名性の証明ではないので、将来ログへ追加することもしない。

## Baselineとclassifier評価

threshold設定前にproduction APIで11検索を実測した。tailの`request_id`とHTTP `X-Request-ID`を照合し、
**Worker自身のD1 metadata / runtime CPU**を記録。REST costをWorker costへ代入していない。
標準GETは独立した合法pageのoffset=60、deep=120、limit変更=10/offset60、POSTはoffset0。
最終実装でも同じ11条件を実測し、**全本文・rows_readが不変**。すべて200。

|分類 / query例|rows_read 前=後|SQL ms 前→後|CPU ms 前→後|HTTP ms 前→後|predicted|
|---|---:|---|---|---|---|
|exact model: 14900k|49|23.96→11.49|9→10|201.20→183.26|normal|
|manufacturer + model: intel 14900k|48|11.54→7.98|11→4|202.25→137.89|normal|
|family: ryzen 7|452|12.53→7.77|3→3|184.38→125.64|expensive|
|model + spec: 990 pro 2tb|99|17.91→7.55|5→5|133.33→140.40|normal|
|spec-only combined|2,590|69.34→24.05|8→7|276.90→161.41|expensive|
|spec-only broad: ddr5|35,963|183.59→65.55|4→3|328.72→187.04|expensive|
|single generic: corsair|18,293|203.21→42.24|3→4|321.58→170.68|expensive|
|category listing: memory|14,515|15.80→9.80|2→2|145.54→145.68|expensive|
|POST advanced: GPU filters/range|931|31.93→35.17|6→4|164.68→161.52|uncached|
|deep pagination: ddr5 offset120|35,963|37.83→25.70|3→2|164.67→140.90|uncached|
|nonstandard limit: ddr5 limit10|35,963|30.30→33.85|1→2|146.38→158.90|uncached|

before/afterは時刻の違う小標本で、SQL/HTTP時間の改善をlimiterの効果と断定しない。
baseline合計は前後とも144,866 reads。healthのSELECT 1は通常0 rows_readのmetadataでも**D1 query 1回**と通信/処理を消費する。

### `classifySearchCost(input)` の一般則（現行）

- `protectSearch()`を通るPOSTまたはcache非対象/使用不能 → **uncached**（expensiveと同じ20/60 tier）。Dynamic Facetはこのclassifierを通らず専用30/60 tier。
- cache eligible GETで前述のcanonical初期category listing → **bootstrap**（専用40/60 tier）。Filter metadata MISSも`protectBootstrap()`を直接通る。
- 上記以外でkeywordなし → **expensive**（cache非対象なら先にuncached判定）。
- 既存`parseSearchIntent()`の`specOnly` / `family` / `identity` → **expensive**。
- 残余tokensに3〜5桁数字と短い英数字affixによるmodel-like tokenがある → **normal**。
- その他のgeneric/manufacturer/自然言語 → **expensive**。

`ddr5`等のquery文字列ハードコードはない。判定だけに既存intent parserを再利用し、SQLへ渡すinputは変更しない。
identifierやfilterの存在だけでcheapと信用しない。POSTは常にuncachedであり、keywordのidentifierらしい形状でも実cost保証はできない。
familyが安価なCPU例を含んでも保守的にexpensiveへ送る。

今回11件＋保存済み同snapshot remote Golden 120件の計131件に対し、説明用のactual expensive境界を**5,000 rows/query**とした。
cheapの目安は100行未満、mediumは100〜4,999行。以下の導入時集計はnormal/expensive/uncached。現行runtimeにはresource classとしてbootstrapを追加したが、cheap枠の無制限許可は設けない。bootstrapも低read量の保証ではない。
保存済みGoldenのrowsはbenchmark自身のlimit/scan条件で、WorkerのLIMIT21＋OFFSETとは区別して記録した。

|predicted|件数|actual rows p50 / p95 / max|
|---|---:|---|
|normal|46|79 / 955 / 1,959|
|expensive|81|1,753 / 16,469 / 35,963|
|uncached|4|931 / 35,963 / 35,963|

- actual ≥5,000をnormalへ送るfalse negative: **0/21**（今回の131標本内）。
- actual <5,000でもrestricted tierへ送る保守的判定: **64件**。
- 学習済みcost estimatorではない。未観測query、model-like文字列、将来のデータ増大等でfalse negativeは発生し得る。
  **normalにも必ず全MISS limiterを適用**する。classifierがD1 read上限を保証することはない。

### Threshold rationale

|設定|根拠とtrade-off|
|---|---|
|全MISS 60/60秒|既存mixed 100件には36 MISS。全件を同一window内に置いたoffline replayでも429=0、24件の追加admission余裕。normal query実測は概ね数十〜千行台だが、model-like abuseにも有限budgetを置く|
|expensive/uncached 20/60秒|同mixedのrestricted MISSは13件。20は約1.54倍の余裕。通常の数回のadvanced POSTやpage送りを許容しつつ、broad/POST/深いpaginationを同じresource予算で囲う。実ユーザーtraffic未観測のため初期値|
|Facet 30/60秒|フィルター操作のFacet呼出しを通常Searchと別budgetにするための初期threshold。production telemetryを見て調整可能。D1全体の60/60秒は引き続き共通|
|Bootstrap 40/60秒|boundedなcacheable UI初期readを任意unique Searchから隔離する専用budget。refill 2/10秒で同keyの重複消費を抑え、共通D1 60/60秒を最終admission上限として維持|
|query refill 2/10秒|1回のrefillが通常100〜数百ms、TTL=300秒。1件だけよりretry/失敗への余裕を取り、10連打のうち少数だけを許可する狙い。eventual consistencyによる初期burstの弱点は後述|
|health 60/60秒|1分に数回のmonitor＋運用確認に余裕を持たせる。1秒あたり1 probe相当のresource枠。search予算を減らさず安価なconnectivity probeを維持|

35,963行×20件は**719,260行/window相当**。Free 5M/dayの約14.4%であり、同じ利用が約7 window続くだけで5Mに達し得る。
他のnormal/health/管理query、複数colo、window境界、eventual超過もあるため、**5M/dayを60秒limitへ換算した課金制御ではない**。
PaidのD1 included readは25B/month、その後$0.001/M reads。rate保護はrunaway readを減らすが、
低い追加read単価だけでavailability・Worker request/CPU/log料金を無視しない。billing alert等を併用する。

## 429 / 障害時契約

```http
HTTP/1.1 429 Too Many Requests
Cache-Control: no-store
Retry-After: 60
X-Cache: BYPASS
Access-Control-Allow-Origin: *
```

```json
{
  "error": { "code": "RATE_LIMITED", "message": "Too many search requests" },
  "request_id": "<current request UUID>"
}
```

refill / in-flight拒否は`Retry-After: 10`、global/expensive/bootstrap/facet/healthは`60`。Facetはrefillを使わず、公開429 messageも既存の`Too many search requests`を維持。
healthのmessageは`Too many health requests`。正確なreset時刻ではなく**再試行までの保守的な推奨秒数**であり、
その後の成功を保証しない。clientはRetry-After後にjitter付きで再試行し、連打しない。
`Retry-After`はCORS exposeする。新しいrate/remaining/debug headerは設けない。

429はD1より前にreturnし、Cache APIへ保存する処理へ到達しない。browserにもno-store。
binding欠落・例外・不正な戻り値は **503 `PROTECTION_UNAVAILABLE`** とし、該当bindingの10/60秒をRetry-Afterに使う。
例外の内部message/SQL/stack/keyを返さない。既存D1一時障害503のRetry-After=30は維持。

**fail closedを選択**。limiter障害時にD1を無制限にfail openしない。MISS/health availabilityは落ちるが、
cache HIT/categories/OPTIONS/validation errorはlimiterに依存しない。
cache障害だけなら、保護判定を通った上で既存D1検索を続行する。

### Validationの検討

before/afterの合法入力範囲は同じ。1文字query（例`a`や`7`）も通常200で、genericはexpensive扱い。
既存1〜12 tokens・200文字・16KiB JSON・offset+limit≤1000の上限を維持する。
1文字全拒否やpagination window縮小は既存合法queryを変えるため今回は導入しない。
大量tokens/極端なoffsetは既存validationで400になり、rate tokenもD1も消費しない。

## Normal workload / cache回帰

既存mixedと同一query/順序。coldから開始し逐次実行、全HTTP/tailを照合。前後のcatalog stateも一致。
以下beforeは**既存Cache APIあり・rate protectionなし**。afterは今回の最終version。

|mixed 100|Before|After|
|---|---:|---:|
|HTTP requests / 200 / 429|100 / 100 / 0|100 / 100 / 0|
|HIT / MISS|64 / 36|64 / 36|
|cache hit率|64%|64%|
|D1 executions|36|36|
|rows_read|50,564|50,564|
|rows_written|0|0|
|HTTP p50 / p95 / max ms|37.90 / 164.62 / 767.57|34.50 / 146.58 / 554.34|
|HIT HTTP p50 / p95 / max ms|35.97 / 41.28 / 42.62|33.00 / 36.27 / 40.36|
|MISS HTTP p50 / p95 / max ms|143.26 / 200.36 / 767.57|133.36 / 166.76 / 554.34|
|Worker elapsed p50 / p95 / max ms|8 / 129 / 647|5 / 114 / 451|
|Worker CPU p50 / p95 / max ms|1 / 5 / 14|1 / 3 / 11|
|HIT CPU p50 / p95 / max ms|1 / 2 / 3|0 / 1 / 3|
|MISS CPU p50 / p95 / max ms|2 / 5 / 14|2 / 3 / 11|

msはnearest-rank、CPUの0はruntimeの計測粒度を含む。異時刻の小標本でCPU短縮の因果関係は主張しない。
**HIT pathのCPU増加は観測しなかった**。MISSには最大11ms、stampedeでは12msがあり、Free 10msに対する余裕は未解決。

旧cacheなしmixed=753,939 readsに対する**93.2934%削減を維持**。
`ddr5`10件=359,630→35,963 reads（90%削減）、10/10が200。
繰り返し22件、mixed100件の全本文が保存済みcache導入前production本文とdeep equality一致した。
305秒経過で再MISSし、HITでTTLが延長されないことも確認した。

## Stampede: 実測で分かった限界

productionは高コストqueryを避け、`cpu / 14900k / offset100`をTTL経過後に6並列。

|実production|requests|200|429|HIT|D1 executions|rows_read|
|---|---:|---:|---:|---:|---:|---:|
|Before|6|6|0|0|6|294|
|bindingのみ|6|6|0|0|6|294|
|binding + isolate内guard|6|6|0|0|6|294|

最終burst HTTP p50/p95/max=205.93/215.69/215.69ms、CPU=6/12/12ms。
直後の10回は前後とも10 HIT / D1=0。最終HIT CPU=1/1/1ms。

**このproduction条件ではread削減0%。成功条件「同一cold query burstを大幅に抑制」は満たせていない。**
同keyのcounter同期前に分散実行が通る現行bindingの性質と整合する。
isolate識別子をログへ追加していないため、何台・何isolateへ配分されたかを正確に断定しない。
isolate内guardは同時10件→2 D1 / 8×429をofflineで確認し、per-query binding単独も逐次cold refillsの3件目拒否を確認した。
しかしどちらもproductionのinitial fanoutをglobal mutexに変えるものではない。

完全なrequest collapsingは提供しない。`exactly 1`や`colo内で必ず2以下`と説明してはならない。
この残件を解消するには、**Workers Cacheのrequest collapsingまたは明示的な分散refill coordination**を別途評価する必要がある。
Workers Cache移行には既存HEAD=405、canonical validation、gateway/inner entrypoint、Cache API置換の設計が伴う。

## Unique-query / uncached abuse検証

productionで100件の高read queryは送らず、`test-support/`のfake envで同一60秒windowを再現。
全bindingを許可するbeforeと、productionと同じthresholdのdeterministic fake bindingを使うafterを比較する。
fake D1はSQLを記録し、各実行に**35,963 rows**のcost metadataを割り当てる。全体の数値は**calibrated simulation**。

|100 attempts / scenario|Before D1|After allowed / 429|After D1|Before → After assigned rows|削減率|
|---|---:|---|---:|---|---:|
|unique expensive GET|100|20 / 80|20|3,596,300 → 719,260|80%|
|unique normal-shaped GET（classifier false negative想定）|100|60 / 40|60|3,596,300 → 2,157,780|40%|
|5カテゴリ、34 cacheable GET＋33 deep GET＋33 POST|100|20 / 80|20|3,596,300 → 719,260|80%|
|unique POST|100|20 / 80|20|3,596,300 → 719,260|80%|
|unique keyword＋deep pagination|100|20 / 80|20|3,596,300 → 719,260|80%|

unique expensiveにはtokenを保持した句読点suffixの100 variantsを使い、canonical keyが全て異なる合法入力を生成する。
mixedは各カテゴリ内でも全keywordが異なり、paginationは合法120〜900に分散する。
normal-shaped caseの実SQLが35,963行読むと実測したわけではなく、classifierをすり抜けた高costへのglobal保護を評価するための仮定。
fakeのexact countをeventualなproductionへ外挿しない。

### Production Rate Limiting contract smoke

`node scripts/verify-rate-smoke.js`はSearchの200/429保護契約とD1 pre-admission protectionを確認する。固定のSQL read量・query数・検索結果件数は検証せず、検索品質・結果一致・コスト評価は既存benchmark / API verificationに任せる。

- 共通: HTTP 200または429、`Cache-Control: no-store`、`X-Cache: BYPASS`、`X-Request-ID`、telemetryのstatus/request IDがHTTP応答と一致。
- 200: `rate_limit_class=expensive_miss`、`rate_limit_status=allowed`、有限の`d1_queries > 0`、有限で非負の`rows_read`。query分割やcatalog更新によるread量変化を許容する。200の`d1_miss`は不正。
- 429: `rate_limit_class`は`expensive_miss`または`d1_miss`のみ許容。`Retry-After: 60`、CORS `*`と`Retry-After`のexpose、既存の`RATE_LIMITED` / `Too many search requests`、body/headerのrequest ID一致。`rate_limit_status=denied`、**`d1_queries=0`・`rows_read=0`・`rows_written=0`**でD1実行前の拒否を確認する。

安価な`POST /v1/search`（cpu / 14900k）を**最大24件、300ms間隔**で送る。成功には少なくとも1件の**`expensive_miss`による429**と、全観測応答の契約正常が必要。colo-local / eventually consistentなproduction bindingと別trafficのwindow状態のため「20件成功・21件目拒否」はassertしない。Facetのproduction burstは行わない。

他のSearch/Bootstrap/Facet trafficが共通D1 budgetを消費していると、expensive limiter通過後に`d1_miss`で拒否され得る。これは正常な保護動作として契約全体を検証し、**最初の`d1_miss` 429で送信を終了**する。後段拒否で前段tokenをrefundできないため、Search専用拒否を出す目的で送信を続けない。window待ち・自動再試行・request追加は行わない。

|観測結果|`contract` / exit code|解釈|
|---|---|---|
|`expensive_miss` 429を1件以上観測、全応答の契約正常|`pass` / 0|Search専用拒否を確認済み。その後の正常な`d1_miss`でも早期終了して成功|
|`d1_miss` 429のみ観測|`inconclusive` / 1|共通D1保護は確認済み、Search専用拒否は未確認。不具合とは断定しない|
|24件で429なし|`inconclusive` / 1|拒否経路未確認。eventual consistency・他traffic/window状態・deployment/configurationを確認|
|HTTP/telemetry契約違反・想定外class・測定失敗|`failed` / 非ゼロ|不正な応答を正常な早期終了・未完了として扱わない|

stdoutには総request数、200/429件数、HTTP latency・CPU分布、allowed/limited samples、allowed readsのmin/p50/p95/max、観測class別件数を出力する。さらに`limited_by_class`で429だけのclass別件数、`coverage`で`allowed` / `expensive_miss_denied` / `d1_miss_denied`の`observed` / `not_observed`、`stop_reason`で`request_limit` / `global_d1_limit`を記録する。最初から429ならallowedは未確認であり、成功を捏造しない。
cost分布に固定の合否thresholdは置かない。未完了でもsummaryを出し、結果と全sampleを従来どおり`.cache/rate-production-429.json`へ保存、tailはfinallyで停止する。契約/測定失敗時も取得済みsampleと`failed`を保存する。

`scripts/lib/rate-smoke.js`の同じ判定・送信ループを`test/rate-smoke.test.js`からoffline実行し、共通D1拒否時の追加送信0、専用拒否未観測時の非ゼロ結果、専用→共通の混在、24件上限とpace、不正な429の早期終了前検証を確認する。

exactなSearch 20件→21件目拒否、Bootstrap 40件→41件目拒否、Facet 30件→31件目拒否、共通D1 60件→61件目拒否とbudget分離は`test/search-protection.test.js`のdeterministic fake limiterで確認する。production smokeは実Cloudflare環境で契約が機能することを確認する役割に限定する。

2026-09-23のcontract smoke更新後の実行は**24件中200=21、429=3**で成功。全24件のclassは`expensive_miss`、429全件でD1 queries / rows_read / rows_written=0を確認した。HTTP p50/p95/maxは108.80/140.83/160.27ms、CPUは1/2/5ms。allowed readsのmin/p50/maxは29/29/29、合計609 reads。これらは今回の観測値であり次回の固定期待値にはしない。`npm run check`（schema＋233 tests、skip 0）、`npm run verify:protection`（17 tests）、scriptの`node --check`、`git diff --check`も成功。

同日の`d1_miss`早期終了・coverage対応後の再検証も24件中200=21、`expensive_miss` 429=3、`d1_miss` 429=0で`pass` / exit 0。coverageはallowed・expensive拒否がobserved、D1拒否はnot_observed。HTTP p50/p95/maxは112.83/150.00/169.92ms、CPUは2/15/15ms。本番でD1上限を意図的に消費する追加probeは行わず、global-only未完了と早期終了はoffline 7 testsで確認した。全240 tests（skip 0）、protection 17 tests、smoke/判定moduleの構文チェックが成功。

### 小規模production POST 429 probe（2026-09-13の実測）

`14900k`のPOSTを最大24件、各応答後300ms待って送信。全件通過しても1,176行程度のread。
**21 D1 / 3×429 / 1,029 reads**、HTTP p50/p95/max=107.64/120.35/123.82ms、CPU=1/2/2ms。
全拒否に`RATE_LIMITED`、Retry-After=60、CORS、no-store、D1=0をassertした。
20/60設定を1件超過した観測を隠さず残す。worldwideの正確なquotaはこの方式では実現しない。
deep paginationもproduction小標本で200、offlineで上限超過429とD1=0を確認した。

## Health / observability

`/v1/health`はD1 connectivity probeとしてSELECT 1を維持。結果は`{"ok":true,"database":"available"}`。
rows_readが0でもHTTP/Worker/D1 queryの資源は消費するためhealth専用60/60 limiterを追加。
複数monitorが多い場合はその合計で調整する。現状は大幅なAPI変更を避け、DBなしliveness endpoint分離は将来候補とした。

既存structured logへ追加したbounded fields:

|field|値|
|---|---|
|`rate_limit_status`|`not_checked` / `allowed` / `denied` / `unavailable`|
|`rate_limit_class`|`none` / `query_inflight` / `query_refill` / `expensive_miss` / `bootstrap_miss` / `facet_miss` / `d1_miss` / `health`|
|`search_cost_class`|`not_classified` / `normal` / `expensive` / `uncached` / `bootstrap`|

`cache_status`, `d1_queries`, `rows_read`, `rows_written`, `sql_duration_ms`, `elapsed_ms`は継続。
HITは`not_checked`・`not_classified`・D1=0。拒否時の`rate_limit_class`は止めたlayer、allowed時は通過した最終resource tierの概要。
Facet許可・専用拒否は`facet_miss`、共通D1拒否は`d1_miss`。Facetの`search_cost_class`は引き続き`uncached`。binding障害の`unavailable`も失敗したlayerを記録します。
Bootstrap許可・専用拒否は`bootstrap_miss`、共通D1拒否は`d1_miss`。`search_cost_class=bootstrap`はrefill拒否でも維持し、HITは従来どおり未分類です。`evaluate-search-cost.js`の集計にもbootstrapを含めます。
429では既存error契約に従い`cache_status=BYPASS`。cache対象だったかの診断にはcost classと拒否layerも使う。
Worker CPUはJSからelapsedと混同して生成せず、**tail runtimeのcpuTime**をrequest IDで照合する。
IP、keyword、URL全文、SQL、filters、token、hash keyをstructured logへ追加しない。
測定scriptの固定fixture request情報はGit外artifactに保存し、productionの任意ユーザー入力を収集する機構とは分ける。

運用ではcolo別の429率・denied class・HIT率・allowed D1 reads・CPU p95/maxを確認する。
現在のsampling=1 / invocation_logs=falseを継続。logging費用と保持期間も観測後に調整する。

## Regression / deploy gate / reproducibility

- `npm run check`: 81 tests、schema generator一致（既存69＋rate保護12）。
- `npm run verify:worker:local`: 実local binding、120 Golden HTTP/direct一致。所有process treeを終了。
- 最終production: **120/120 top20一致**、保存済み0006後top10/expected rank一致、GET119件の再取得HITと本文一致、POST1件の反復BYPASSと本文一致。
- production smoke: **30/30、tail30/30**。health/categories/MISS→HIT、POST、pagination、CORS、validation/errorを確認。
- 両deployでpredeploy成功: migration0001〜0006、latest sync complete、active=29,599、FK=0、lease=0、cache epoch valid、production4 binding一致。
- predeployはbinding名/namespace/threshold欠落・相違、cache epoch/TTL不正をremote readより先に拒否。threshold変更時はコードの契約とWrangler両方をreviewする。

`verify-api.js --paced`は**検証client側**でnormalを1.1秒以上、restrictedを3.3秒以上あける。
直前のGETのcache確認repeatだけは待機不要。POST repeatはpacedのまま。
429を自動retryして成功扱いにする処理はなく、429が来れば検証失敗。
管理のdirect D1は既存の認証済みCLI経路。public Workerにbypass header、admin token、query特例、limiter停止flagを追加していない。
120件を一度に本番burstにするのではなく、writer停止中にpaced比較する。localも同thresholdで同じ方式。

```sh
npm run check
npm run verify:worker:local
node scripts/check-rate-namespaces.js
node scripts/evaluate-search-cost.js
node scripts/measure-protection-offline.js
npx wrangler deploy --env="" --dry-run --outdir .cache/worker-build
npm run worker:deploy

# 他の検証と同時実行しない。cold keyにはTTL経過を使う。
node scripts/measure-api-protection.js --phase after --compare .cache/rate-before.json --output .cache/rate-after-inflight.json --cold-wait-seconds 305
npm run verify:api -- --url https://pc-parts-catalog.kikuuuty.workers.dev --remote --golden --golden-only --cache-repeat --paced --output .cache/api-rate-golden.json
# restricted resource budgetを使い切る可能性がある小規模運用probe。完了後は60秒以上あける。
node scripts/verify-rate-smoke.js
node scripts/verify-cache-smoke.js
node scripts/measure-api-cache.js --compare .cache/cache-before-complete.json --output .cache/rate-cache-after.json --cold-wait-seconds 305
node scripts/report-api-protection.js
```

`.cache/`親directoryを用意する。cold測定はentry HITなら失敗し、任意cache-busterやpurgeを使わない。
scriptはtailをfinallyで停止し、raw tail headers/authを保存しない。tail欠落を0 readsと扱わない。
開始時のremote RESTは一度403となった。`wrangler whoami`で認証を確認後のreadは成功し、失敗runをbaselineに含めていない。

|Git外artifact|内容|
|---|---|
|`.cache/rate-before.json`|変更前11 cost sample、6 stampede、10 HIT|
|`.cache/rate-after.json`|bindingのみの初回deploy。同時MISS削減なしも保存|
|`.cache/rate-after-inflight.json`|最終guard併用の同条件比較|
|`.cache/rate-classifier.json`|131 predicted / actual、false negatives|
|`.cache/rate-offline.json`|100 unique×5 scenarios、normal replay|
|`.cache/rate-production-429.json`|安価な24 POSTと3×429のtail照合|
|`.cache/api-rate-golden.json`|120 HTTP/direct、expected metrics、cache-repeat|
|`.cache/rate-cache-after.json`|最終production repeated22＋mixed100、cache本文回帰|
|`.cache/cache-production-smoke.json`|最終30 smoke＋tail|
|`.cache/rate-summary.json`|上記集計|

初回binding-only version: `9c7feb9b-6b06-42e0-93b8-8157bb49d897`。
最終versionではisolate内guardを追加したが、namespace/threshold/cache epoch/TTLは同じ。

## Free plan outlook / Remaining issues

Free制約はWorkers 100,000 requests/day・10ms CPU/invocation、D1 5M reads/day・100k writes/day。
HIT/429でもWorker request枠を使う。今回のWorkerはwriteしないがsync/監査は別予算。
**Rate Limitingはcolo-local、eventually consistent、正確な課金counterではない**。
**5M D1 rows/dayを絶対に超えない保証には使えない**。FreeではD1自身のhard daily limitが最後の安全装置になり、
到達時はqueryが失敗してavailabilityが落ちる。Paidではbilling alert・usage観測を併用する。

cache性能を維持したままburstの保護層を足せたことはFree検討にプラスだが、
Free binding availability未確認、CPU11〜12ms、分散stampede、実trafficの未知のread量により、**Paid維持推奨は変わらない**。

1. **production stampede抑制の未達**: Cache APIの完全解消には分散coordination/Workers Cache request collapsingを比較する。isolate内上限やeventual bindingだけでは不足。
2. **D1 broad-query read最適化**: `ddr5` MISS35,963行、listing/genericも高read。検索品質不変を条件とした別タスク。
3. **real traffic観測 / rate limit tuning**: 正当なPOST・deep pages・同coloの複数ユーザーへの影響、classifier false negatives/保守判定、cache evictionを観測。
4. **Workers Cache移行可能性**: HEAD契約・canonical validation・gateway/inner entrypointを含めた設計が必要。
5. **pagination / health**: 最大window縮小やcursor、DBなしlivenessの分離はAPI契約として別途検討。
6. **定期sync＋epoch deploy自動化**: complete/readiness/品質gateと連携。現在は手動。
7. **Phase 3 fuzzy search**: read cost・保護tierも含め別途設計。

Contains information from [BuildCores OpenDB](https://github.com/buildcores/buildcores-open-db),
made available under [ODC-By 1.0](https://opendatacommons.org/licenses/by/1-0/).
