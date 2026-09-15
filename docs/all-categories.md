# BuildCores全カテゴリ対応・ローカル検証結果

2026-09-15、Node.js 24.16.0 / Wrangler 4.131.1 / Windows local D1で検証。
上流は [eec0df175504ebd15f0f3e3a8249a18a22f00940](https://github.com/buildcores/buildcores-open-db/tree/eec0df175504ebd15f0f3e3a8249a18a22f00940) に固定。
このsnapshotの `open-db/` 全ディレクトリと `schemas/*.schema.json` を照合した。
**上流30カテゴリ・30 Schema、対応30、未対応0。48,134 JSON全件がvalidation成功。**
今回の実施範囲はローカルmigration・sync・検索・検証。productionへのmigration、sync、deployは未実施。

## アーキテクチャ

- `src/model.js` がカテゴリregistryとAPI一覧の正本。upstream名、DB ID、label、table、fields、indexes、normalizer、facets、searchFields、searchIndexを参照できる。
- `src/normalize.js` は共通product、identity version、MPN/UPC/EAN/GTIN、`metadata.part_numbers`、source commit、hash、完全なraw JSON、基本search textを生成する。
- 既存9カテゴリの複雑なspec規則は `src/normalizers/legacy.js` の関数へ移動。`NORMALIZER_VERSION=1`、hash入力、単位、NULL、分類、identifier順序、既存search textを維持した。
- `src/extended-models.js` は追加21カテゴリの宣言。単純なscalar mappingとarray facetを分け、Monitorの構造化port presenceのみ小さな専用関数で処理する。製品名からspecを推測しない。
- 共通情報中心のカテゴリも `product_id` だけのspec表を持つ。これにより既存のJOIN・API `specs: {}`・整合性検査を統一できる。
- `upstream_raw` は `JSON.stringify` した元JSON全体を保持する。未選択field、配列、port数、retailer listing等も失わない。元ファイルの空白レイアウトを保存する形式ではない。
- `upstream:fetch` / `upstream:inspect` / `sync` はsparse worktreeでなくGitの完全なtreeを調べる。未知カテゴリ、Schemaだけ存在するカテゴリ、Schema欠落、定義済みカテゴリの消失はD1書込前に失敗し、`.cache/upstream-categories.json` に保存する。
- 追加カテゴリのmapping対象fieldが上流Schemaから消えた場合、またはarray facetがarrayでなくなった場合も失敗する。

### FTSと既存rankingの保護

BM25のIDF・平均文書長はFTS表全体に依存する。category WHEREだけでは新カテゴリ追加による既存順位変動を防げない。
そのため既存 `product_fts`（29,599文書）を維持し、追加カテゴリは同じ6列・tokenizer・prefix設定の `extended_product_fts`（18,535文書）へ保存する。
registryのsearchIndexをSQLコンパイラが選択し、基本検索はmanufacturer/name/series/variant/identifierを対象とする。
identifier boostの共有製品数判定も同じFTS集合に限定し、新カテゴリの同じMPNが既存カテゴリのtrust判定を変えないようにした。
明示的なidentifier検索の型・正規化・先頭0・provenanceとlocal identifier検索は維持する。

既存Phase 2 intent、candidate上限、ranking tier、score式、fallback、paginationは維持した。
新カテゴリの索引付きsort fieldにfilter/rangeがある場合はspec INDEXからproduct PK/facetをprobeする。
fresh統計でKeyboardがcategory起点のsortを選んだ問題をこの範囲で修正し、4,547 reads → **86 reads**となった。

### Migrationとrelease

`0001`〜`0006` は変更していない。`0007_all_categories.sql` が21 categories、21 spec表、8 spec INDEX、追加FTS、全カテゴリ対応ingest triggerを追加する。
既存product ID・表を再作成せず、既存データのUPDATEやFTS rebuildを行わない。
ingestは従来どおり1 SQL statementのtransaction、lease check、差分hash、部分同期/resume、削除率guardを使う。

generatorは初期9カテゴリの `0002` と拡張 `0007` を検査する。API契約テストのカテゴリ一覧もregistryを参照する。
release readinessは全spec・raw・両FTS projection/所属・migration履歴を確認し、既存Golden floorを継続する。
FTS generationは7となり、releaseのcache epochに反映される。
CIで固定snapshotの全カテゴリ検証と実際のno-change syncを実行し、inventory/inspection/verification reportをartifact化する。

## カテゴリ別ingest結果

`identifiers` は `upstream_identifiers` の行数。canonical identifiersとmetadata.part_numbersは出所別に保持するため、ユニークなコード数とは異なる。
このDBにlocal identifierは0件。全カテゴリでspec orphan/欠落は0。

|上流 → DB ID|JSON|validation成功|D1 active|spec行|identifiers|
|---|---:|---:|---:|---:|---:|
|CPU → `cpu`|789|789|789|789|4,035|
|RAM → `memory`|4,838|4,838|4,838|4,838|16,349|
|Motherboard → `motherboard`|3,701|3,701|3,701|3,701|16,539|
|GPU → `gpu`|3,837|3,837|3,837|3,837|16,231|
|Storage → `storage`|3,495|3,495|3,495|3,495|14,927|
|PSU → `psu`|3,297|3,297|3,297|3,297|14,933|
|PCCase → `case`|3,778|3,778|3,778|3,778|13,940|
|CaseFan → `case_fan`|3,460|3,460|3,460|3,460|7,414|
|CPUCooler → `cpu_cooler`|2,404|2,404|2,404|2,404|9,220|
|Accessory → `accessory`|321|321|321|321|783|
|CaptureCard → `capture_card`|32|32|32|32|142|
|Chair → `chair`|255|255|255|255|477|
|Desk → `desk`|335|335|335|335|592|
|Headphones → `headphones`|3,096|3,096|3,096|3,096|10,504|
|Keyboard → `keyboard`|4,214|4,214|4,214|4,214|13,246|
|Laptop → `laptop`|118|118|118|118|663|
|Lighting → `lighting`|14|14|14|14|32|
|Microphone → `microphone`|115|115|115|115|605|
|Monitor → `monitor`|3,867|3,867|3,867|3,867|19,750|
|Mouse → `mouse`|4,466|4,466|4,466|4,466|12,846|
|Mousepad → `mousepad`|130|130|130|130|167|
|NetworkCard → `network_card`|178|178|178|178|900|
|OS → `os`|11|11|11|11|51|
|PrebuiltDesktop → `prebuilt_desktop`|200|200|200|200|632|
|SoundCard → `sound_card`|84|84|84|84|343|
|Speaker → `speaker`|573|573|573|573|2,548|
|Stand → `stand`|1|1|1|1|2|
|ThermalCompound → `thermal_compound`|227|227|227|227|1,106|
|VRHeadset → `vr_headset`|4|4|4|4|32|
|Webcam → `webcam`|294|294|294|294|1,793|
|**合計**|**48,134**|**48,134**|**48,134**|**48,134**|**180,802**|

identifier内訳: MPN 132,411 / EAN 28,280 / UPC 20,007 / GTIN 104。
追加製品18,535、既存製品更新0、削除0。カテゴリ間UUID共有は2組（CaseFan/CPUCooler、CaseFan/Mouse）で、それぞれ別のproduct ID/upstream_keyを保持する。

## typed fieldとfacetの選択

全scalar field名・型・source mappingは `src/extended-models.js` を参照。NULLは未知を表し、0/falseは意味があるfieldで保持する。

|カテゴリ|主なscalar typed field|facet|
|---|---|---|
|Monitor|screen_size_inches、resolution_width/height、refresh_rate_hz、panel_type、response_time_ms、hdr、brightness_nits、adaptive_sync、aspect_ratio|ports（Schema定義のportに正の個数がある場合のみ）|
|Keyboard|switch_model、switch_type、size、layout、hot_swappable、polling_rate_hz、battery_capacity_mah|connectivity、features|
|Headphones|headphone_type、ear_cup_type、driver_size_mm、weight_g、battery_life_hours、has_microphone|connection_types、features、platforms|
|Mouse|shape、size、sensor、weight_g、max_dpi、polling_rate_hz、buttons、battery_life_hours、length/width/height_mm|connectivity、grip_types|
|Webcam|resolution、frame_rate_fps|connectivity_type|
|Microphone|scalarなし|connectivity_type、polar_pattern、features|

Webcamのframe_rate_fpsはSchemaにある `24fps` / `30fps` / `60fps` / `90fps` / `120fps` の明示的な変換だけ。
`frame_rate_other` や製品名の数字を解釈しない。Monitorのfree-text connectorsは分割せずrawに保持する。
headphonesのwireless_rangeはSchemaの単位表記がfeet/metersと曖昧なためtyped化していない。

**共通情報＋identifier＋raw中心の15カテゴリ:** Accessory、CaptureCard、Chair、Desk、Laptop、Lighting、Mousepad、NetworkCard、OS、PrebuiltDesktop、SoundCard、Speaker、Stand、ThermalCompound、VRHeadset。
Speakerのlighting配列も今回はraw保持。速度、CPU/GPU、熱伝導率、解像度などを製品名から創作しない。

## API契約

`GET /v1/categories` はregistryの全30 DB IDを返す。既存順序9件に追加カテゴリが続く。
全カテゴリでcategory一覧、manufacturer/series/variant filter、name等のkeyword、identifier検索ができる。
`specs` はカテゴリのscalar field、共通情報のみのカテゴリでは `{}`。

現行productionのdefaultレスポンスにはidentifier配列がないため、既定の形式・GET cache keyを維持し、**POSTのopt-in**を追加した。

```json
{
  "category": "keyboard",
  "filters": { "size": "75%" },
  "ranges": { "polling_rate_hz": { "min": 1000 } },
  "facets": { "connectivity": ["Bluetooth", "Wireless 2.4GHz"] },
  "orderBy": "polling_rate_hz",
  "include": ["identifiers", "facets"],
  "limit": 20
}
```

`include` は重複のない `identifiers` / `facets` の配列のみ。各製品へ要求したpropertyを追加する。
identifiersは `{type,value,region,origin,origin_field}` の配列、facetsは `{connectivity:[...],features:[...]}` の形式。
空の場合はそれぞれ `[]` / `{}`。上流/local双方のidentifier provenanceを保持する。
検索後の返却page（最大50製品）に対して1回のindexed queryを追加し、lookahead行の情報は取得しない。
従来requestはD1 1 query、include使用時は最大2 query。telemetryは合計read/write/durationを記録する。
POSTのrate limiting、複雑度制限、no-store、error handlingを引き継ぐ。

## 検証結果

- `npm run check`: **120 tests pass**。元の94件を維持し、全追加カテゴリをtable-drivenで検証。
- Phase 2（9カテゴリのみのrefactor）: 94/94 pass、29,599件の差分0、120クエリのtop20/score/FTS差分0。
- Golden fixture SHA-256は従来の `68d4f73da2ba143c06b5307cd84b97cb232db6489fbcee77b94e9974d925bfb7` のまま。
- **Golden 120/120 HIT**、Hit@1 **118/120**、Hit@5/10 **120/120**、MRR **0.9895833333**。
- Precision@5 **98.1818%**、Precision@10 **98.6364%**（44 cases）。expected変更0。
- 変更前 vs 更新後: 全120のtop20順、match type、score、relevanceが完全一致。既存29,599 FTS文書のSHA-256も一致。
- 既存product（timestamp含む）、9 spec表、raw、identifier、facets、localデータは変更前fingerprintと一致。差は同期履歴のみ。
- 実Worker HTTP: 120 Goldenのtop20、product共通列、specsがdirect local D1と一致。追加21カテゴリのkeyword/identifier/includeレスポンス成功。cache MISS→HIT、POST本文一致、pagination/契約も成功。
- query plan **45/45成功**（既存37＋追加8）、catalog full scan 0。upgraded/fresh両D1で確認。
- fresh local D1へ48,134件を全件ingestし、upgraded DBと全spec/raw/identifier/facet/追加FTSのfingerprintが一致。既存FTS、120 top20/scoreも一致。productsのtimestampとsync履歴は別DBとして異なる。
- 保存済みproduction測定（2026-09-13、同snapshot）との比較: FTS文書差0、top20差0。RESTの浮動小数点serializationによる最大score差 `1.1368683772161603e-13`、最大relevance差 `7.105427357601002e-15`。今回remoteへ新しいqueryや書込は実行していない。
- `release:verify -- --local`: readiness、integrity、120 Golden floor、45 plans、production設定のWorker build dry-run成功。

### Integrity / no-change sync

`verify:catalog` は全48,134行のstored raw、hash、spec値をvalidated snapshotと照合する。
`foreign_key_check=[]`、`quick_check=ok`、orphan/wrong-category spec=0、missing spec=0、missing raw=0、duplicate source/upstream_key=0。
両FTSのmissing/wrong-corpus/orphanとfield-aware projection driftも0。

同一snapshot再同期はunchanged **48,134**、added/updated/reactivated/deleted **0**、ingest statement **0**。
products/raw/identifier/spec/facet/両FTS/localデータのfingerprint差0。
報告の `rows_written=3` は途中時点までのlease/sync管理書込で、catalog rewrite数ではない（finalization/lease解放も別途行う）。
テストでは書込拒否triggerも使って不要なwriteが行われないことを確認した。
追加21カテゴリでlocal identifier/enrichmentを入れ、原子的失敗→部分更新→resume後の保護と検索も確認した。

## DBサイズ

|測定|bytes|MiB|
|---|---:|---:|
|変更前の既存local D1|138,653,696|132.2305|
|全カテゴリ追加後の既存local D1|204,369,920|194.9023|
|増分|65,716,224|62.6719|
|fresh全カテゴリD1|206,127,104|196.5781|
|raw JSON UTF-8本文合計|91,137,805|86.9158|

DBサイズはD1の `meta.size_after`。raw本文は `sum(length(CAST(raw_json AS BLOB)))` であり、SQLiteページ割当/INDEX/余白を含まない。
raw本文だけでDB全体の**44.59%**。rawは全件保持しており、容量削減の削除はしていない。
FTS合計48,134、identifiers合計180,802、facets 42,443。

[Cloudflare D1の公式制限](https://developers.cloudflare.com/d1/platform/limits/)（2026-09-15参照）はPaid **10 GB/DB**、Free **500 MB/DB**。
現在の約204.4 MBは十進換算でPaid上限の約2.04%、Free上限の約40.87%で、今回の拡張によるサイズ増加は現実的。
schemaは100列、bindは100、単一row/valueは2 MB、SQL statementは100 KBという制限も継続して考慮する。
ingestの1.5 MB record/1.8 MB chunk制限は既存どおり。

## 再現手順とartifact

```sh
npm run upstream:fetch -- --ref eec0df175504ebd15f0f3e3a8249a18a22f00940
npm run upstream:inspect
npm run db:migrate
npm run sync
npm run verify:catalog
npm run check
npm run benchmark:search -- --summary-only --output .cache/all-categories-golden.json
npm run verify:plans -- --summary-only --output .cache/all-categories-plans.json
npm run verify:worker:local -- --output .cache/api-all-categories.json
npm run release:verify -- --local
```

fresh比較は `node scripts/verify-fts-fresh.js --output .cache/all-categories-fresh-location.json`。
このコマンドは隔離された新規local D1を作成し、そのpathを出力する。
同じ隔離DBを再検証する場合は `--verify-existing <directory>` を指定できる。
同じlocal D1のHTTP検証と別CLI proxy起動は直列で実行する（この環境では並行起動時にMiniflare内部エラーを観測し、直列再実行で成功）。

今回の主なartifact（Git管理外）:

- `.cache/upstream-categories.json` / `.cache/inspection.json`
- `.cache/all-categories-sync.json` / `.cache/all-categories-verification.json`
- `.cache/all-categories-phase2-comparison.json` / `.cache/all-categories-comparison.json`
- `.cache/all-categories-golden.json` / `.cache/all-categories-plans.json` / `.cache/api-all-categories.json`
- `.cache/all-categories-fresh-comparison.json` / `.cache/all-categories-remote-baseline-comparison.json`
- `.cache/release-verify-report.json`

## 次に改善すべき点・production反映前の確認

1. **上流spec coverage**: Monitorはrefresh rateが3,545/3,867と充実している一方、Mouseのweightは88/4,466、Headphonesのweightは32/3,096、Keyboardのpolling rateは107/4,214。typed filterは未知値を除外するため、coverageと上流データ改善を優先する。
2. **共通情報中心のカテゴリ**: NetworkCard/Laptop/PrebuiltDesktop/ThermalCompound等は有用な構造化Schemaが追加された時点でfield/migrationをreviewする。name解析による補完は行わない。
3. **将来のintent**: Monitorの解像度・Hz等は有用だが、基本検索/typed filterの実測後に独立したGolden suiteで追加する。既存120 expectedは維持する。
4. **新カテゴリ追加手順**: inventoryを確認→上流Schema確認→registryのモデル/normalizer/facet追加→新しいforward migrationとgenerator検査対象追加→table-driven test/全snapshot検証。production適用済みの0002/0007を再生成して変更しない。
5. **production migration**: remoteに適用済みの0001〜0006と現在のsnapshot/local enrichmentを確認し、review済み0007を適用する。既存product ID/rawを再構築しない。
6. **初回同期予算とresume**: 追加18,535件は既定10,000件/runを超える。固定pinで予算をreviewするか、同じpinでpartialから再開する。local `rows_written` をremoteの実費と同一視しない。completeになるまでdeploy gateを維持する。
7. **実環境gate**: productionでは新spec INDEXの実行計画、D1 read/write/容量、全30カテゴリ件数、両FTS projection、120 Golden、localデータ保護を再測定する。sync完了〜新Worker反映までの旧APIとの切替手順も確認する。
8. **cache/API**: FTS generation 7のepochで反映し、30カテゴリ一覧、既存GET/POST本文、追加include、cache HIT、既存rate limiter bindingを実環境で確認する。

上流データの出典・ライセンスは既存のBuildCores OpenDB / ODC-By 1.0表記とNOTICEに従う。
