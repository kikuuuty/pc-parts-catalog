# Catalog quality baseline — 2026-09-12

## 測定対象と方法

- ローカルD1、Node v24.16.0、Wrangler 4.131.1。
- BuildCores commit: `eec0df175504ebd15f0f3e3a8249a18a22f00940`、normalizer version 1。
- 総製品 **29,599**、active **29,599**。
- カタログ指紋: `614b8b834cdcf9839fa6fd77d4ecc8c511c023b1b3852a65a91b98038eada57f`。
- Golden fixture SHA-256: `3e2fec360c8051c375ec4091783b88dc09997da834c44979f05effaf86e64bc8`。
- `src/queries.js` SHA-256: `baf3b1bd883261058e08d859450eb5f15f154d26a71acd9e8a7b7dc0195f3993`。

全カテゴリのactive製品を母数とした完全性・重複監査と、40件のGolden Queryを実行した。
3コマンドのJSON出力をJSON.parseできること、および同じカタログ指紋であることも確認した。
指紋は内部IDと同期日時も含むため、同じcommitから別のDBを再構築した場合には異なることがある。
現在の検索順序・正規化・FTS定義・カタログ値の変更は行っていない。

```sh
npm run audit:completeness -- --output .cache/completeness.json
npm run audit:duplicates -- --output .cache/duplicates.json
npm run benchmark:search -- --output .cache/search-benchmark.json
npm run audit:completeness -- --category gpu --field length_mm --by-manufacturer --year-from 2024 --year-to 2026
npm run audit:completeness -- --category storage --unknown-year --field capacity_gb
npm run check
```

生成JSONはGit管理外の `.cache/` に保存。CIも既存の実データ取込後に監査を実行し、artifactへ保存する。
`npm run check` はSchema整合性検証と **27件のオフラインテスト**を通過した。
既存14件に加え、完全性、空値、重複、期待製品解決、全4失敗分類、125位までの検索、
typed filter併用、DBエラーと同期競合の検出、fixture構造を検証している。

## 完全性

### 主要フィールドの存在率

|カテゴリ / フィールド|存在 / 母数|欠損|充足率|
|---|---:|---:|---:|
|CPU socket|789 / 789|0|100.0%|
|CPU core_count|789 / 789|0|100.0%|
|CPU thread_count|789 / 789|0|100.0%|
|CPU tdp_w|789 / 789|0|100.0%|
|CPU family|452 / 789|337|57.3%|
|CPU generation|424 / 789|365|53.7%|
|GPU length_mm|3,828 / 3,837|9|99.8%|
|GPU vram_gb|3,827 / 3,837|10|99.7%|
|GPU pcie_generation|1,168 / 3,837|2,669|30.4%|
|Memory capacity_gb / speed|4,838 / 4,838|0|100.0%|
|Memory height_mm|735 / 4,838|4,103|15.2%|
|Motherboard socket|3,697 / 3,701|4|99.9%|
|PSU wattage|3,292 / 3,297|5|99.8%|
|Case max_gpu_length_mm|3,607 / 3,778|171|95.5%|
|Case max_cpu_cooler_height_mm|1,291 / 3,778|2,487|34.2%|
|Case max_psu_length_mm|385 / 3,778|3,393|10.2%|
|Case Fan airflow_max_cfm|3,094 / 3,460|366|89.4%|
|CPU Cooler height_mm|1,678 / 2,404|726|69.8%|

全カテゴリでnameは100%。manufacturer欠損は合計47件、スペック行そのものの欠落は0件。
CPU family/generationの未分類には、Xeon/Threadripper等の現在の分類規則の対応範囲も影響している。
フィールドの存在は、値が正しい・適用対象である・独自検証済みであることの証明ではない。

### release_year

|カテゴリ|年が存在 / 製品数|充足率|
|---|---:|---:|
|CPU|697 / 789|88.3%|
|Memory|520 / 4,838|10.7%|
|Motherboard|756 / 3,701|20.4%|
|GPU|1,151 / 3,837|30.0%|
|Storage|76 / 3,495|2.2%|
|PSU|125 / 3,297|3.8%|
|Case|442 / 3,778|11.7%|
|Case Fan|625 / 3,460|18.1%|
|CPU Cooler|280 / 2,404|11.6%|

全体で **24,927件が年不明**。期間フィルタで「現行製品だけ」を調べたつもりでも、多数の製品が除外される。
例えば製品名に2024を含むCorsair RM1000xの記録でもrelease_yearはNULLだった。
年代比較では必ずUnknown群と母数も併記する。

実際の期間別・メーカー別実行例:

- GPU / 2024～2026 / length_mm: **608 / 608 = 100%**。
  ASUS 100/100、MSI 157/157、Gigabyte 88/88、Palit 38/38。
  これはrelease_yearが判明している期間内の製品だけの評価。
- Storage / 年不明 / capacity_gb: **3,417 / 3,419 = 99.94%**。

### identifier保有率

|種別|保有製品 / 29,599|保有率|
|---|---:|---:|
|いずれか|27,620|93.31%|
|MPN|27,565|93.13%|
|EAN|13,724|46.37%|
|UPC|11,671|39.43%|
|GTIN（type=gtin）|0|0%|
|JAN（type=jan）|0|0%|

identifierなしは **1,979製品**。うちCase Fanが1,860製品で、Case FanのMPN保有率は **1,588 / 3,460 = 45.9%**。
GTIN/JANは明示されたtypeの集計であり、EAN/UPCとして入っているコードを読み替えていない。
保有率はdistinct product単位で、同じMPNのcanonical/metadata両方への登録を二重計上しない。

## 重複候補

|種類|グループ数|関係する異なる製品数|
|---|---:|---:|
|identifier競合|**3,154**|**4,371**|
|名称一致候補|**546**|**1,137**|

identifier競合の内訳: **MPN 2,031、EAN 625、UPC 498**。GTIN/JANは0。
identifierを持たない製品を含む名称候補は **30グループ**。
空のidentifier行および保存value_keyと既存正規化関数の不一致は0件だった。

特に目立つ競合:

- PowerColorのMPN `OC` が **73製品**に紐付く。
- KingstonのMPN `16` が **72製品**、`32` が **56製品**に紐付く。
- `Corsair Vengeance RGB Black DDR5-6000 CL36 32GB (2x16GB)` が **7レコード**に存在する。

この件数をそのまま「重複製品数」とは呼べない。一般的な文字列がMPNに混入した例や、
同名の異なるSKU・地域・仕様が含まれ得る。出力は原文value、region、origin、origin_field、製品ID付きの確認候補。
自動削除・統合はしていない。

Golden Queryの準備でも、`Kingston FURY Beast Black DDR5-6000 CL30 32GB (1x32GB)` という名称が
2レコードに一致し、名称単独の期待値は `EXPECTED_DATA_INVALID` となった。
確認済みのMPN `KF560C30BB-32` に対応するIDを明示してfixtureを作成した。

## 検索ベンチマーク

|指標|結果|
|---|---:|
|query_count / scored_query_count|40 / 40|
|Hit@1|**87.5%**（35/40）|
|Hit@5|**92.5%**（37/40）|
|Hit@10|**95.0%**（38/40）|
|MRR|**0.8958333333**|
|0件検索|**2**|
|MISSING_PRODUCT|0|
|NO_SEARCH_MATCH|**2**|
|RANKING_FAILURE（11位以下）|0|
|EXPECTED_DATA_INVALID|0|
|消失した期待製品参照|0|

CPU 11、GPU 11、Storage 6、Memory 8、PSU/Case/CPU Cooler/Case Fan各1ケース。
広いシリーズ検索では明示した許容集合の最初の一致を評価するので、このスコアは検索結果全体のprecisionではない。
Motherboardの検索ケースはこの初期fixtureには含めていない（完全性監査には含む）。

### 検索品質上の問題

1. **`gaming x trio 5080` が0件**。
   確認した対象は `MSI GeForce RTX 5080 16G GAMING TRIO OC`。
   ユーザーの略称中の`x`が実際のカタログ名と一致せず、現在のAND検索で失敗する。
   別途「Gaming X Trio」という正式SKUの存在を確認したという意味ではない。
2. **`990pro` が0件**。`990 pro`なら既存Samsung製品を検索できる。
   連結したモデル表記とFTS tokenの不一致が可視化された。
3. **`14900k` / `intel 14900k` は正しいKが3位**。
   前方一致でKFとKSも候補になり、ID順でKF→KS→Kになる。
4. **`ryzen 7` の最初のRyzen 7が6位**。
   1～5位はThreadripperやRyzen 5。`7`はシリーズ専用フィルタではなく `"7"*` という前方一致で、
   型番・identifierなどの数字にも一致し得る。ID順がそれらを先に並べる。

3・4はHit@10上は成功なので、失敗分類だけを見ると見落とす。
JSONのrank/top_resultsまたは `--verbose` でHit@1/5の問題も確認できる。
初期実データでは11位以下のケースは0だが、オフラインテストでは125位のRANKING_FAILUREを確認している。

### 期待値の照合中に確認した別の不整合例

- `CPU/e80823a0-6dd5-47d0-b69b-852e92acf964`: nameは14900K、MPNはBX8071514900Kだがvariantは14900KS。
- `GPU/4a7c4013-3107-4db3-aca8-9cbeec3d01fd`: nameはMSIのGAMING TRIO WHITEだがmanufacturerはNVIDIA。

これらは準備時にレコードを照合して見つけた例で、現在の完全性監査が全件の意味的矛盾を自動検出するという主張ではない。
充足率が高くても値の整合性の課題は残る。

## 今回修正しなかったこと・次の改善候補

今回の目的はbaselineの計測であるため、ランキング、FTS、正規化、上流データ、重複レコードを変更していない。
次のタスクでは、同じfixtureでbefore/afterを比較しながら以下を検討できる。

- 型番完全一致と接尾辞を含む前方一致の優先順位。
- 製品名・シリーズとidentifierの検索上の扱い、短い数値tokenの処理。
- `990 pro` / `990pro`、略称・通称の対応。
- 汎用文字列MPNの精査、同名レコードのSKU確認、release_year等の補完方針。

欠損補完や重複統合は、出典と独自データを保護する既存設計の下で別途行う。

Contains information from [BuildCores OpenDB](https://github.com/buildcores/buildcores-open-db),
which is made available under the [ODC Attribution License](https://opendatacommons.org/licenses/by/1-0/).
