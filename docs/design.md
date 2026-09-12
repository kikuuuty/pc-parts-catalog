# 設計と上流調査

## 調査対象

2026-09-12 に `buildcores/buildcores-open-db` の commit
`eec0df175504ebd15f0f3e3a8249a18a22f00940` を取得し、README、LICENSE.txt 全文、
`docs/DATA_MODEL.md`、`open-db/`、`schemas/`、対象9カテゴリの Schema 全文を確認した。
上流 Schema は draft-07。同期では**取得した同じcommitのSchemaをそのままAjvで検証**する。
このプロジェクトの列定義は検索用モデルであり、上流 Schema の代用品ではない。

### 実データの確認例（各 open-db/<category>/<UUID>.json）

|カテゴリ|確認したUUID（複数）|観察|
|---|---|---|
|CPU|007a5a23-1e12-45b7-90d0-565b80876539 / 7ab840c3-8c52-4ced-a65c-7b0922ca479e / e2cf2532-8c57-4ec2-96fb-4aaa846c8ca6|Threadripper 9980X / 9800X3D / 285K。top-level series と metadata.series が異なる例あり|
|RAM|0032510b-286b-400e-8782-9f18cbd5ef1d / 00224914-6d49-493d-8fda-5d0bfd2b087a|DDR5 7600 32GB / DDR4 2666 16GB。profile_support は空配列もある|
|Motherboard|007d8659-ef1f-4309-89d0-71d3e642532e / 006707a8-49f6-4151-925f-921053961944|socket、memory、PCIe/M.2の配列。記載値の正確性はSchema検証だけでは保証されない|
|GPU|007aa248-c727-4a07-8c28-28a68bf44262 / 00647170-d6a7-4a43-95ed-51f51d9f6deb|NVIDIA と EVGA/ASUS は別。古い metadata.series はチップ名を含む|
|Storage|00238939-8d02-4070-8025-8c959c5e7b5f / 000e2e21-7ddc-48cd-9a02-7d8b3947263f|8000/1000GB、M.2 PCIe 4.0 x4。variant に容量を持つ古いデータあり|
|PSU|0060a485-c883-4d82-b909-932ca919e345 / 005a96c8-8dc5-448f-b738-9e0d861d5e84|650/1200W ATX、複数地域のMPN。効率認証nullあり|
|PCCase|006f965a-1eaf-42ff-a595-85c9e7fda484 / 006b9bba-a671-4baf-b5b2-61077a7788eb|GPU最大長345/430mm、クーラー高null、PSU対応形式空配列|
|CaseFan|00508726-6cf5-4d66-abe7-f3f2a5c93301 / 004fe651-7d42-4fa3-9abf-8f3406472078|定数のairflow/noiseはminだけに入る。180/120mm|
|CPUCooler|0036141f-678c-4301-ba67-71087932632a / 008e314e-6766-477a-bfa0-9f4d90f5461c|240/360mm水冷。高さnull/60mm。MPNの内部空白も保持が必要|

## 上流の契約

- 1製品1JSON、UUIDファイル名と `opendb_id` が一致。カテゴリはディレクトリから取得。
- `metadata`: name, manufacturer, series, variant, releaseYear, part_numbers[]。
- `general_product_information.manufacturer_url` はメーカーURL。他のSKUは販売店のIDでありMPNに変換しない。
- `identifiers` は省略可能な**完全スナップショット**。version と identifiers[]、retailer_listings[]。
  identifier は type/value/region。type は mpn/gtin/ean/upc。verified は販売店listingの属性であり、identifierの検証済みフラグではない。
- `Storage.storage_type` が現行。旧 `type` は非推奨で、現行フィールドがない場合のみ明示した互換fallbackを使う。
- 多くの項目がnull/省略可能。欠損を0やfalseとして補わない。実データには0のダミー値もあるため、
  長さ・容量・TDP・クロック等の正であるべき検索値は0以下をNULLへ、コネクタ数等の0は保持する。
- ODC-By 1.0 の4.2（DBと文書の通知）、4.3（公開出力のAttribution）を確認。
  DB内の `sources` に出典、ライセンスURI、Attributionを格納。取得物に上流のLICENSE/READMEを原文のまま保存する。

## 検索モデル

内部カテゴリ: `cpu`, `memory`, `motherboard`, `gpu`, `storage`, `psu`, `case`, `case_fan`, `cpu_cooler`。
表示名は `categories` に CPU/MEM/M/B/GPU/Storage/PSU/Case/Case Fan/CPU Cooler を保持。

- `products`: INTEGER主キー、(source, upstream_key)一意、基本情報、active、content_hash、変更commit。
  upstream_idは元UUID、upstream_keyは `<上流カテゴリ>/<UUID>`。
  全件検証で `d92768ff-ecab-469e-b9a3-a9375ccf6f57` がCaseFan/CPUCoolerに重複することを確認した。
  前者はMSI MEG CORELIQUID E15 360 OEM FAN、後者は水冷クーラー本体で内容も異なる。
  UUIDだけで統合せず両方を保持し、inspection reportにカテゴリ間重複を記録する。
  カテゴリ移動は旧製品の論理削除＋新製品。独自補完情報の移し替えは根拠を確認した上で別途行う。
- 9個の1:1スペックテーブル: 数値はINTEGER/REAL。カテゴリはテーブル自体で限定されるためINDEXに重ねて持たない。
- `product_facets`: CPU対応メモリ、クーラーsocket、ケース対応M/B・PSU形式の多値属性のみ。
- `upstream_identifiers` / `local_identifiers`: 物理的に分離。`identifiers` view でorigin付きUNION ALL。
  同じidentifierが複数製品を指すことを許容し、誤って製品を統合しない。raw valueと完全一致用value_keyを保存。
  value_keyはNFKC・前後trim・ASCII大文字化。ハイフン/内部空白/先頭0は保持。JANはlocalで追加可能。
  metadata.part_numbersもMPNとして保持するがorigin_fieldでcanonical identifiersと区別する。
- `local_enrichments`: 任意の補完スペックや日本向け対応のJSON、根拠、検証日時。同期は書き込まない。
  将来のAPIが採用する優先順位を明示的に決めるため、現段階では上流検索列へ自動上書きしない。
- `upstream_raw`: 元のJSON全体を補助保存。複雑なコネクタ/ポート/販売店mappingも失わない。
- FTS5: 製品のmanufacturer/name/series/variant、CPU分類/GPUチップ名、上流identifierを索引化。
  local identifierも独立FTSへtriggerで反映。token前方一致AND検索で、検索時の製品名解析は不要。

### 主な列と変換

|テーブル|選択属性|数値（上流の単位を明示）|
|---|---|---|
|cpu|manufacturer、family（Core i7/Ryzen 7/Core Ultra 9）、generation、socket、microarchitecture|cores.total → core_count、threads、clocks.performance.* → GHz、specifications.tdp/ppt → W|
|memory|ram_type、form_factor、XMP/EXPO nullable boolean、kit_quantity|capacity → kit GB、modules.capacity_gb → module GB、speed → speed、cas_latency、height mm|
|motherboard|socket、chipset、form_factor、memory.ram_type|memory.max GB、slots、M.2 slot count、SATA port count|
|gpu|chipset_manufacturer → chip_vendor、chipset、chip_series、memory_type。board manufacturerはproducts|memory → vram_gb、length → length_mm、tdp W、boost MHz、total_slot_width|
|storage|storage_type、interface、form_factor、nvme|capacity GB、interfaceの明確なPCIe数値 → pcie_generation/lanes|
|psu|form_factor、efficiency_rating、modular|wattage W、length mm、主要電源コネクタ数|
|pc_case|form_factor、対応形式facet|max_video_card_length、max_cpu_cooler_height、max_psu_length → mm、dimensions_mm|
|case_fan|pwm、connector、flow_direction|size mm、quantity、airflow CFM、noise dB、static_pressure mmH2O|
|cpu_cooler|water_cooled、socket facet|height mm、radiator_size mm、noise dB、fan size/count、RPM|

CPU family は top-level series → metadata.series → name の順で既知のクラスを抽出。
generation は `Core i7 14000` 等の明確なfamily bucketの末尾から抽出し、CPU型番から世代を推測しない。
GPU chip_series は chipset から GeForce RTX 50 / Radeon RX 9000 / Arc B 等を抽出。未知の規則はNULL。
CPU/GPU分類にはnormalizer versionを付与し、規則を変えた際はhashへ反映して再計算する。
RAM speedは上流がMHzと説明する6000等の値をそのまま保持（実クロックへ半減しない）。
ファン/クーラーのmax未設定時はSchemaの「定数はminに格納」に従いmax検索列をminで補完する。
空の対応配列は「互換性なし」と断定せず「情報なし」として扱う。寸法一致だけで完全互換とはしない。

## INDEXとSQLの決定

代表SQLは `src/queries.js`。CLIも同じparameterized query builderを利用する。

- active製品に対する `(category, manufacturer, series, id)` は category一覧、manufacturer、manufacturer+seriesに対応。
  左端prefixで代用できる `(category, manufacturer)` は追加しない。
- `(category, series, id)` はmanufacturer指定なしのseries用。
- CPU `(manufacturer, family, core_count, product_id)` と `(socket, product_id)`。
- GPU `(chip_vendor, vram_gb, product_id, length_mm)` と `(length_mm, product_id)`、
  `(chip_vendor, chip_series, vram_gb, product_id)`。VRAM範囲以降のlengthは残余条件。
- RAM `(ram_type, speed, product_id, capacity_gb)`。speed範囲以降のcapacityは残余条件。
- PSU `(form_factor, wattage, product_id)` とwattage単独範囲用。
- Case GPU clearance、Storage capacity、Fan size+airflow、Cooler water_cooled+height/radiatorを選択。
- identifierは `(value_key, type, product_id)`。種別なし完全一致とMPN完全一致の両方をカバー。

SQLiteは通常1テーブルに1つのINDEXを選ぶ。複数レンジのすべてが同時にseekされると主張しない。
ORDER BYは範囲の主軸とproduct_idを使い、複数選択INや残余条件による一時sortは許容する。
他の型付き列も >= / <= / BETWEEN が使えるが、すべてにINDEXを張らず候補集合内で評価する。
`EXPLAIN QUERY PLAN` で7必須パターンおよびキーワード併用等を検証し、実測に基づいて調整する。

実測後の `0003_query_plan_tuning.sql` ではGPU/RAMのproduct_idを残余条件より前へ移し、
ORDER BYと揃えた。INDEX数は増やしていない。クーラーは型付き条件があるときfacetを相関EXISTSで照合し、
先にheight INDEXで候補を絞る。facet単独なら逆引きINDEXからINで候補を取る。

## 同期と運用

Node.js 24 ESM、Ajv、Wrangler。UI/API Workerのデプロイは不要。
取得はGit shallow clone/fetchで1つのcommitに固定。全9カテゴリとSchemaを検証してからD1を書き込む。
ファイル欠落/UUID不一致/同カテゴリ内キー重複/Schema違反時は同期全体を停止し、削除判定をしない。
変更対象はraw JSON+normalizer versionのSHA-256とD1のhashを比較して決める。
初回/更新/再出現は同じUPSERT経路。上流から消えた製品はactive=0、独自データや主キーは保持する。

1製品を `ingest` にINSERTするとtriggerが基本情報・スペック・上流identifier・facet・raw・FTSを更新し、
最後にingest行を除去する。**1 SQL statementの原子性**により、通信切断/途中失敗でも製品内のhashと詳細が不整合にならない。
全DBの一括atomic切替はしない。更新中は新旧製品が混在する。最後にsync runをcompleteにする。
途中失敗時は同commitで再実行し、DBのhashから再開する。全追加更新完了後のみ削除を適用する。
削除も製品単位で再実行可能。Actions concurrencyとDB leaseで同期writerの競合を防ぐ。

Freeは500MB/DB、read 500万行/日、write 10万行/日（INDEX/FTSも加算）。容量と初回の日次writeは別問題。
遠隔同期は書込行予算と製品件数上限で中断・再開可能にする。初回は数日に分けることを想定し、
週次更新は実際の差分量に依存する。予算は他クライアントの使用量を含まないためdashboardも確認する。
ローカルで全量のサイズ・検索計画を測定し、結果をREADMEに記録する。
