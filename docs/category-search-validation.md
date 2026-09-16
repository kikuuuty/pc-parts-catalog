# カテゴリ別検索基盤：ローカル検証結果

## 実行範囲

2026-09-16、Node.js 24.16.0 / Wrangler 4.131.1 / local D1(workerd)。
BuildCores commit `eec0df175504ebd15f0f3e3a8249a18a22f00940`、全30カテゴリ48,134製品。
既存のローカルsnapshotを独立cloneし、0008のupgradeを検証した。
production D1へのmigration・sync・deployは実行していない。

再現コマンド:

```sh
npm run check
npm run verify:search:local -- --source-location .cache/all-categories-fresh-location.json
# 生成されたcloneの品質/整合性を再測定
npm run verify:search:local -- --directory .cache/category-release-<suffix>
# 最新の検証cloneだけで全量更新費用を計測
npm run measure:sync:local
node scripts/report-search-validation.js
```

この実行のartifactは`.cache/category-release-xn6XiL/`。
`.cache/category-release-latest.json`が最新locationを指す。元DBを置換しない。
`migration.json`, `integrity.json`, `readiness.json`, `catalog-integrity.json`, `quality.json`,
`plans.json`, `detail-plans.json`, `detail-api.json`, `storage.json`,
`bm25-corpus.json`, `sync-noop.json`, `sync-refresh.json`, `sync-recovery.json`,
`summary.json`を保存した。データ本体/artifactはGit対象外。

## Migration / integrity / storage

|項目|結果|
|---|---:|
|0008 migration bytes|110,083|
|statement count|221（migration履歴INSERTは別）|
|最大SQL statement|2,988 bytes|
|最大CREATE TRIGGER|2,988 bytes|
|migration D1 SQL duration|1,524 ms|
|migration elapsed|4,703 ms|
|migration rows_read / written|386,325 / 96,489|
|category FTS数|30|
|category FTS shadow table数|150|
|全FTS shadow table数（local identifier補助索引含む）|154|
|FTS総数（local identifier補助索引含む）|31|
|sqlite_schema entries|432|
|DB bytes（再同期後、VACUUMなし）|243,617,792|
|used bytes / freelist bytes|230,678,528 / 12,939,264|
|category FTS関連bytes|46,895,104|
|raw JSON bytes|91,137,805|
|identifier rows|180,802|

221個のstatementをD1 atomic batchで適用。100KB/statement上限に対して十分小さい。
DB容量は約232.33MiB、usedは約219.99MiB。空きpageを含む実ファイル容量で、compaction後の値ではない。

|FTS invariant|結果|
|---|---:|
|active products|48,134|
|missing FTS row|0|
|duplicate FTS row|0|
|wrong category row|0|
|inactive/deleted orphan|0|
|projection drift|0|
|missing durable search document|0|
|FTS schema errors|0|

product基本列、raw、typed specs、upstream identifiers、facets、active stateをsource snapshotと照合した。
新規/更新/category変更/inactive/reactivate/hard delete/rollback/partial/resumeは30カテゴリすべてでテストした。
local identifier/enrichment、lease、削除guard、hash resumeの既存テストも維持した。

## Search intentと品質

旧120件とextended102件のquery/expectedを変更せず再分類し、11件のUIケースを追加した。
合計233件: lookup 111 / identifier 18 / browse 86 / browse_filter 15 / filter_only 3。
extended102件は引き続き人間レビュー待ち。以下はその測定も含むmacro平均。

|Intent|結果|
|---|---|
|lookup|Hit@1 **95.50%** / Hit@3 **97.30%** / Hit@5 **98.20%** / MRR **0.9692**|
|exact_model subset|30/30 Hit@1、100%（うち12件はレビュー待ち）|
|identifier|18/18 Hit@1、100%（うち15件はレビュー待ち）|
|browse|Recall@10 **29.47%** / Recall@20 **41.86%** / Precision@10 **94.53%** / Precision@20 **93.44%**|
|browse relevant coverage|UI keyword window内macro **92.65%**|
|browse_filter|Recall **100%** / Precision **100%** / FP=0 / FN=0 / 条件外=0|
|filter_only|全3件でexact set equality / pagination correctness合格。Recall/Precision **100%**|

lookupの既存reviewed47件ではHit@1/3=97.87%、Hit@5=100%、MRR=0.9840。
lookup/identifier/browse/browse_filterのzero resultは0。filter_onlyは意図したnegative caseが1/3で、予期しないゼロではない。

Recall@20の分母は**source上の全relevant set**で、20件を超える集合では100%にならない。
例えばGeForceの2,677件に対する20件は0.75%。このraw recallを隠さず、gateでは到達可能なRecall@20も考慮する。
候補window全体のbrowse precisionは85.81%、FP=1,811/FN=7,195（複数ケースの延べ数）。
FNにはkeywordの1,000件window上限も含む。これは全候補を漏れなく閲覧できたという結果ではない。

### 実際の絞り込み

|操作|source該当数|取得|Recall / Precision|
|---|---:|---:|---|
|MAG|80|84|100% / 95.24%（Top20 precision 100%）|
|MAG + ATX + AMD B850|4|4|**100% / 100%**|
|OLED + 26.5〜27 inch + 3840×2160|9|9|**100% / 100%**|
|keywordなし ATX + AMD B850|58|58|**100% / 100%**|
|keywordなし DDR5 + 32GB|1,262|1,262|**100% / 100%**|

ROG/Vengeance/Keychron/Logitechのsource relevant setも全件候補に入った。
GeForceは1,000件keyword windowでcoverage 37.36%。明示filterでの絞り込みが必要。
filter-onlyは既存1,000件上限では262件欠落したため、keyword-freeのwindowをreviewed catalog上限100,000へ拡張した。
cache admissionは標準20件・先頭6ページを維持。異なるpage size（50/37）、distinct ID、再取得順を検証した。

## Performance / query plan

local D1の50件検索SQLのfirst-page値。中央値/p95は各intentのケース間分布。
全ページ合計costはartifactで分離。HTTP往復やremote課金量の保証ではない。

|Intent|rows_read median / p95|SQL duration ms median / p95|
|---|---:|---:|
|lookup|19 / 370|2 / 5|
|identifier|22 / 58|2 / 3|
|browse|709 / 6,987|3 / 10|
|browse_filter|481 / 15,113|2 / 7|
|filter_only|264 / 3,787|1 / 4|

- 45代表search plan: **45/45合格**、catalog full scan=0。
- 233品質caseもcatalog full scan=0。候補集合のGROUP BY/ORDER BY用temp B-treeは全caseで可視化。
- Product Detail: **30カテゴリ×4 query=120 plan合格**。PK/product_id indexes、catalog/identifier/facet full scan=0。
- Detail MISS rows_read median=11、p95=21。30カテゴリのDetail/cache contract合格、HIT SQL=0。

## Sync cost / resume

- no-op: 48,134 unchanged、product/FTS再書込0。report rows_read=48,144、rows_written=3（run/lease管理）、elapsed=5.03秒。
- full refresh: 48,134 updated、残件0、elapsed=336.79秒、SQL duration合計=24,087ms。
  完了記録/lease解放を含む全query cost: read=4,016,380、write=1,559,580。
- テスト計測の途中終了後、通常のlease期限切れ回収とhash resumeで37,650 unchanged、10,484 updatedを確認。
  leaseの強制解除やproduction操作は行っていない。
- 全量refresh後もsource table/projection保全とFTS integrity合格。

## Release gate結果とproduction前残件

**release gateは未合格**。実装/自動テストの成功とproduction品質承認を区別する。

1. extended102件の人間レビュー。SKU同等性・重複・query weightingを確認し、`search-reviews.json`へfixture hash・reviewer・根拠を記録する。現在は空であり承認を代行していない。
2. 以下10個の旧自由文browse caseは新しい集合品質floorに未達（13指標違反）:
   `p2-storage-990-2tb`, `p2-storage-sn850-2tb`, `p2-storage-sn850-4tb`,
   `p2-storage-990-1tb`, `p2-storage-sata1tb`, `p2-board-b650e-wifi`,
   `p2-case-meshify`, `p2-case-matx`, `p2-case-itx`, `p2-cooler-freezer360`。
   explicit filter経路は合格しているが、soft spec/free-text候補の混入は残る。
   検索結果に合わせたexpected変更や、旧順位一致による免責は行っていない。
3. production切替手順を別途実施。旧Workerは削除される索引を参照するため、migrationと新Workerの切替を調整する。
4. remote D1の実費/latencyとproduction HTTP/cacheを別途確認。

自動テスト: **156 tests pass / 0 fail**、schema generator一致。Workerのlocal環境dry-run bundleも成功。
新しいrelease gateはreview/品質未達を検出して停止する。CIのrelease検証も同じ判定となる。

## 整理したコード

- production routingの旧`searchIndex`設定と文字列置換、巨大なカテゴリ分岐を生成する旧generatorを廃止。
- shared/category corpus A/B adapter/driver/reporter、A/B cost比較、旧SQL oracle、旧phase順位比較scriptを削除。
- corpus実験文書、旧Phase 1/2品質・評価契約を削除し、正式architecture/UX評価/API文書へ統合。
- BM25説明・DF/文書長、storage、query plan、D1 cost、source fingerprint、Golden loader、sync cost、debug scoreは維持。
- 適用済みmigration履歴とupgradeテストは残し、正式runtimeの検索経路はcategory FTSのみ。
