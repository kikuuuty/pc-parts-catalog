# FTS projection consistency — migration 0006 / 2026-09-13

## 結果

`fix/fts-projection-consistency` でforward migration **0006_fts_projection_consistency.sql**を追加した。
既存local、独立fresh local、production remoteの**29,599文書・FTS全列が完全一致**。
120 queryのtop 20順も3経路で一致し、以前の5件のtop 10差を解消した。

検索SQL、ranking/weight/boost/fallback、Golden expected、製品/spec/identifier/enrichment、normalizer意味は変更していない。
`NORMALIZER_VERSION=1`。Worker JS・binding・response契約も不変で、**再deployなし**。
本番versionは `c2002437-b299-4c61-8e70-6df8b8fcdcfc` のまま。

## Root causeとcanonical ruleの判断

0004の既存DB backfillはCPU/GPUのtyped分類だけを `family` に投影した。
同migrationのingest hookはpayloadの `spec.chipset` をカテゴリ制限なく読み、Motherboardにも投影していた。
結果、Motherboard 3,697文書の `family` だけが異なり、FTS corpusの長さ/語頻度を通じてBM25と細かな順位に差が出た。
当時の診断は[Paid baseline](production-paid-baseline.md#local-phase-2との厳密順位差)に履歴として保持している。

canonicalを既存local/remoteのどちらかの状態だけで決めたわけではない。
[Phase 1設計](search-relevance.md#field-aware-ranking--exact-boost)は `family` をCPU family/generationとGPU chipset/chip_seriesの投影と明記する。
[Phase 2](search-phase2.md#model--family--manufacturerの優先度)はMotherboard chipsetをtyped値でidentity判定し、
INDEX起点の候補取得とboostを追加する設計であり、FTS familyへの分類追加を要求していない。
Motherboard chipsetは既存legacy `text` にも含まれる。

したがって **Motherboard chipsetはfamilyへ重複投影しない**。
legacy textとtyped chipset検索はそのまま使う。特定queryの期待順位に合わせた例外ではなく、カテゴリの検索フィールド契約を統一した。

## Canonical mapping

### 全カテゴリ共通

|FTS列|生成規則|
|---|---|
|rowid|`products.id`（再採番しない）|
|name|保存済み `products.name`|
|manufacturer|保存済み `products.manufacturer`|
|series|保存済み `products.series`|
|variant|保存済み `products.variant`|
|family|下表のカテゴリ別分類。未知値は空文字、前後の空白だけtrim|
|text|既存normalizer v1のlegacy `search_text` 文書。backfillでは保存済みtextをそのまま保持|

name/manufacturer/series/variantは保存値のNULL/空文字を区別して保持する。
FTS tokenizer、prefix設定、BM25 column weightsは変更しない。

|Category|family|legacy textに含まれるtyped分類|
|---|---|---|
|cpu|`trim(coalesce(cpu.family,'') || ' ' || coalesce(cpu.generation,''))`|CPU family、generation|
|gpu|`trim(coalesce(gpu.chipset,'') || ' ' || coalesce(gpu.chip_series,''))`|GPU chipset、chip_series|
|motherboard|`''`|Motherboard chipset|
|memory|`''`|なし|
|storage|`''`|なし|
|psu|`''`|なし|
|case|`''`|なし|
|case_fan|`''`|なし|
|cpu_cooler|`''`|なし|

legacy textは `src/normalize.js` の既存単一定義を維持する:

```text
manufacturer → name → series → variant
→ spec.family → spec.generation → spec.chipset → spec.chip_series
→ upstream identifier values
```

truthy値を入力順のまま空白で連結する。identifierの重複排除/出典順序は既存normalizerに従う。
先頭0・句読点・内部空白・同じMPNの別origin等を変更しない。
local identifiersは別FTS、local enrichmentは投影しない。

### persisted dataとpayloadの分担

修復対象の5列はすべてpersisted products/CPU/GPUをsource of truthとした。
`product_search_projection` viewに規則を一度だけ定義し、migration backfillとfuture ingestで共有する。
新hookはpayloadから対象upstream_keyを特定するだけで、検索列の値をpayloadから再計算しない。

textまでrelational identifiersから再連結する方法は採らない。
identifierの元の配列順はrelational PK順と同じではなく、再連結はphrase境界や文書内容を変えるおそれがある。
今回textは元から両経路で一致しており、正規化意味を変える必要はない。
旧 `ingest_product` のlegacy text挿入＋normalizer単一定義を維持し、**修復対象5列をDB viewへ集約**した。
この分担を含め、全6列の結果が同じになることを実snapshotとオフラインテストで検証する。

## 0006の動作

1. `product_search_projection` viewを作成。
2. 古い `ingest_search_fields` triggerを置換。
3. 既存FTSとviewの5列をNULL-safeなrow-value `IS NOT` で比較し、不一致文書だけin-place UPDATE。

FTS tableをDROP/再作成せず、rowid/textを変更しない。
products、全typed tables、identifiers、raw、facets、local enrichmentをUPDATEしない。
inactive製品の文書も同じ規則で対象にする。active判定は従来の検索WHEREが担う。
これは既存の投影driftを修復するmigrationであり、欠落/孤立FTS行など任意のDB破損の復旧機能ではない。

旧 `ingest_product` はproducts/raw/identifier/typed spec/legacy textを書いた後、最後にstaging行をDELETEする。
新hookもその **BEFORE DELETE ON ingest** でviewを参照する。
兄弟triggerの作成順に依存せず、元のingest INSERTと同じ原子的処理に含まれる。
新規・更新・再activateで共通規則を使い、hash一致のno-op syncはFTSを書き換えない。
直接手動でproducts/specだけを変更する操作は従来どおり同期契約外。

0001〜0005はimmutable。0006で修復後の規則を変更する場合も新しいforward migrationを追加する。

## Local検証（remote適用前に完了）

### Path A: 既存Phase 2 DBをupgrade

- 0001〜0005、29,599製品の既存local DBをsnapshot。
- `npm run db:migrate` で0006だけ適用。
- 全FTS/保護対象データ/120 queryを再snapshotして比較。
- 既存localはcanonicalに一致していたため、FTS差分もデータ差分も0。

### Path B: 独立fresh local

`scripts/verify-fts-fresh.js` は `.cache/fts-fresh-*` に新しい独立local D1を作る。
既存DBを消去せず、0001〜0006適用 → 同snapshotを既存 `syncSnapshot()` で全量新規ingestする。
fresh DB自身の全FTS・120 debug top 20・benchmark・plansを保存する。

今回のfresh DB: `.cache/fts-fresh-43ByKz/`。
local updated/freshともHit@1=98.3333%、Hit@5/10=100%、MRR=0.9895833333、Zero=0、plans=28/28。
FTS全文に加え、**120件のtop 20 / search_score / search_fts_relevance / search_matchが完全一致**した。

remote適用前に `npm test`、`npm run check`、local `verify:plans` も成功した。
最終のsuiteは既存55件＋今回5件で **60件成功**。

### 追加オフラインテスト

`test/fts-projection.test.js`:

- 実0003→ingest→0004/0005と、0005→ingestの両方で旧driftを再現し、0006でfreshと一致。
- CPU/GPU/Motherboardの期待列、残り6カテゴリ、NULL/片側分類欠損、legacy text/identifier順序。
- 新規・更新・再activate、no-op同期、テストDBの不正投影をbackfillして同じ結果へ戻ること。
- 保存値とpayloadを意図的に異ならせ、projectionが保存済み値を参照すること。
- 失敗時のカタログ/FTS rollback、local identifier/enrichmentの保護。
- fingerprint比較がFTS内容差・保護データ差・順位差・微小数値差を区別できること。

## FTS fingerprints / equality

共通snapshot commit: `eec0df175504ebd15f0f3e3a8249a18a22f00940`。

|対象|文書数|FTS fingerprint|canonicalとの差|
|---|---:|---|---:|
|既存local＋0006|29,599|`53f62a6f…d082f22`|0|
|fresh local（0001〜0006→ingest）|29,599|`53f62a6f…d082f22`|0|
|remote production＋0006|29,599|`53f62a6f…d082f22`|0|
|remote適用前（履歴）|29,599|`a1b3b94b…a94808a`|3,697（familyのみ）|

完全なcanonical SHA-256:

```text
53f62a6f47d6eeb9869c57429f8552235faf2224f05e900c7e0e25142d082f22
```

fingerprint形式は、rowid昇順で
`[rowid, category, upstream_key, text, name, manufacturer, series, variant, family]`
をJSON配列化し、各行末LFを付けてSHA-256。NULLと空文字を区別する。
hashだけでなく全行・全列の値も比較して差分0を確認した。カテゴリ別hashも全9カテゴリで一致。

## Data invariance

local/remoteそれぞれのmigration前後で、次の全テーブルの件数と全列hashが完全一致した。
**created_at / updated_atも除外していない**。

- products=29,599 / active=29,599。
- 全9 typed tables合計=29,599。
- upstream_identifiers=113,588、local_identifiers=0、local_enrichments=0。
- upstream_raw=29,599、product_facets=38,219。
- sources、categories、sync_runs、sync_lockも不変。
- FK errors=0、latest sync=complete、live lease=0を適用前後に確認。

local enrichment / identifierの非空ケースはオフラインテストで不変性を確認した。
fresh DBとの跨DB比較ではproductsの作成時刻とsync_runsが異なるのは正常であり、
その差をmigration前後の変更とは混同しない。

## Search equality / quality

|指標|Upgraded local|Fresh local|Remote after|
|---|---:|---:|---:|
|Hit@1|98.3333%|98.3333%|98.3333%|
|Hit@5 / Hit@10|100% / 100%|100% / 100%|100% / 100%|
|MRR|0.9895833333|0.9895833333|0.9895833333|
|Zero results|0|0|0|
|Precision@5（44件）|98.1818%|98.1818%|98.1818%|
|Precision@10（44件）|98.6364%|98.6364%|98.6364%|
|Canonical top 20順|120/120|120/120|120/120|

以前差があった5件の例（beforeはremote、afterは3経路で一致）:

|Query|Before → After|
|---|---|
|intel arc b580|同名GUNNIR Photonの3/4位：`8ba0d597… / 2c54dcdc…` → `2c54dcdc… / 8ba0d597…`|
|b650e wifi|ASRock Riptideの4/5位：`92bc8a36… / 78872a85…` → `78872a85… / 92bc8a36…`|
|z890|1/2位：Gigabyte Z890 EAGLE / MAXSUN Z890 Terminator → MAXSUN / Gigabyte|
|b650 matx|3/4位：Biostar B650 MT / MSI B650M GAMING WIFI → MSI / Biostar|
|z790 wifi|4/5位：ASRock Z790 Lightning / ASUS PRIME Z790-V → ASUS / ASRock|

top 20まで広げるとremote before→afterで9 queryの並びが変わった。
上記5件に加え、b650e、msi x870e、b850 wifi、gigabyte z890の11〜20位にも旧driftの影響があった。
すべてcanonical localのtop 20へ一致し、expectedは変更していない。

### 数値の完全一致と浮動小数差

local upgraded/freshはscore/relevanceとも120/120完全一致。
local/remoteは**FTSと順位は完全一致**するが、73 queryの一部（306結果行）に微小な数値差を観測した。

- search_score: 1結果行で差、最大 **1.1368683772161603e-13**。
- search_fts_relevance: 306結果行で差、最大 **7.105427357601002e-15**。
- SQL内で `printf('%!.26g', ...)` にしても一部の差を再現。
  例: Ryzen 7のrelevance `20.8227909738306209` / `20.8227909738306174`。
- JSON数値変換だけの差ではない。FTS全内容・ID・元データが一致し、local同士では同値であることから、
  local/production D1の浮動小数演算経路の差まで切り分けた。
  内部ビルドやどの演算が差を生むかまでは確認できておらず、特定のSQLite version/compilerが原因と断定しない。

SQLやscoreを丸めて一致させる処理は追加しない。
比較CLIの既定は数値までstrict（cross-runtimeでは非0終了）。`--order-only` は数値差を全て報告したまま、
終了条件を「FTS全内容＋順位完全一致」に限定する。local fresh比較はこのflagを使わず成功した。

## Remote migration cost / operation

local gate完了後、remoteの適用前snapshot・active=29,599・sync=complete・lease=0・FK=0・履歴0001〜0005を確認した。
`scripts/measure-fts-migration.js` は0006本文にWranglerと同じ `d1_migrations(name)` INSERTを付け、
Wrangler `d1 execute --command=... --json` で1つのmulti-statement queryとして適用する。
Wrangler 4.131.1の `migrations apply` と同じSQL wrapper/実行経路で、通常CLIが表示しないcost metadataも保存した。
事後の `migrations list` で未適用なしを確認。再適用・remote再同期は行っていない。

|測定|値|
|---|---:|
|不一致FTS文書のUPDATE対象|**3,697**|
|rows_written（DDL/履歴込み）|**3,703**|
|rows_read（DDL/履歴込み）|**192,460**|
|SQL duration合計|**189.518ms**|
|CLI実行elapsed|**1,003.931ms**|
|DB size before|140,775,424 bytes|
|DB size after（事後queryで確認）|141,815,808 bytes|
|増分|1,040,384 bytes（約0.99MiB）|

UPDATE単体はreads=192,382 / writes=3,697 / SQL=188.7881ms。
残る6 writesはview/trigger/履歴のD1メトリクス。各statementのtotal_attemptsは1。
UPDATE応答直後のsize_after=141,451,264、事後確認では上表の値だった。commit後の事後値を最終サイズとして記録する。
`changes` と `rows_written` は異なるメトリクスで、課金見積りには返されたrows_writtenを使用する。
費用表はmigrationリクエスト分で、前後のfingerprint/検索/安全確認のreadsを含まない。

全29,599文書を無条件に書き直さないため、このsnapshotの修復はFreeの日次10万writesより小さい。
他のwriter・migrationの消費や将来のカタログ規模は別途見積もる。

作業中の事前readは一度403になったが、whoami/info確認後の再readは成功した。
測定CLIの最初の呼出しは先頭SQLコメントを引数と誤認して引数解析で停止したため、`--command=...` 形式へ修正。
再実行前にもmigration未適用を確認し、適用は成功した1回だけ。DB削除/再作成による復旧はしていない。

## Query plans / performance

local upgraded / fresh / remote afterでplans **28/28成功**。検索SQLは不変。
120 query、LIMIT 20/debugありのremote snapshot計測:

|指標|Before|After|
|---|---:|---:|
|rows_read合計|262,942|262,763|
|SQL duration合計|912.097ms|949.470ms|

read差は−179行。SQL時間は単回計測で変動があり、速度改善の主張ではない。

|Query|rows_read Before → After|SQL ms Before → After|
|---|---:|---:|
|intel arc b580|137 → 137|5.525 → 12.757|
|b650e wifi|458 → 456|13.244 → 13.113|
|z890|1,753 → 1,745|6.260 → 5.170|
|b650 matx|3,344 → 3,191|9.306 → 7.877|
|z790 wifi|1,203 → 1,203|10.745 → 13.678|

## Production Worker

本番 https://pc-parts-catalog.kikuuuty.workers.dev に対して、既存 `verify:api` を再実行した。
health/categories、9800x3d・14900k・rtx5080・ryzen 7・990pro等の主要検索、高度POST、
b650e wifi・z890・z790 wifiを含む120 Golden Queryを確認。
**API top 20＝remote direct top 20が120/120一致**し、修復後benchmark top 10とも一致した。
Worker/runtime/binding変更なしのため再deployは行っていない。

主要11検索×3回のHTTP elapsed: p50=108.19ms / p95=129.96ms / max=135.54ms。
同時比較のdirect REST: p50=183.92ms / p95=206.91ms / max=210.90ms。
Cache APIは変更せず、cache hitの最適化測定としては扱わない。

## 再現・検証コマンド

`.cache` を用意し、同期writerを停止して実行する。snapshotは保護対象全データも読むため、remoteではread量/時間に注意する。

```sh
node scripts/compare-fts-projection.js snapshot --search --output .cache/fts-local-before.json
npm run db:migrate
node scripts/compare-fts-projection.js snapshot --search --output .cache/fts-local-upgraded.json
node scripts/compare-fts-projection.js compare .cache/fts-local-before.json .cache/fts-local-upgraded.json --data-only --output .cache/fts-local-invariance.json
node scripts/verify-fts-fresh.js
# 表示されたfresh directoryのsnapshot.jsonと比較（今回の実パス）
node scripts/compare-fts-projection.js compare .cache/fts-local-upgraded.json .cache/fts-fresh-43ByKz/snapshot.json --output .cache/fts-local-fresh-comparison.json
npm run benchmark:search -- --summary-only --output .cache/search-fts-local-upgraded.json
npm test
npm run check
npm run verify:plans -- --summary-only
```

全local gate成立後のみproductionへ進む。今回の0006は既に適用済みなので、適用コマンドを再実行しない。

```sh
node scripts/compare-fts-projection.js snapshot --remote --search --output .cache/fts-remote-before.json
# 未適用の場合のみ。通常運用なら npm run db:migrate -- --remote でも同じ0006が適用される
node scripts/measure-fts-migration.js --remote --output .cache/fts-migration-cost.json
node scripts/compare-fts-projection.js snapshot --remote --search --output .cache/fts-remote-after.json
node scripts/compare-fts-projection.js compare .cache/fts-remote-before.json .cache/fts-remote-after.json --data-only --output .cache/fts-remote-invariance.json
node scripts/compare-fts-projection.js compare .cache/fts-local-upgraded.json .cache/fts-remote-after.json --order-only --output .cache/fts-local-remote-comparison.json
npm run benchmark:search -- --remote --summary-only --output .cache/search-fts-remote-after.json
npm run verify:plans -- --remote --summary-only --output .cache/plans-fts-remote-after.json
npm run verify:api -- --url https://pc-parts-catalog.kikuuuty.workers.dev --remote --golden --baseline .cache/search-fts-remote-after.json --output .cache/api-fts-after.json
```

full-row snapshot、カテゴリ別hash、差分JSON、score/順位、migration metadata、benchmark/API結果は上記 `.cache/` artifactに保存。
追加の数値診断は `.cache/fts-numeric-transport.json`、集計は `.cache/fts-fix-summary.json`。

## 意図的に対象外とした事項

API cache最適化、broad query read cost削減、rate limiting、fuzzy search、データ欠損/重複修正は実施していない。
今回の派生FTS driftは解消した。跨runtimeでの浮動小数末尾差は順位に影響していないが、数値bit単位の同一性は保証しない。

Contains information from [BuildCores OpenDB](https://github.com/buildcores/buildcores-open-db),
made available under [ODC-By 1.0](https://opendatacommons.org/licenses/by/1-0/).
