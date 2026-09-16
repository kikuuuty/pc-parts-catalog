# Workers Paid / production API baseline — 2026-09-13

> 以下は0006適用前のproduction baselineの履歴です。当時の5件の順位差は、その後
> [0006 FTS projection consistency](fts-projection-consistency.md)で解消しました。
> 現在はlocal upgraded / fresh / remoteの全FTS内容と120 queryのtop 20順が一致しています。

## 結果

**同snapshotの全29,599製品をremote D1へ同期し、Workerをdeploy。本番HTTP経由の検索・性能検証を完了した。**

- URL: **https://pc-parts-catalog.kikuuuty.workers.dev**
- Version ID: `c2002437-b299-4c61-8e70-6df8b8fcdcfc`
- APIとremote directは **120/120 queryでtop 20順が一致**、保存済みremote benchmarkのtop 10とも一致。
- Local Phase 2との期待製品順位・Hit/MRR/Precisionは全120件で一致。
- **Localとの厳密top 10順は115/120一致。5件の差は既存FTS投影の生成経路差による。**
  比較コマンドの非0終了を隠さず、後述の診断を残した。
- 今回、migration、検索ranking、Golden expected、normalizer、sync実装、カタログの値は変更していない。
  CLIの既存同期で未取込製品だけを追加した。修正コードはHTTP検証スクリプトの非JSON応答診断のみ。

Free/partial時点の記録は [production-baseline.md](production-baseline.md)。運用手順は [cloudflare-production.md](cloudflare-production.md)。

## Resources / catalog

|項目|確認値|
|---|---|
|Authentication|Wrangler OAuth認証済み|
|Plan|ユーザーがWorkers Paidへ変更。Freeの日次write枠を超える同期が成功|
|Account ID|`ac7e9239a1eb4f0c95b2558dc6298eb5`|
|D1名 / binding|`pc-parts-catalog` / `DB`|
|Database UUID|`180175e0-edc0-49df-a9d7-5958d5982e8f`|
|一意性|今回もlistで同名1件を確認。追加resource作成なし|
|Region / D1 serving colo|APAC / SIN|
|Read replication|disabled|
|DB size|**140,775,424 bytes**（約134.25MiB）|
|Migration|0001〜0005適用済み。listで未適用なし、今回は適用/改変不要|
|Worker|`pc-parts-catalog`、root環境の実DB binding|
|Deploy|upload 36.29KiB / gzip 11.16KiB、startup 24ms|

BuildCores commit: `eec0df175504ebd15f0f3e3a8249a18a22f00940`、normalizer version=1。
Localとremoteは同commit・同件数で、取込製品の変更予定は0。

|Category|Active products（local/remote一致）|
|---|---:|
|cpu|789|
|memory|4,838|
|motherboard|3,701|
|gpu|3,837|
|storage|3,495|
|psu|3,297|
|case|3,778|
|case_fan|3,460|
|cpu_cooler|2,404|
|**合計**|**29,599**|

- identifiers **113,588行**: MPN 82,312 / EAN 18,355 / UPC 12,921。local originは0。
- `PRAGMA foreign_key_check`: エラー0。
- `PRAGMA quick_check`: **ok**（304,506 reads / 891.425ms、read-only）。
- live sync lease=0、ingest staging row=0。
- local DB size=138,653,696 bytesに対しremoteは+2,121,728 bytes。
  FTS投影差や物理配置/取込履歴があるため、ファイルサイズ一致は要求しない。

## 安全なresumeとwrite実測

```sh
npm run sync -- --remote --dry-run --output .cache/sync-remote-paid-dry-run.json
npm run sync -- --remote --max-products 30000 --write-budget 2000000 --output .cache/sync-remote-paid-complete.json
npm run sync -- --remote --dry-run --output .cache/sync-remote-paid-confirm.json
```

- 最新run ID: `34aa2c91-d6eb-448b-8ece-05f027a156c2`
- 03:23:31.508Z → 03:31:03.283Z、**451.775秒（7分31.775秒）**。
- added=26,690、unchanged=2,909、updated/reactivated/deleted=0、remaining=0、status=**complete**。
- writes=**740,446**、reads=1,560,809。2,000,000行のrun予算内。
- 完了後のdry-run: unchanged=29,599、planned_changes/deletions=0、writes=0。
- lease、最大25製品chunk、JSON bound値上限、実測write budget、削除率guard、応答喪失時resumeを維持。
- DB削除、Time Travel restore、全件削除、ID再採番は行っていない。

|初回同期全体|Writes|
|---|---:|
|Free時点の2run|73,391|
|Paidでのresume|740,446|
|**sync report合計**|**813,837**|
|1製品あたり|**27.495 writes**|
|後続d1 infoの24h観測|813,985（管理write等を含む、反映遅延あり）|

初期sampleからの746,752 writes見積りより約9%多かった。
`perProductEstimate=500`は全量平均の約18.18倍。今回も変更していない。
初期sampleはCPU/Memory中心で、CPU Cooler等のfacet量を代表していなかった。

## Completeness / duplicate baseline

全量remoteに対して各1回実行し、JSONを保存した。
local保存済みのcompleteness summary/全カテゴリfields集計、duplicate summaryと一致をassertした。

- typed spec row欠落: **全9カテゴリで0**。
- identifier保有製品: 27,620 / 29,599（93.31%）、identifierなし1,979。
- release_year不明: 24,927製品。
- identifier conflict: 3,154グループ / 4,371製品。
- possible duplicate name: 546グループ / 1,137製品。
- invalid identifier rows / identifier key mismatch: **0 / 0**。
- JAN/GTIN種別は0。データの欠損・重複候補を修正/統合していない。

## 120 query benchmark

|指標|Local Phase 2|Remote complete|
|---|---:|---:|
|Hit@1|98.3333%|98.3333%|
|Hit@5|100%|100%|
|Hit@10|100%|100%|
|MRR|0.9895833333|0.9895833333|
|Zero results|0|0|
|MISSING_PRODUCT / NO_SEARCH_MATCH / RANKING_FAILURE / invalid expected|すべて0|すべて0|
|Precision@5（44件）|98.1818%|98.1818%|
|Precision@10（44件）|98.6364%|98.6364%|
|検索rows_read合計|262,763|262,942|
|SQL duration合計|480ms|951.172ms|
|query elapsed合計|9,159.579ms|22,863.125ms|
|elapsed p50 / p95 / max|77.46 / 88.67 / 91.75ms|186.71 / 214.19 / 370.47ms|

read差は+179行（約0.068%）。query plansはlocal/remoteとも28/28成功、catalog/spec full scanなし。
これらはFTS候補の走査/ソート費用が0という意味ではない。

### Local Phase 2との厳密順位差

当時の比較では以下5件のtop 10差を検出した。比較用scriptは廃止済みで、現在のrelease判定は[UX評価](search-evaluation.md)に従う。
比較ルールやexpectedを変更して成功扱いにする処理は加えていない。

|Query|差の例|
|---|---|
|intel arc b580|同名GUNNIR製品の3位/4位が入れ替わる|
|b650e wifi|4位/5位、6〜8位の並びが変わる|
|z890|MAXSUN Z890 TerminatorとGigabyte Z890 EAGLEの1位/2位が入れ替わる|
|b650 matx|3位/4位が入れ替わる|
|z790 wifi|4位/5位、7位以降の並びが変わる|

調査結果:

1. 現在localで再検索しても、旧Phase 2側の並びを再現。古いJSONだけの問題ではない。
2. 製品IDも両DBで同じ。ID tie-breaker差ではない。
3. products・typed specs・identifiersを全件比較し、`created_at` / `updated_at`だけを除いたhashが一致:
   `f45824dcf30f50f96b2910ab351fc2ffb65fdf4beef327f39b95b8419362561a`。
4. FTSの全29,599文書・全列を比較すると、**Motherboard 3,697件のfamilyだけ**が異なる。
   localは空文字、remoteは既存typed chipset（例: Intel B760）。他のFTS列は一致。
5. 既存 `0004_search_relevance.sql` のバックフィル（9〜13行）はCPU/GPUだけからfamily列を作る。
   同migrationの後続取込trigger（25〜28行）はカテゴリを限定せず `spec.chipset` も投影する。
   localは既存DBへのmigration、remoteは空DBへのmigration後に取込したため、この既存の非対称性が現れた。
6. debug scoreの差はBM25 relevanceに現れる。Motherboardの語頻度と全FTS文書長統計が変わり、
   近いscore同士ではGPUにも影響する。例: Z890先頭2件のrelevanceは
   MAXSUN 12.381273→12.445871、Gigabyte 12.343340→12.450008。

ユーザーの変更禁止条件に従い、migration、trigger、ranking、FTS文書を補正していない。
**Local全順位との完全一致は未達で、既存投影不整合は残件**。
品質指標・期待集合の最初の一致順位は全件同じで、production APIは同じremote D1の並びをそのまま返す。
将来の解決は別タスクでforward migrationと投影統一を設計し、既存migrationを改変しない。

## Deploy / production HTTP検証

`npm run worker:deploy` のpredeployは実UUID・migration・sync=complete・active=29,599・FK=0・lease=0を確認して成功。
root環境へ既存Workerコードをdeployした。

```text
https://pc-parts-catalog.kikuuuty.workers.dev
c2002437-b299-4c61-8e70-6df8b8fcdcfc
```

```sh
npm run verify:api -- --url https://pc-parts-catalog.kikuuuty.workers.dev --remote --golden --output .cache/api-production.json
```

health/categories、主要11検索×3回、高度POST、120 Golden Queryに成功。
全120件でHTTP top 20＝direct top 20、HTTP top 10＝保存済みremote benchmark top 10をassertした。
通常responseにdebug scoreがないことも確認。

追加15 production smoke checks:

- health/categories、broad検索3件、Memoryのoffset=20、高度POSTが200。
- Memoryの先頭2ページ40件に重複なし、next_offset契約を確認。
- invalid category/limit/JSONは400、Content-Type不正415、body過大413、不明route404、method不正405。
- OPTIONSは204、CORSは `*`。エラーはno-store、SQL/stackを返さない。
- `wrangler tail` の構造化ログと **15/15 request IDを照合**。すべての観測D1操作でrows_written=0。
- tailは時間制限付きで起動し、検証後に自分が起動したプロセスtreeを終了した。

公開直後の最初のverify実行は非JSON応答で失敗した。元のスクリプトはstatusより先にJSON.parseしており、
その応答のstatus/bodyは保存できなかった。原因を断定せず、診断順序を修正した。
後続healthは200、再実行の全120比較・追加15チェックは成功。APIコードやdeploy内容の修正は不要だった。

### 本番検索例（top 1）

|Query|Production API result|
|---|---|
|9800x3d|AMD Ryzen 7 9800X3D|
|14900k|Intel Core i9-14900K|
|rtx5080 / rtx 5080|ASUS PRIME GeForce RTX 5080 16GB GDDR7|
|ryzen 7|AMD Ryzen 7 9850X3D|
|990pro / 990 pro 2tb|Samsung 990 Pro 2TB SSD M.2-2280 PCIe 4.0 x4 NVMe|
|ddr5 6000 cl30 32gb|TEAMGROUP Xtreem Black DDR5-6000 CL30 32GB (2x16GB)|
|850w gold|Thermalright AG-850 White 850W Fully Modular 80+ Gold Certified|
|360mm aio|Noctua NL-LC1-36 AIO 360mm|
|ddr5|Innodisk DDR5 UDIMM DDR5-5600 24GB (1x24GB) CL36|

## Performance / cache

主要11検索×3回、LIMIT 20＋lookahead 1、OFFSET 0。HTTP本文受信まで測定、nearest-rank percentile。

|計測|p50|p95|max|
|---|---:|---:|---:|
|deploy前 remote D1 REST単独（33回）|179.42ms|230.67ms|452.42ms|
|同SQL duration|5.50ms|50.13ms|53.37ms|
|production比較時 remote D1 REST（33回）|246.56ms|280.61ms|283.20ms|
|**production Worker HTTP（33回）**|**108.14ms**|**140.29ms**|**144.42ms**|
|同Worker Server-TimingのD1 SQL duration|5.31ms|30.01ms|36.78ms|
|Worker query初回（11回）|106.93ms|131.25ms|131.25ms|
|Worker query反復（22回）|108.14ms|140.29ms|144.42ms|

計測時刻・接続経路によりREST elapsedに変動がある。API比較時はdirectとHTTPを交互に実行した。
HTTPのCF-RayはNRTを観測。D1はSIN。latencyにはWorker→D1往復が含まれる。

初回/反復はisolate cold/warmの保証ではない。別のログ確認時の最初のhealthでは530.15ms
（Worker elapsed 402ms、SQL 0.1061ms）の待ち時間を観測した。検索33件の分布へ混ぜていないが、
接続初期化等の長い待ち時間があり得る。厳密なcold-start分布は未測定。

Cache APIは未導入。今回Node fetchのCF-Cache-Status/Ageは全てなしで、cached高速化は主張しない。
ブラウザ等にはGETの60秒cache headerが有効だが、D1 read削減を確認したedge cache baselineではない。

|Query|Worker HTTP p50 / p95=max ms|direct D1 rows_read/回|
|---|---:|---:|
|9800x3d|106.93 / 111.83|19|
|14900k|110.59 / 113.50|49|
|rtx5080|112.28 / 116.92|931|
|rtx 5080|107.12 / 108.14|931|
|ryzen 7|103.09 / 112.53|452|
|990pro|107.25 / 118.90|79|
|990 pro 2tb|106.66 / 124.89|99|
|ddr5 6000 cl30 32gb|103.38 / 109.18|2,590|
|850w gold|109.67 / 113.36|5,202|
|360mm aio|110.70 / 140.29|3,696|
|ddr5|131.25 / 144.42|35,963|

33 direct検索のread合計=150,033、writes=0。
追加ログで確認したWorker自身のD1 metadata:

|Query|rows_read|rows_written|SQL duration|
|---|---:|---:|---:|
|ddr5|35,963|0|36.031ms|
|ddr5 offset=20|35,963|0|30.4494ms|
|rtx 5080|931|0|5.8615ms|
|ryzen 7|452|0|7.0136ms|

OFFSETを変えても同じ広い候補集合のranking costが発生する。candidate explosionに対する既存の256件補助候補上限は維持した。

## Insights / read cost

`d1 insights --time-period=1d --sort-by=reads --limit=10 --json` に成功。
最大read要因にはingest（約150万）、今回のFTS全件比較（約103万）、identifier監査（約99万）が含まれた。
検索SQLの1グループではavg rows_read=35,963、9回で323,667 reads、avg duration=25.095ms、writes=0。
query parameterはInsightsに出ないため、この集計だけで全実行がddr5だったとは断定しない。
個別queryはrequest ID付きWorkerログ/直接実行のmetadataで確認した。

後続d1 infoの24h観測はreads=7,048,069、writes=813,985。
これは取込・監査・FTS比較・CLI/HTTP性能診断を含み、ユーザー検索だけの費用ではない。
Insightsはsampling/反映遅延/集計windowによりsync report総量と一致しない。アプリ設計は依存しない。

## チェック・残件・次の優先順位

成功: `npm run check`（schema一致＋55 tests）、local/remote `verify:plans` 28/28、
sync complete・dry-run no-op、stats/FK/quick_check、全量監査、120 remote benchmark、predeploy/deploy、
production HTTP 120比較、追加15 smoke/observability checks。

厳密local→remote top 10比較だけは既存投影差5件を検出して非0終了。原因・値・score差を記録し、比較結果を変更していない。
`sqlite_version()` はlocal D1の許可外関数として拒否されたので、SQLite内部versionは推測していない。

優先課題:

1. **派生FTSのバックフィル/取込投影の統一**を別タスクとして決める。再現性の問題であり、ranking改善で隠さない。
2. **API cache最適化**：broad queryの35,963 readsを反復HTTPで節約できるか、同期後鮮度も含め測定する。
3. D1 read cost最適化・edge rate limiting・見積もりサイト接続。現在のpublic APIにrate limiterは未設定。
4. 定期sync/deploy自動化、Phase 3 fuzzy searchは上記baseline/再現性対応後。

Worker/API契約は既定20・最大50件、先頭1,000件までのoffset pagination、GET cache header 60秒、POST no-store、CORS public read-only。
同期中のページ間snapshot保証や、cache hitによる費用削減の検証は今後の課題。

## Artifacts（Git管理外）

- `.cache/sync-remote-paid-dry-run.json` / `sync-remote-paid-complete.json` / `sync-remote-paid-confirm.json`
- `.cache/stats-remote-paid-complete.json`
- `.cache/completeness-remote.json` / `.cache/duplicates-remote.json`
- `.cache/search-remote-phase2.json` / `.cache/search-remote-complete-comparison.json`
- `.cache/remote-ranking-diagnosis.json` / `.cache/remote-projection-comparison.json`
- `.cache/plans-remote.json` / `.cache/d1-remote-performance.json`
- `.cache/api-production.json` / `.cache/production-smoke-observability.json`
- `.cache/production-tail.stdout.json` / `.cache/d1-insights-paid.json`
- `.cache/paid-production-summary.json`

Contains information from [BuildCores OpenDB](https://github.com/buildcores/buildcores-open-db),
made available under [ODC-By 1.0](https://opendatacommons.org/licenses/by/1-0/).
