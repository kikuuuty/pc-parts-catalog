# Production setup baseline — 2026-09-13

> この文書はFreeでpartial同期した時点の履歴です。その後Workers Paidへ変更し、全件同期・deploy・production HTTP検証を実施しました。
> 現在の状態、性能、既存FTS投影差の診断は [production-paid-baseline.md](production-paid-baseline.md) を参照してください。

## 到達点

**D1作成・migration・予算内partial同期・remote診断、Worker実装とローカルHTTP検証まで実施。**
ユーザーがWorkers Freeで安全に途中まで同期する方針を選択したため、当日の書込は約7.35万行で停止した。
全件同期後にdeployする条件を維持しており、**Workerは未deploy、本番URLと本番HTTP性能は未取得**。
全完了ではなく、残り26,690製品の同snapshot resumeが必要な状態である。

|Resource|確認値|
|---|---|
|Wrangler authentication|OAuth認証済み（ユーザーがブラウザ認証を完了）|
|Account ID|`ac7e9239a1eb4f0c95b2558dc6298eb5`|
|D1 name|`pc-parts-catalog`|
|D1 UUID|`180175e0-edc0-49df-a9d7-5958d5982e8f`|
|一意性|作成前list=[]、作成後listで同名1件|
|location hint / running region|APAC / APAC|
|query serving colo|SIN（観測したremote metadata）|
|read replication|disabled|
|migration|0001〜0005適用済み、再listで未適用なし|
|schema比較|Cloudflare/SQLite管理オブジェクトを除く61定義のname/type/SQLがlocalと完全一致|
|DB size|15,085,568 bytes（partial。local全量は138,653,696 bytes）|
|Worker name/config|`pc-parts-catalog`、`src/worker.js`、`DB → pc-parts-catalog`|
|deploy URL|未発行|

認証前のlistは認証エラーだった。認証後に空の一覧を確認して初めてDBを作成した。
作成直後のinfoは古いconfig UUIDを優先して7404になり、実UUIDへの更新後に成功した。
DB削除/再作成やmigration改変による回避は行っていない。

## Remote catalog

local/remoteともsnapshot commitは
`eec0df175504ebd15f0f3e3a8249a18a22f00940`、normalizer version=1。
上流commit更新による件数差ではなく、初回同期途中の差である。

|category|Local complete|Remote partial|
|---|---:|---:|
|cpu|789|789|
|memory|4,838|2,120|
|motherboard|3,701|0|
|gpu|3,837|0|
|storage|3,495|0|
|psu|3,297|0|
|case|3,778|0|
|case_fan|3,460|0|
|cpu_cooler|2,404|0|
|**active合計**|**29,599**|**2,909**|

- active差: **−26,690**。全体の約9.83%を同期済み。
- identifiers: **11,234行**（upstream MPN 7,117 / EAN 2,416 / UPC 1,701）。local originは0行。
- FK errors: **0**。取込済み製品のtyped spec欠落: **0**。
- latest sync: `e3fabcf8-1f48-4465-9a2a-a2df01e97c75`、**partial**。
- 同runでは先行1,000製品をunchangedとして再書込せず、1,909件を追加してresumeを確認。
- 製品内容・identifier・local enrichment・duplicateレコードの品質修正は実施していない。

### Completeness / duplicate audit

partial DBに対して各1回実行した。全量production baselineとしては同期完了後に再実施する。

- identifierなし: 3製品。
- identifier conflict: 242グループ / 319製品。
- possible duplicate name: 123グループ / 255製品。
- invalid identifier rows / identifier key mismatch: **0 / 0**。
- CPU release_year不明: 92 / 789。Memory: 1,887 / 2,120。
- 未取込カテゴリは母数0なのでcoverage=N/A。欠損率100%と解釈しない。

## Remote syncのwrite実測とFree日数

|run|指定上限|追加製品|rows_written|writes / 製品|
|---|---|---:|---:|---:|
|1|既定1,000製品 / 80,000 writes|1,000|28,973|28.973|
|2|2,000製品 / 45,000 writes|1,909|44,418|23.268|
|**加重平均**||**2,909**|**73,391**|**25.229**|

両runともupdated/reactivated/deleted=0。
`d1 info` の24h実測は **73,537 rows_written**。sync reportの合計との差146行は
migration・run終了記録・lease解放等を含む。sync reportはそれらの一部を集計しない既存仕様。

### 暫定見積り

```text
平均単価 = 73,391 / 2,909 = 25.22894465 writes/product
総writes = 29,599 × 平均単価 ≈ 746,752
残writes = 26,690 × 平均単価 ≈ 673,361
```

|外挿に使う単価|全29,599件のwrites|10万writes/日の理論日数|8万writes/日の運用目安|
|---|---:|---:|---:|
|run 2: 23.268|約688,700|7 UTC日|9 UTC日|
|加重平均: 25.229|**約746,752**|**8 UTC日**|**10 UTC日**|
|run 1: 28.973|約857,572|9 UTC日|11 UTC日|

CPUとMemoryの一部しか測定していない。カテゴリ別identifier/facet/FTSサイズ、後続のindex page split等で
単価は変わるため、上表は信頼区間/保証ではない。小さい管理writeと他クライアントの利用分も別途必要。
日数は日次割当を使えるだけのmax-products指定を前提とする。
**既定1,000製品を1日1回だけ実行するなら、write枠に余りがあっても最低30 run / 約30日**となる。
8万writes/日を目安に進める例は運用手順の `--max-products 4000 --write-budget 80000`。
run予算は日次予算ではないので、当日の残量を確認してから実行する。

### `perProductEstimate=500` の評価

500は現在平均25.229の **約19.8倍**、run別で約17.3〜21.5倍と保守的。
ただし実際の予算消費を500×製品数として計上するわけではない。

- 最大25製品chunkの開始可否/予算に応じたchunk縮小の推定値。
- runのbudget消費はD1実測 `meta.rows_written` を集計する。
- 観測単価×1.5が初期推定値を超えたら推定値を上げる。下方へは調整しない。
- 2回目は45,000予算の44,418（98.71%）を使用し、残582で次chunkを開始せず停止した。
  500推定が初回同期を「8万/500=160製品/日」に制限しているわけではない。

全カテゴリ・大きな製品・更新runでのバッチ最大値を取る前に下げる判断はしていない。
**今回は `src/sync.js` と予算安全機構を変更していない。**

## 検索品質・不変性

|指標（120件）|Local Phase 2|今回Local再測定|Remote **partial診断**|
|---|---:|---:|---:|
|Hit@1|98.33%|98.33%|27.50%|
|Hit@5|100%|100%|27.50%|
|Hit@10|100%|100%|27.50%|
|MRR|0.989583|0.989583|0.275000|
|Zero results|0|0|87|
|MISSING_PRODUCT|0|0|87|
|NO_SEARCH_MATCH / RANKING_FAILURE / invalid fixture|0 / 0 / 0|0 / 0 / 0|0 / 0 / 0|
|rows_read（検索部分）|262,763|262,763|27,720|
|SQL duration合計|480 ms|727 ms|359.282 ms|
|query elapsed合計|9,159.579 ms|6,242.210 ms|20,077.493 ms|

remoteの低いscoreと小さいread量は未取込カテゴリがあるためで、全量localとの性能/品質比較は成立しない。
33 queryは期待製品が1位、87 queryは未取込によるMISSING_PRODUCT。
CPUの全18ケースはtop 10順がlocalと一致。Memoryは部分取込で候補/FTS corpusが異なりtop 10差がある。
全量同期後に同commit・同fixtureで再検証する。

Local Phase 2 → 今回Localはcatalog/fixture/search implementation hashが一致し、
**120件すべてのtop 10順が不変**。

- catalog SHA-256: `614b8b834cdcf9839fa6fd77d4ecc8c511c023b1b3852a65a91b98038eada57f`
- fixture SHA-256: `68d4f73da2ba143c06b5307cd84b97cb232db6489fbcee77b94e9974d925bfb7`
- search implementation SHA-256: `131165dfc139177c1c8d5b117d77384cf4873c98a14754ebeec2f593618d7cdd`

## Performance

### 主要11 query × 3回

APIに合わせたLIMIT 21（20件＋lookahead）/OFFSET 0。nearest-rankで集計。
remote DBはpartial 2,909件、ローカルはcomplete 29,599件。

|測定|p50|p95|max|
|---|---:|---:|---:|
|remote D1 REST elapsed（partial、0件query含む）|160.96 ms|180.24 ms|181.52 ms|
|同D1 SQL duration|2.67 ms|10.96 ms|11.18 ms|
|local D1 direct elapsed（最終HTTP検証時）|77.22 ms|105.85 ms|106.12 ms|
|local Worker HTTP elapsed|**17.41 ms**|**33.91 ms**|**43.63 ms**|
|local Worker 初回11件|17.99 ms|43.63 ms|43.63 ms|
|local Worker 反復22件|16.55 ms|29.70 ms|33.91 ms|
|production Worker HTTP|未deploy|未測定|未測定|

ローカルdirectはgetPlatformProxyとのRPCを含み、HTTP Workerと通信経路が異なる。
Node fetchでcacheは使っておらず、初回/反復はisolate cold/warmの断定ではない。
先行local測定のHTTP p50/p95/max=14.48/25.05/27.93msとも変動があり、速度向上を主張しない。
上表はroot production / env.localのbinding分離後に再確認した最終測定。

|query|remote returned（最大20）|remote REST p50 / max ms|remote rows_read/回|local HTTP p50 / max ms|local direct rows_read/回|
|---|---:|---:|---:|---:|---:|
|9800x3d|1|156.62 / 160.50|19|17.41 / 17.99|19|
|14900k|3|164.30 / 168.22|49|16.55 / 17.59|49|
|rtx5080|0|156.66 / 162.86|1|16.99 / 17.63|931|
|rtx 5080|0|163.16 / 167.87|1|16.61 / 17.68|931|
|ryzen 7|20|169.82 / 173.88|452|15.91 / 16.49|452|
|990pro|0|156.11 / 160.96|1|16.22 / 16.57|79|
|990 pro 2tb|0|158.52 / 164.30|1|17.53 / 20.46|99|
|ddr5 6000 cl30 32gb|20|163.29 / 166.14|1,067|18.51 / 22.56|2,590|
|850w gold|0|154.44 / 160.10|1|21.52 / 25.86|5,202|
|360mm aio|0|166.73 / 168.83|1|18.77 / 25.37|3,696|
|ddr5|20|180.24 / 181.52|15,404|33.91 / 43.63|35,963|

remote returned=0の時間は未取込カテゴリのempty lookupで、実カタログ検索性能としては評価できない。
3回のp95はnearest-rankではmaxと同じ。
33 direct検索のread合計: remote **50,991** / local **150,033**、rows_writtenはいずれも0。

### D1 Insights

`npx wrangler d1 insights pc-parts-catalog --time-period=1d --json` は成功。
今回の既定top 5はingest、lease更新、statsの集計/foreign_key_checkが中心だった。

- 取込SQL: 表示98回、avg duration 8.88ms、集計writes 45,010。
- FK check: 表示1回、38,676 rows_read、24.07ms。
- identifier集計: 表示1回、22,469 rows_read、16.09ms。
- category件数集計: 表示1回、5,818 rows_read、10.62ms。

同期の実総writeとInsights集計は一致しておらず、反映遅延/集計windowの差がある。
検索SQLの傾向を既定top 5から十分に判断できないため、上のdirect D1 metadataを採用した。
後続の `d1 info` 観測では24h rows_read=435,287、rows_written=73,537。
いずれも他の診断実行や集計更新で増える値で、厳密なUTC日残量ではない。

## Worker API検証

実装endpoint: GET health / categories / search、POST search、各routeのOPTIONS。
実際の `wrangler dev --local` にHTTP requestを送り、GET/POSTの上位20件が
同じローカルD1へのdirect `searchQuery()` と **120/120 queryで一致**した。

以下は**local HTTP**で確認した先頭製品。本番URLの結果ではない。

|入力|local API top 1|
|---|---|
|9800x3d|AMD Ryzen 7 9800X3D|
|14900k|Intel Core i9-14900K（続いてKS、KF）|
|rtx5080|ASUS PRIME GeForce RTX 5080 16GB GDDR7|
|ryzen 7|AMD Ryzen 7 9850X3D|
|990pro|Samsung 990 Pro 2TB SSD M.2-2280 PCIe 4.0 x4 NVMe|
|990 pro 2tb|同2TB、続いて2TB heatsinkあり|
|ddr5 6000 cl30 32gb|TEAMGROUP Xtreem Black DDR5-6000 CL30 32GB (2x16GB)|
|850w gold|Thermalright AG-850 White 850W Fully Modular 80+ Gold Certified|
|360mm aio|Noctua NL-LC1-36 AIO 360mm|

API契約・request例は[運用ドキュメント](cloudflare-production.md#api-v1)。
Workerはenv.DBのみを使い、検索SQLの再実装はない。
read-only SELECT/WITHをintegration adapterでも検査した。

## 実行した検証と問題

- `npm test` 成功。最終 `npm run check` はschema一致＋**55テスト成功**。
- `npm run verify:plans -- --summary-only`: **28/28成功、catalog/spec full scanなし**。
- local 120 benchmark / Phase 2指紋・順位比較成功。
- Worker deploy dry-run成功（約36.29KiB、gzip約11.16KiB、DB binding確認）。
- remote migration再listでskipを確認、61 schema定義比較成功。
- remote同期のresume、write budget停止、stats/FK、各監査、120診断benchmark成功。
- production predeployは意図通り `Remote catalog sync must be complete before deploy` で停止。
- 一度、local statsと別workerdのplansを並列実行するとMiniflare内部エラーになった。
  statsを単独再実行すると成功し、FKエラー0/29,599件を確認。DB再作成等は行っていない。
- 当初のStart-Process方式ではユーザー環境で待機問題があり、プロセス/8787/logを調べた。
  logはReadyだったが確認時点で待受なし。時間制限付き `verify:worker:local` に変更し、
  起動→検証→所有プロセスtree終了まで正常に戻ることを確認した。
- ローカル永続化キーをpreview_database_idに置くと本番dry-runのbinding表示にも影響したため、
  最終設定では明示的な `env.local` へ分離した。root productionは実UUIDだけを使用し、
  ローカルnpm scriptsは `--env local`、deployは `--env=""` を選ぶ。

### 残る条件

1. Freeの翌UTC日以降に残り26,690件を同commitでresume。
2. complete stats/FK、全量remote監査・120benchmark・query plans・direct性能を再取得。
3. 同じ完全snapshotで順位差を検査。partial時のMemory順位差は回帰とは判定しない。
4. Worker deploy、実URLのhealth/GET/POST/120比較・performance・Worker metadataログ検証。
5. 公開後のCPU時間/Free request枠、rate limiting、broad queryのread費用を評価。

`ddr5` は全量localで35,963 reads/検索。Freeの500万readsを仮にこのqueryだけに使うと約139回/日で到達する。
API最大50件/offset上限だけではFTS候補評価のread量は抑えきれない。
HTTP cache headerは実装したが、Cache API/edge cache hitによるDB read削減はまだ確認していない。
paginationは先頭1,000件・同期中snapshot保証なし。公開rate limiterは未設定。

## 次の優先順位

まず初回remote同期完了とproduction HTTP検証を完遂する。
その後の候補では **API cache最適化** を優先し、反復broad queryをD1まで到達させない効果を測る。
次にD1 read cost最適化（順位不変の検証必須）、見積もりサイトとの接続、
GitHub Actionsによる運用自動化を検討する。Phase 3 fuzzy searchはproduction baseline取得後。
full remote/Workerの実測がない現時点では最終的な性能上の優先順位は確定できない。

## 保存artifact（Git管理外）

- `.cache/schema-remote-production.json`（schema、migration、2回のsync履歴）
- `.cache/stats-remote-production.json`
- `.cache/completeness-remote-partial.json` / `.cache/duplicates-remote-partial.json`
- `.cache/search-local-production.json` / `.cache/search-remote-partial.json`
- `.cache/search-local-production-comparison.json` / `.cache/search-remote-partial-comparison.json`
- `.cache/d1-remote-partial-performance.json` / `.cache/api-local-production.json`
- `.cache/query-plans.json` / `.cache/worker-build/`
- `.cache/worker-dev.stdout.log` / `.cache/worker-dev.stderr.log`

Contains information from [BuildCores OpenDB](https://github.com/buildcores/buildcores-open-db),
made available under [ODC-By 1.0](https://opendatacommons.org/licenses/by/1-0/).
