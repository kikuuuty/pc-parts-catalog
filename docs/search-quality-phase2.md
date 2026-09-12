# Search quality Phase 2 — 2026-09-12

## 測定方法と不変性

Node v24.16.0 / Wrangler 4.131.1、WindowsのローカルD1 binding。
BuildCores commitは`eec0df175504ebd15f0f3e3a8249a18a22f00940`、normalizer versionは1。
製品・active製品はともに29,599件。

1. Phase 1エンジン＋既存40件を最初に実行し、Hit@1=97.5%、Hit@5/10=100%、MRR=0.98125、0件検索0を確認。
2. 検索コードを変更せず実DBから評価対象を確認し、120件のfixtureを固定。
3. **Phase 1エンジン＋拡張120件**のbaselineを保存。
4. developmentで一般ルールと性能を調整後に順位ルールを固定し、regression/holdoutを含めて評価。
5. 時間分析で発見したdevelopment queryの反復FTSを、同じ候補集合を返す非相関INへ最適化。
   全120件のtop 10 ID順が最適化前と同一であることを検証し、最終benchmarkを保存した。
   holdoutの個別順位を利用したルール調整やexpected変更は行っていない。

Before/Afterで以下の指紋は一致:

- catalog: `614b8b834cdcf9839fa6fd77d4ecc8c511c023b1b3852a65a91b98038eada57f`
- expanded fixture: `68d4f73da2ba143c06b5307cd84b97cb232db6489fbcee77b94e9974d925bfb7`
- 元40件のファイル: `3e2fec360c8051c375ec4091783b88dc09997da834c44979f05effaf86e64bc8`

Before engineのqueries.js SHAは`1d42ffa87a77ec719340cb30dbee841d8712e1726c7d5567f272b2e713b4e3ff`。
After engineはqueries.jsとsearch-intent.jsの原文配列JSONのSHA:
`131165dfc139177c1c8d5b117d77384cf4873c98a14754ebeec2f593618d7cdd`。
検索専用INDEX以外のDB値、upstream、local enrichment/identifier、duplicateは変更していない。

## Evaluation構成

**120件 = regression 40 + development 52 + holdout 28**。
新規80件は、全9カテゴリで実DBに存在する製品集合を確認したもの。
詳しいselector、サンプル、固定方法は[評価契約](search-evaluation-phase2.md)。

|カテゴリ|件数|
|---|---:|
|CPU|18|
|GPU|18|
|Memory|15|
|Storage|14|
|Motherboard|14|
|PSU|10|
|Case|9|
|CPU Cooler|11|
|Case Fan|11|

holdoutは同じカタログから事前設計した検索意図で、製品familyを完全に分離した未知データではない。
40件のexpectedを維持し、ラベルは別ファイル、追加80件も独立ファイルとした。

## Before / After

すべて「同じ拡張fixtureをPhase 1とPhase 2で評価」の比較。

|Suite|N|Hit@1 Before → After|Hit@5 Before → After|Hit@10 Before → After|MRR Before → After|Zero Before → After|
|---|---:|---:|---:|---:|---:|---:|
|Phase 1 regression|40|97.50% → **97.50%**|100% → **100%**|100% → **100%**|0.981250 → **0.981250**|0 → **0**|
|Phase 2 new|80|90.00% → **98.75%**|96.25% → **100%**|96.25% → **100%**|0.928125 → **0.993750**|3 → **0**|
|Overall expanded|120|92.50% → **98.33%**|97.50% → **100%**|97.50% → **100%**|0.945833 → **0.989583**|3 → **0**|
|development|52|88.46% → **100%**|94.23% → **100%**|94.23% → **100%**|0.908654 → **1.000000**|3 → **0**|
|holdout|28|92.86% → **96.43%**|100% → **100%**|100% → **100%**|0.964286 → **0.982143**|0 → **0**|

変更後のMISSING_PRODUCT / NO_SEARCH_MATCH / RANKING_FAILURE / EXPECTED_DATA_INVALIDはすべて0。
最上位一致が1位でないのは、既存fallbackの4位とholdoutの`micro atx case`の2位。

### Query class別

|class|N|Hit@1 Before → After|Hit@5 Before → After|MRR Before → After|
|---|---:|---:|---:|---:|
|exact_model|18|100% → 100%|100% → 100%|1.000000 → 1.000000|
|compact_model|4|100% → 100%|100% → 100%|1.000000 → 1.000000|
|family|8|100% → 100%|100% → 100%|1.000000 → 1.000000|
|manufacturer_model|24|100% → 100%|100% → 100%|1.000000 → 1.000000|
|model_spec|19|73.68% → **100%**|84.21% → **100%**|0.776316 → **1.000000**|
|spec_only|28|96.43% → **100%**|100% → 100%|0.982143 → **1.000000**|
|identifier|3|100% → 100%|100% → 100%|1.000000 → 1.000000|
|broad|15|86.67% → **93.33%**|100% → 100%|0.933333 → **0.966667**|
|fallback|1|0% → 0%|100% → 100%|0.250000 → 0.250000|

### Precision@K

`acceptable`を持つqueryだけのmacro平均。分母は固定K、空枠は非適合。

|評価対象|N|P@5 Before → After|P@10 Before → After|
|---|---:|---:|---:|
|全precision対象|44|91.36% → **98.18%**|90.23% → **98.64%**|
|broad classだけ|14|90.00% → **94.29%**|92.86% → **95.71%**|
|spec_only class|27|91.11% → **100%**|87.78% → **100%**|
|regression対象|6|100% → 100%|100% → 100%|
|development対象|23|90.43% → **100%**|89.57% → **100%**|
|holdout対象|15|89.33% → **94.67%**|87.33% → **96.00%**|

## 特に確認したケース

下記の略記はすべてDB表示名に基づく。重複レコードを統合せず、同名SKUが複数回出る場合もそのまま示す。

|Query|Before top 5（順序通り）|After top 5（順序通り）|
|---|---|---|
|`ryzen 7`|1700X / 1800X / 1700 / 1800X / 1700X（すべて2017年）|9850X3D（2026）/ 7700X3D（2026）/ 8700F（2024）/ 5800XT（2024）/ 9700X（2024）|
|`ryzen 9`|3950X OEM / 3900X OEM / 7900 / 7950X / 3900X|9950X3D2（2026）/ 9900X3D（2025）/ 9950X3D（2025）/ 5900XT（2024）/ 9900X（2024）|
|`rtx 5080`|ASUS PRIME 16GB / ROG Astral / PRIME 16 GB / ROG Astral WHITE OC / ProArt OC|同じtop 5を維持|
|`5070 ti`|Gainward Phoenix / Palit GamingPro V1 / Gainward Phantom GS / Gainward Phantom / Palit GameRock|同じtop 5を維持。release_year NULL製品も先頭に残る|
|`b650e`|GIGABYTE AORUS MASTER / **ASUS TUF B650-E WIFI** / Biostar GTQ / Gigabyte TACHYON / Gigabyte MASTER|GIGABYTE MASTER / Biostar GTQ / Gigabyte TACHYON / ASUS PRIME B650EM-A / Gigabyte MASTER|
|`b650e wifi`|**ASUS TUF B650-E WIFI** / NZXT N7（2023）/ NZXT N7（2022）/ ASRock PG RIPTIDE / ASRock PG Riptide|ASUS B650EM MAX GAMING WIFI / NZXT N7（2023）/ NZXT N7（2022）/ ASRock PG RIPTIDE / ASRock PG Riptide|
|`990 pro 2tb`|Samsung 990 PRO 2TB / 同heatsinkあり（2件のみ）|同じ2TB製品が1～2位 / 1TB / 4TB / 4TB heatsinkあり|
|`sn850x 2tb`|WD SN850X 2TB / 同heatsinkあり（2件のみ）|同じ2TB製品が1～2位 / 8TB / 1TB / 4TB|
|`ddr5 6000 cl30 32gb`|TEAMGROUP Xtreem Black / White / Corsair Vengeance RGB / TEAMGROUP Xtreem ARGB Black / White|同じtop 5を維持。typed 4条件も一致|
|`850w gold`|Thermalright AG-850 White / Seasonic ATX3-FOCUS-GX White / Gigabyte UD850GM PG5 / GameMax RGB Rainbow / Corsair RM850 2019|Thermalright / Seasonic / NZXT C850 White / NZXT C850 Black / Gigabyte。いずれもtyped 850W Gold|
|`360mm aio`|Noctua NL-LC1-36 / EK Nucleus CR360 / EK AIO D-RGB / TRYX PANORAMA SE White / Black|同じtop 5を維持。名前にAIOを含まないtyped候補も取得可能になった|

`b650e wifi`の最初の許容製品は**2位→1位**、P@5は80%→100%、P@10は70%→100%。
`b650e`もP@5 80%→100%、P@10 90%→100%。
太字のB650-E製品は、現DBのtyped chipsetがAMD B650であるためB650E許容集合には含まれない。
一方、B650EM製品は現DBのtyped chipsetに従って評価しており、メーカー公式仕様の検証ではない。

追加で`gskill 6000 cl30`、`b650 matx`、`noctua air cooler`は0件→1位。
`asus am5 atx`は4位→1位、`120mm air cooler`は2位→1位になった。
既存の14900K・990pro・rtx5080・9800X3D・285K・SN850Xと追加の空白SN850Xは1位を維持。

## Performance

`verify:plans`は**28/28成功**。拡張120 queryと追加5パスも実D1でEXPLAIN/実行し、
**125/125でproducts/spec全走査なし**。FTS virtual index走査と、限定した候補集合のmaterialize/sortは利用する。
大きいFTS結果は依然費用を要し、追加チェックの`ddr5`単独はrows_read=35,963だった。

### 同一120件の費用比較

|Suite|rows_read Before → After|elapsed合計 Before → After|D1 SQL duration合計 Before → After|
|---|---:|---:|---:|
|regression 40|15,441 → **15,483**（+0.27%）|2,596.5 → 3,055.0 ms|99 → 121 ms|
|development 52|138,965 → 178,415|2,512.9 → 3,946.7 ms|163 → 241 ms|
|holdout 28|31,718 → 68,865|1,630.7 → 2,157.8 ms|81 → 118 ms|
|overall 120|186,124 → **262,763**（+41.18%）|6,740.1 → **9,159.6 ms**|343 → **480 ms**|

|120件のelapsed分布|Before|After|
|---|---:|---:|
|中央値|71.95 ms|77.48 ms|
|p95|84.37 ms|88.67 ms|
|最大|91.38 ms|91.75 ms|

レイテンシと読取量は増加している。elapsedはローカルbindingとの往復を含む単回測定であり、
合計時間の増加と中央値/最大の変化を分けて示す。リモートD1の課金量・レイテンシは未測定。

補助候補を制限する前のdevelopmentではrows_read=253,615だった。
indexed補助取得を256件へ制限し、メーカー語だけへの広すぎる展開も抑制した。
さらに`gskill 6000 cl30`の反復FTSを非相関集合へ変更し、SQL durationを432 ms→9 msへ削減。
その際、全120件のtop 10順が同一であることをチェックした。
最終の最大SQL durationは12 ms（`ddr5 32gb`）。

### INDEX / DB size

新migrationは`0005_spec_search_indexes.sql`。追加INDEXは:

- memory_search_capacity
- memory_search_speed
- motherboard_search_chipset
- cooler_search_fan（NULL以外の部分INDEX）

ほかはPhase 1/初期schemaのINDEXを再利用し、FTS再構築・再同期は不要。
DBの`size_after`は **138,330,112 → 138,653,696 bytes**。
増分は**323,584 bytes = 316 KiB（約0.23%）**。FTS本文や製品データの追加ではない。

## Regressions / remaining issues

**最初の許容製品順位、計測したPrecision@5/10が悪化したqueryは0件**。
全順位や未ラベル製品の推奨度が不変という意味ではない。

残ったケース:

|Query|残る状態|
|---|---|
|`gaming x trio 5080`|期待する特定OC製品は4位。WHITE/非OCとの優先意図を推測していない|
|`micro atx case`（holdout）|最初の許容製品は2位。P@5=60%、P@10=70%|
|`mini itx case`（holdout）|最初は1位だがP@5=60%、P@10=80%|
|`b850 wifi`（holdout）|P@5=100%、P@10=90%。名称WIFIとtyped chipsetで定義した許容集合外が1件残る|

- Caseのフォームファクター表記とtyped値を使った順位改善は残る。holdoutを見て追加ルールを合わせ込まなかった。
- CPU familyの新しさはrelease_yearの弱いsignalのみ。AM4 refreshがAM5製品より上になることもあり、最新構成の推奨ではない。
- specは原則soft boost。モデル＋spec queryの下位には別容量等も残り、returned-result precisionの向上を全queryで保証しない。
- 追加typed recallは最大256件。元々FTSで一致しない製品を無制限に網羅するものではない。
- WiFiの有無、CPU CoolerのAM5互換性をkeywordからtyped/facetへ完全に解釈する機能は未実装。後者は明示的facetsを使える。
- 製品名/スペック/年/メーカーの元データの矛盾、duplicate、誤ったidentifierはそのまま残る。
- queryのtypo、任意の略称、曖昧な寸法・単位なし数字、fuzzy/semantic検索はPhase 3以降。

## 検証・保存物

成功した検証:

```sh
npm test
npm run check
npm run verify:plans -- --summary-only
npm run benchmark:search -- --summary-only --output .cache/phase2-expanded-after.json
node scripts/measure-search-phase2.js --check-ranking
node scripts/report-search-phase2.js compare --summary-only
```

テストは**46件成功**（Phase 1の35件＋評価3件＋spec検索8件）。
型/単位解釈、曖昧数値、NULL、キット合計容量、モデル優先、manufacturer、freshness中立性、
scope適用と256件上限、100 binds、migrationのデータ/FTS不変性を合成DBで検証した。

Git管理外のartifact:

- `.cache/phase2-regression-before.json`：拡張前の既存40件baseline
- `.cache/phase2-fixture-evidence.json`：検索結果順位を使わず確認した期待集合
- `.cache/phase2-expanded-before.json` / `phase2-expanded-after.json`：固定120件のBefore/After
- `.cache/phase2-comparison.json`：suite/class、性能、top 5、回帰一覧
- `.cache/phase2-plans.json`：125 queryのEXPLAIN、debug要因、D1メトリクス
- `.cache/query-plans.json`：28代表query

仕様は[search-phase2.md](search-phase2.md)、評価契約は[search-evaluation-phase2.md](search-evaluation-phase2.md)。
Contains information from [BuildCores OpenDB](https://github.com/buildcores/buildcores-open-db),
made available under [ODC-By 1.0](https://opendatacommons.org/licenses/by/1-0/).
