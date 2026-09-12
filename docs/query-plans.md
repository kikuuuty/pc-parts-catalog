# 検索SQLとINDEXの検証

## 再現手順

```sh
npm ci
npm run upstream:fetch -- --ref eec0df175504ebd15f0f3e3a8249a18a22f00940
npm run db:migrate
npm run sync
npm run verify:plans
```

検証はローカルの**実際のD1 binding**で実行する。一般のSQLiteだけをD1の代用として扱わない。
`src/queries.js` の `representativeQueries` に条件と期待INDEXを定義している。
CLIの検索と同じ `searchQuery()` がparameterized SQLを生成し、
`EXPLAIN QUERY PLAN` と実際のSELECTを両方実行する。
期待したINDEXが使われない場合は終了コード1。`INDEXED BY` による強制はしていない。

`.cache/query-plans.json` にSQL全文、params、EXPLAIN、戻り件数、D1 metaを記録する。
`--remote` で設定済みのリモートD1でも同じ確認ができる。
メタデータの変化でプランが変わった場合は、INDEX名のチェックを単に緩めず実クエリを確認する。

## 2026-09-12の実測

上記commitの29,599製品、Node 24.16.0、Wrangler 4.131.1、Windows、migration 0001～0003。
最終計測の `size_after` は **130,990,080 bytes**（約131MB / 125MiB）。
以下のrows_readはLIMIT 20でのローカルD1観測値で、リモートの課金量やレイテンシの保証ではない。

|条件|主なEXPLAIN結果|戻り件数|rows_read|
|---|---|---:|---:|
|CPU / Intel / Core i7|`cpu_family_cores (manufacturer=? AND family=?)`|20|40|
|CPU / AMD / Ryzen 7 / cores >=8|`cpu_family_cores (manufacturer=? AND family=? AND core_count>?)`|20|40|
|GPU / NVIDIA / VRAM >=16 / length <=320|`gpu_vendor_vram (chip_vendor=? AND vram_gb>?)`|20|58|
|RAM / DDR5 / capacity >=32 / speed >=6000|`memory_type_speed (ram_type=? AND speed>?)`|20|46|
|PSU / ATX / wattage >=850|`psu_form_wattage (form_factor=? AND wattage>?)`|20|40|
|Case / GPU clearance >=350|`case_gpu_clearance (max_gpu_length_mm>?)`|20|40|
|MPN BX80768285K|`upstream_identifier_exact` と `local_identifier_exact` の `(value_key=? AND type=?)`|1|6|
|keyword RTX 5080 / NVIDIA / length 250～320|FTS5 `VIRTUAL TABLE INDEX …:M1` → product PK → GPU PK|20|222|
|Storage / SSD / capacity >=1000 / PCIe >=4|`storage_type_capacity (storage_type=? AND capacity_gb>?)`|20|70|
|Fan / 120mm / airflow >=60 / noise <=25|`fan_size_airflow (size_mm=? AND airflow_max_cfm>?)`|20|71|
|Cooler / air / height <=160 / AM5|`cooler_type_height (water_cooled=? AND height_mm<?)` + `facets_value (attribute=? AND value=? AND product_id=?)`|20|170|
|Cooler / AM5のみ|`facets_value (attribute=? AND value=?)` → product/spec PK|20|1,810|

FTSのEXPLAINに `SCAN ... VIRTUAL TABLE INDEX` と出るのはFTSの検索演算子を使っているためであり、
products全表の文字列走査という意味ではない。identifier viewの `SCAN identifiers` も、
先に完全一致INDEXで得たUNION結果に対する処理である。

## 実測から行った調整

初期案ではGPU INDEXが `(chip_vendor, vram_gb, length_mm, product_id)`、
RAM INDEXが `(ram_type, speed, capacity_gb, product_id)` だった。
`ORDER BY vram_gb, product_id` / `ORDER BY speed, product_id` の最後のキーに対して、
`USE TEMP B-TREE FOR LAST TERM OF ORDER BY` が発生した。

残余条件よりもORDER BYのproduct_idを先にした `0003_query_plan_tuning.sql` により:

- GPU: rows_read **845 → 58**。
- RAM: rows_read **2,315 → 46**。
- クーラーは型付きフィルタに続いてfacetをEXISTSで照合するようにし、**6,492 → 170**。

INDEX数は増やしていない。変更後は `PRAGMA optimize` で統計を更新した。
キーワード検索のUNION、一部の複数選択やfacet起点検索のsortは許容している。

## SQLiteの制約を踏まえた運用

- GPUはVRAM範囲をINDEXで絞り、lengthは同INDEX中の残余条件。2つのレンジを同時にseekしているわけではない。
- RAMもspeed範囲をINDEXで絞り、capacityは残余条件。
- カテゴリ固有テーブルはそれ自体がカテゴリを限定する。category列を全スペックINDEXに重複させない。
- productsはactive部分INDEXの `(category, manufacturer, series, id)` と `(category, series, id)`。
  `(category)` / `(category, manufacturer)` の独立INDEXは左端prefixで代用できるので追加しない。
- その他のTDP、noise、clock等も型付き列で比較可能だが、すべてをINDEX化しない。
  既存のカテゴリ・選択フィルタで絞った候補に対して評価する。
- CPU family不明、PCIe世代不明等はNULL。未知を別製品へ誤分類しない。
- SQL例は `examples/queries.sql`。任意のSQLの先頭に `EXPLAIN QUERY PLAN` を付けてWranglerで検証できる。
- 将来クエリや分布が変わったら、実際のWHERE/ORDER BY、rows_read、更新コストを確認して新migrationで調整する。

## データ品質の確認

inspection reportの `fields_present` をカテゴリ件数で割ると検索列の情報充足率を確認できる。
今回のケース3,778件のうち、GPU最大長は3,607件、CPUクーラー最大高は1,291件、PSU最大長は385件。
NULLを0として検索すると「PSU長上限0mm」等の誤った互換性判断になるため、NULLのまま保持する。
CPUの既知family分類は452/789件。Xeon、Threadripper等の未対応分類はraw/series/nameを保持してfamilyはNULL。
互換性に使う際は上流の情報充足率と原データも確認する。

上流の出典とODC-By 1.0通知は [NOTICE.md](../NOTICE.md) を参照。
