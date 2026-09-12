# PC Parts Catalog

[BuildCores OpenDB](https://github.com/buildcores/buildcores-open-db) を取得・検証・正規化し、
**Cloudflare D1 に自前のPCパーツ製品カタログを構築・差分更新するプロジェクト**です。

```text
BuildCores OpenDB（Git commit固定）
  → 上流JSON Schemaで全件検証
  → 検索用の基本情報・型付きスペック・identifierへ正規化
  → Cloudflare D1（Wranglerローカル / リモート）
```

検索CLI、SQL、INDEX検証を含みます。将来の別プロジェクトのAPIから、このD1を参照できます。

## クイックスタート

必要環境: **Node.js 24.x、npm、Git**。ローカル実行にはCloudflareアカウントは不要です。
コマンドはリポジトリルートで実行してください。

```sh
npm ci
npm run upstream:fetch
npm run upstream:inspect
npm run db:migrate
npm run sync
npm run stats
npm run verify:plans
```

- 取得先: `.cache/upstream/`。9カテゴリの製品とSchemaをsparse checkoutします。
- ローカルD1: `.wrangler/state/v3/d1/`。Wranglerと検索・同期CLIは同じDBを使います。
- 初回は約3万JSONの取得とインポートのため数分かかります。
- `sync` は取得済みのcommitを使用します。最新取得は `upstream:fetch` を明示的に実行します。
- `.cache/`、`.wrangler/`、データ本体、認証情報はGit管理対象外です。

同じ検証データを再現する場合:

```sh
npm run upstream:fetch -- --ref eec0df175504ebd15f0f3e3a8249a18a22f00940
```

既に取得したクリーンなBuildCores checkoutも `--repo <path>` で指定できます。
checkoutのoriginは `https://github.com/buildcores/buildcores-open-db.git` を使用してください。

## 実データでの検証結果

2026-09-12、上記commit、Node.js 24.16.0 / Wrangler 4.131.1、WindowsのローカルD1で確認済みです。

|上流カテゴリ|DBカテゴリ|表示名|製品件数|
|---|---|---|---:|
|CPU|`cpu`|CPU|789|
|RAM|`memory`|MEM|4,838|
|Motherboard|`motherboard`|M/B|3,701|
|GPU|`gpu`|GPU|3,837|
|Storage|`storage`|Storage|3,495|
|PSU|`psu`|PSU|3,297|
|PCCase|`case`|Case|3,778|
|CaseFan|`case_fan`|Case Fan|3,460|
|CPUCooler|`cpu_cooler`|CPU Cooler|2,404|
|**合計**|||**29,599**|

- 全件が取得commitの実際のJSON Schemaによる検証を通過。
- raw JSON・FTS・INDEX込みで **約131MB（約125MiB）**。D1 Freeの500MB/DB以内。
- `PRAGMA foreign_key_check`: エラー0件。
- 必須7パターンを含む **12パターン**の検索で期待するINDEX利用を確認。
- 再同期: 追加・更新・削除0件、変更なし29,599件。
- 実際の途中中断後、保存済み16,125件を再書込せず、残り13,474件を追加して完了。
- 自動テストでは独自identifier/補完データの保護、更新・削除・再出現、原子的ロールバック、
  再開、競合排除、数値境界、FTS、入力検証を確認。

詳細は [調査・設計](docs/design.md)、[INDEX検証](docs/query-plans.md) を参照してください。
リモートD1への書込とGitHub Actionsの本番実行には、後述のアカウント設定が必要です。

## 製品検索

### カテゴリ別一覧・キーワード・MPN

以下はPowerShellでもBashでもそのまま実行できます。

```sh
npm run search -- --category cpu --limit 10
npm run search -- --category cpu --keyword 285K
npm run search -- --category cpu --keyword 9800X3D
npm run search -- --category gpu --keyword "RTX 5080"
npm run search -- --category storage --keyword SN850X
npm run search -- --category psu --keyword RM1000x
npm run search -- --category cpu --identifier-type mpn --identifier BX80768285K
```

キーワードはFTS5の**AND検索を基本としたrelevance順**です。
NFKC正規化を維持し、`990pro` / `990 pro`、`rtx5080` / `rtx 5080`、`sn850x` / `sn 850x` 等は、
型番らしい英数字に限定して検索時に表記を展開します。一般の自然言語の空白は除去しません。
manufacturer/name/series/variant、CPU分類・GPUチップ名、上流identifierを検索します。
独自identifierにも別のFTSがあり、追加直後からidentifier単体のキーワード検索が可能です。
全文書の任意位置に対する部分文字列検索や、日本語形態素解析は行いません。
local identifierの語と製品名の語を跨ぐ複数語検索は、別FTS文書のため一致しません。

製品名の完全一致・型番/phraseの完全なtoken一致・フィールド別の一致を優先し、
column-weight付き`bm25()`と製品IDで順位を安定化します。`14900K`は`14900KF/KS`より上位になります。
identifierの強いboostは形状と共有製品数の条件を満たす場合だけです。`OC`、`16`等は最優先にしません。
`7`等の1桁数字は前方一致ではなく単語一致です。
strict結果が**0件の場合だけ**、十分な残り語と型番があれば、モデル数字に隣接しない孤立した1文字英字を
1つ落としてAND検索します（例: `gaming x trio 5080`）。既存strict結果にfallbackを混ぜません。

```sh
# 既存DBも検索専用FTSを保存済みデータから再構築。upstream再取得・再同期は不要。
npm run db:migrate
npm run search -- --category cpu --keyword 14900k --verbose
npm run search -- --category gpu --keyword "gaming x trio 5080" --verbose
```

`--verbose`（内部オプション`debug: true`）で`search_score`、`search_match`、`search_fts_relevance`を表示します。
詳細な条件・ランキング・制限は [検索仕様](docs/search-relevance.md)、同じGolden Queryでの比較は
[Phase 1測定結果](docs/search-quality-phase1.md) を参照してください。

完全一致検索は `identifierKey()` によるNFKC・前後trim・ASCII大文字化を使用します。
**先頭0、ハイフン、内部空白を保持**し、EAN/UPCを数値へ変換しません。
`--identifier-type` を省略すると種別を跨いで検索します。JANは `jan` を指定できます。

### 複数選択・数値レンジ

PowerShell 5.1のJSON引数の引用符問題を避けるため、JSONファイルを使えます。

```sh
npm run search -- --query-file examples/cpu-search.json
npm run search -- --query-file examples/gpu-search.json
npm run search -- --query-file examples/memory-search.json
npm run search -- --query-file examples/gpu-search.json --explain
```

検索ファイルの例:

```json
{
  "category": "gpu",
  "keyword": "RTX 5080",
  "filters": {
    "chip_vendor": ["NVIDIA"],
    "manufacturer": ["MSI", "ASUS"],
    "chip_series": ["GeForce RTX 50"]
  },
  "ranges": {
    "length_mm": { "min": 250, "max": 320 },
    "vram_gb": { "min": 16 },
    "tdp_w": { "max": 400 }
  },
  "orderBy": "length_mm",
  "limit": 20
}
```

- 同じフィールド内の選択値はOR、別フィールド間はAND。
- `min` のみ / `max` のみ / 両方に対応。境界値を含み、NULLはレンジ検索に一致しません。
- GPUの `manufacturer` はボードメーカー、`chip_vendor` はNVIDIA/AMD/Intel。
- CPUの `family` は `Core i7` / `Ryzen 7` / `Core Ultra 9` 等、`generation` は `14000` / `9000` / `200` 等の文字列。
- `series` は製品のmetadata由来、GPUの `chip_series` はチップ世代。用途を分けて保持します。
  実データのseries表記はSchemaの命名例と一致しないこともあるため、選択肢はDBの実値から取得してください。
  例えば今回のSN850Xには `series='WD_Black'` の製品があります。
- XMP/EXPOは `xmp: [1]` / `expo: [1]`。空の上流タグ配列は0、省略/nullはNULL。
  0は「タグの報告なし」であり、独自検証済みの非対応判定ではありません。
- `orderBy` は許可済みの列のみ、limitは1～100。末尾に製品IDを付けた安定順です。
  キーワード指定時の既定はrelevance順ですが、明示した`orderBy` / `--order`はその列の昇順を優先します。
- Bashでは `--filters '{"socket":["AM5"]}'`、`--ranges '{"tdp_w":{"min":65,"max":125}}'` の直接指定も可能です。

主要レンジ検索列:

|カテゴリ|選択・フィルタ列の例|数値レンジ列の例|
|---|---|---|
|cpu|manufacturer, family, generation, socket|core_count, tdp_w, ppt_w, boost_clock_ghz|
|memory|manufacturer, ram_type, kit_quantity, xmp, expo|capacity_gb, speed, cas_latency, height_mm|
|motherboard|socket, chipset, form_factor, ram_type|max_memory_gb, memory_slots|
|gpu|chip_vendor, chip_series, manufacturer, memory_type|vram_gb, length_mm, tdp_w, boost_clock_mhz|
|storage|storage_type, form_factor, nvme|capacity_gb, pcie_generation|
|psu|form_factor, efficiency_rating, modular|wattage, length_mm|
|case|form_factor|max_gpu_length_mm, max_cpu_cooler_height_mm, max_psu_length_mm|
|case_fan|size_mm, pwm, flow_direction|airflow_max_cfm, noise_max_db|
|cpu_cooler|water_cooled, radiator_size_mm|height_mm, noise_max_db|

全列は `src/model.js` と `migrations/` にあります。CPUクロックはGHz、GPUクロックはMHz、
寸法はmm、容量はGB、消費電力はWです。RAM speedは上流の6000等の値をそのまま使用します。
ファン/クーラーの定数airflow/noiseは、上流Schemaの指示に従いmin値をmax検索列にも保持します。

多値の互換性情報は、検索JSONの `facets` で指定できます。

```json
{
  "category": "cpu_cooler",
  "filters": { "water_cooled": [0] },
  "ranges": { "height_mm": { "max": 160 } },
  "facets": { "socket": ["AM5"] },
  "orderBy": "height_mm"
}
```

その他のfacetはCPUの `memory_type`、Caseの `motherboard_form_factor` / `psu_form_factor`。
これらは互換性判定の材料です。BIOS、レーン共有、設置位置、ケーブルやラジエータ干渉まで判定するものではありません。
上流の欠損や空配列を「互換性確認済み」として扱わないでください。

### SQLを直接使う

```sh
npx wrangler d1 execute DB --local --command "SELECT category,count(*) AS count FROM products WHERE active=1 GROUP BY category;"
npx wrangler d1 execute DB --local --file examples/queries.sql
```

`examples/queries.sql` に、series/manufacturer/socket、7必須条件、FTS＋数値、型付きBETWEEN、
identifier全カテゴリ検索を用意しています。別プロジェクトのAPIからは `searchQuery()` のSQLとparamsを
D1の `prepare(sql).bind(...params)` に渡す設計も利用できます。

## 同期の仕様

```sh
npm run upstream:fetch
npm run sync -- --dry-run
npm run sync
```

1. 1つのcommitに固定された全9カテゴリを検証。ファイル名/UUID、取得漏れ、上流Schema違反を確認。
2. raw JSONの意味内容＋カテゴリ＋normalizer versionのSHA-256と、D1のhashを比較。
3. 新規・更新・再出現のみUPSERT。変更なしの製品/スペック/identifier/FTSは書き換えない。
4. すべての変更製品の反映完了後に、上流から消えた製品を `active=0` にする。
5. `sync_runs` にcommit、状態、件数、メトリクスを記録。

**独自データは保持されます。** `local_identifiers` と `local_enrichments` は同期処理の書込対象に含まれません。
上流削除でも製品行を物理削除しないため、独自データの外部キーが壊れません。
同じ同期キーが再出現した場合は同じ内部製品IDを再利用します。

1製品の全テーブル更新は、`ingest` へのINSERTとtriggerによる**単一SQLの原子的更新**です。
最大25製品を1つのパラメータにまとめ、1.8MB未満に分割します。
全カタログの更新中には新旧製品が混在します。`sync_runs.status='complete'` がスナップショット反映完了の目印です。

### 再開・削除・競合

- `--max-products 1000` 等で途中停止可能。上限到達は `partial` として正常終了し、レポートに残件数を出します。
- 中断・API失敗後は同じcommitで再実行。応答を失った書込も、D1に実際に残ったhashから判定します。
- 15分のDB leaseを定期更新して同期writerを1つに制限します。プロセス強制終了後はlease期限後に再開できます。
  回収時に前回の未終了runをfailedに記録します。
- カテゴリごとに既存active件数の20%を超える削除は停止します。
  上流の実際の変更を確認した場合に限り `--max-delete-fraction 0.5` 等を明示できます。
- 取得/検証に失敗した場合、削除判定も製品更新も実行しません。
- カテゴリ間でUUIDが重複する実データがあるため、同期キーは **`<上流カテゴリ>/<UUID>`**。
  上流UUIDは別列にそのまま保持します。カテゴリ移動は別製品の追加＋旧製品の論理削除となり、
  独自データを自動移管しません。詳細と確認した実例は `docs/design.md` を参照してください。

### 自前データの追加

`src/enrichment.js` に、根拠と検証日時を持つ追加/更新ヘルパーを用意しています。
Nodeの管理スクリプトから使用する例:

```js
import { openDatabase } from './src/database.js';
import { addLocalIdentifier, setLocalEnrichment } from './src/enrichment.js';

const db = await openDatabase(false); // trueなら設定済みリモート
try {
  // 実在する製品ID、実際に確認したJAN、確認根拠を指定する
  await addLocalIdentifier(db, {
    productId, type: 'jan', value: verifiedJan, region: 'jp',
    evidence: evidenceUrl, verifiedAt: new Date().toISOString()
  });
  await setLocalEnrichment(db, {
    productId, namespace: 'spec', key: 'height_mm', value: measuredHeight,
    evidence: evidenceUrl, verifiedAt: new Date().toISOString()
  });
} finally { await db.close(); }
```

`identifiers` viewには `origin='upstream'|'local'`、region、根拠、検証日時が含まれます。
上流側はcanonical snapshotとmetadata.part_numbersを `origin_field` で区別するため、
同じMPNが双方に現れる場合があります。検索はINで製品を重複排除します。
MPNそのものに全製品を跨ぐUNIQUE制約は設けません。

補完スペックは上流の検索列を自動変更しません。将来のAPIで優先順位を決め、必要なら採用済みの補完値を
別の型付き検索projectionへ反映してください。上流値と独自の確認値を混ぜないための分離です。

## Cloudflare D1リモート設定

### DB作成

```sh
npx wrangler login
npx wrangler d1 create pc-parts-catalog --update-config=false
```

出力されたdatabase UUIDとCloudflareのaccount IDを控え、対象アカウントのD1編集権限を持つAPI Tokenを作成します。
`wrangler.json` のUUIDはローカル用です。リモート用configは環境変数から `.cache/wrangler.remote.json` に生成します。

PowerShell:

```powershell
$env:CLOUDFLARE_ACCOUNT_ID = "<account-id>"
$env:CLOUDFLARE_D1_DATABASE_ID = "<database-uuid>"
$env:CLOUDFLARE_API_TOKEN = "<api-token>"

npm run db:migrate -- --remote
npm run sync -- --remote --dry-run
npm run sync -- --remote
```

Bashでは `export CLOUDFLARE_ACCOUNT_ID=...` の形式で同じ3変数を設定してください。
CLIは環境変数を読みます。`.env` ファイルの自動読込は行いません。
認証情報はcommitしないでください。ログにTokenを出力する処理はありません。

`search`、`stats`、`verify:plans` も `--remote` に対応しています。
遠隔同期はD1 REST APIを使用し、migration/DB作成/ローカルD1管理にはWranglerを使用します。

### D1 Freeの初回インポート

[公式Limits](https://developers.cloudflare.com/d1/platform/limits/) / [Pricing](https://developers.cloudflare.com/d1/platform/pricing/)（2026-09-12確認）:

- 500MB/DB、5GB/アカウント。
- 読取500万行/日、書込10万行/日。INDEXへの書込も加算。
- 日次上限は00:00 UTCでリセット。

**容量はFreeに収まりますが、全量の初回インポートを1日の無料書込枠で完了する想定ではありません。**
raw/identifier/facet/FTS/INDEXを含むため、初回は複数日に分けます。

遠隔同期のデフォルトは **最大1,000製品、1 runあたり書込80,000行予算**。
実際の `meta.rows_written` を監視し、次バッチの余裕を残して停止します。
この予算は次バッチの実費を厳密に事前確定するものではなく、他クライアントやmigrationの使用量も含みません。
同日に何度も実行すると日次上限に達するので、Dashboardの残予算を確認してください。
上限エラーになっても、翌日同commitで再実行して再開できます。

```sh
# 同じcommitのcheckoutを保持して、翌UTC日に残りを続行
npm run sync -- --remote --max-products 1000 --write-budget 80000
```

ローカル同期には件数・書込予算のデフォルト上限を設けません。
ローカルD1のメトリクスはリモート課金量の保証ではありません。週次同期の費用も実際の差分量によります。
sync reportのrows_read/writtenは状態比較と取込処理の観測値で、最後のrun終了記録/lease解放、migrationは除きます。

## GitHub Actions

リポジトリへpushし、Settings → Secrets and variables → Actions に設定します。

|種別|名前|値|
|---|---|---|
|Secret|`CLOUDFLARE_ACCOUNT_ID`|アカウントID|
|Secret|`CLOUDFLARE_API_TOKEN`|対象アカウントのD1編集Token|
|Variable|`CLOUDFLARE_D1_DATABASE_ID`|作成済みD1のUUID|

`.github/workflows/sync.yml`:

- 毎週月曜日 **03:17 UTC（12:17 JST）**。
- `workflow_dispatch` 手動実行。commit/ref、件数上限、書込予算を指定可能。
- 上流全件検証 → migration → 差分同期。
- concurrencyで本番同期を直列化。実行中の同期を自動キャンセルしません。
- commit・件数・残件・状態はJob Summaryとartifactに保存。`partial` はインポート未完了です。
- 初回を進める際は、手動実行の `upstream_ref` に同じcommitを指定し、翌UTC日に再開します。

`.github/workflows/ci.yml` はpush/PR時にテスト、ローカルmigration、調査commitの全件取込、INDEX検証を実行します。
このCIにCloudflare認証情報は不要です。

## 検証・運用資料

```sh
npm run check
npm run verify:plans
npm run stats
```

|生成ファイル|内容|
|---|---|
|`.cache/inspection.json`|commit、件数、全検索列の欠損率を計算できる件数、サンプル、検証エラー、カテゴリ間UUID重複|
|`.cache/query-plans.json`|SQL、bound params、EXPLAIN、戻り件数、D1メトリクス|
|`.cache/sync-report.json`|最後の同期結果（DBのsync_runsにも保存）|
|`.cache/stats.json`|カテゴリ件数、identifier件数、DB容量、FK検証|
|`.cache/notices/<commit>/`|上流README・LICENSE.txtの原文コピー|

`0002_specs_ingest.sql` は `scripts/generate-schema.js` から生成した初期migrationです。
`npm run schema:check` が定義との一致を検証します。将来の変更は既存migrationを書き換えず、
新しいmigrationを追加してください。正規化規則変更時は `NORMALIZER_VERSION` を上げて再同期します。
現在の初期INDEXからの実測に基づく調整は `0003_query_plan_tuning.sql` にあります。
`0004_search_relevance.sql`は検索専用FTS列の追加と既存DBの再構築です。
カタログ正規化規則の変更ではないため、`NORMALIZER_VERSION`は1のままで再同期も不要です。

## Catalog quality audit

現在のDBに対する完全性・重複候補・検索品質の読み取り専用監査です。
上流の再取得は不要で、既存の `openDatabase()` / `db.query()` を使います。
初回の実測は [docs/catalog-quality-baseline.md](docs/catalog-quality-baseline.md) にまとめています。

```sh
npm run audit:completeness
npm run audit:duplicates
npm run benchmark:search
```

### 完全性（completeness）

```sh
npm run audit:completeness -- --category gpu --field length_mm --by-manufacturer
npm run audit:completeness -- --category gpu --manufacturer ASUS
npm run audit:completeness -- --category cpu --year-from 2024 --year-to 2026
npm run audit:completeness -- --category storage --unknown-year
npm run audit:completeness -- --include-inactive
```

- カテゴリ・スペック列は `src/model.js`、共通製品列はDBの `PRAGMA table_info(products)` から取得。
  内部ID・同期管理列を除く共通列を監査し、監査用の別モデル定義は持ちません。
- `total_products` / `active_products` は指定したカテゴリ・メーカー・期間内の件数。
  フィールドの標準母数はその中の**active製品数**です。`--include-inactive` で全製品を母数にできます。
- 各フィールドに `total` / `present` / `missing` / `coverage` / `missing_rate` を出力。
  JSONの率は0～1、母数0は `null`（人間向け表示はN/A）です。
- NULL・空文字・空白だけの文字列を欠損扱いにします。**0やfalseは存在する値**です。
  `None` / `Unknown` の文字列もそのまま存在する値として数えます。
- 共通列とスペック列は `product.manufacturer` / `spec.manufacturer` のように区別します。
  `--field length_mm` と `--field spec.length_mm` の両方を利用できます。
  カテゴリ指定なしのfield指定では、そのフィールドが存在するカテゴリだけを集計します。
- identifierは `identifiers` viewのupstream/local両方を対象に、種類別の**保有製品数**を数えます。
  同じ製品の複数MPN、地域違い、canonical/metadataの重複行は保有率を水増ししません。
  種別は既存のlocal identifier CHECK制約とDBの実在種別から取得します。
  EAN/UPCをGTIN/JANへ自動的に読み替えないため、`jan=0` は「JAN種別での登録が0」の意味です。
- 年の上下限は包含条件です。期間指定時にrelease_year不明の製品は含めません。
  `--unknown-year` で別途調べられます（期間指定との併用は不可）。メーカーは既存のメーカー正規化を再利用して照合します。

充足率は**値の存在率**で、仕様の正しさ・適用対象・独自検証済み率ではありません。
例えば空冷のradiator_size、バリエーションのない製品のvariant欠損は必ずしも不良データではありません。
恣意的な「critical fields総合点」は作らず、フィールド別とidentifierの客観的な件数を優先します。

### 重複候補（duplicates）

```sh
npm run audit:duplicates -- --category gpu --manufacturer ASUS
npm run audit:duplicates -- --limit 5
npm run audit:duplicates -- --verbose
```

- MPNは **メーカー＋`identifierKey(value)`**、他の種別は **type＋`identifierKey(value)`** でグループ化。
  既存正規化と同様、先頭0・ハイフン・内部空白を保持します。
- 2つ以上の異なるproduct IDが共有する場合に `IDENTIFIER_CONFLICT` として出します。
  regionはグループを分割せず、値・region・origin・origin_fieldを確認根拠として残します。
  メーカー不明のMPNグループには `manufacturer_missing` を付けます。
- 名称候補はカテゴリ＋正規化メーカー＋名称のNFKC/空白整理/小文字化で比較。
  identifierがない製品も含み、`POSSIBLE_DUPLICATE_NAME` として出力します。
  同名でも異なるキット・地域・仕様の可能性があり、重複確定とは扱いません。
- `identifier_key_mismatch_rows` は現在のraw valueから既存関数で算出したキーと保存キーの不一致件数。
- 完全性と同じメーカー・期間・active条件を指定可能です。
  `--limit` は人間向けに表示するグループ数だけを制限します（既定10、各グループ5製品まで）。
  集計自体とJSONは常に全候補を含みます。`--verbose` は全候補・全製品を表示します。

### 検索ベンチマーク

```sh
npm run benchmark:search
npm run benchmark:search -- --category cpu --verbose
npm run benchmark:search -- --fixture test/fixtures/search-benchmark.json
```

Golden Queryは `test/fixtures/search-benchmark.json` の40ケースです。
実DBで製品とidentifierを確認し、期待値を検索結果の順位から自動生成しない方針で作成しました。
広いシリーズ検索では、確認した許容製品のID集合のどれかが最初に出た順位を評価します。
名前完全一致だけへの依存を避け、ID、identifier、MPN、名称条件に対応します。

検索は**現在の `searchQuery()` が生成するSQLそのもの**を使用します。
100件単位で読み、必要な場合だけそのSQLに `OFFSET ?` を付けて続きを取得します。
既存クエリがD1の100-bind上限に達している場合は、内部で数えた整数OFFSETをSQLに直接付けます。
WHERE/FTS/ORDER BYは変更せず、期待製品が見つかるか検索結果を読み尽くすまで順位を調べます。
従って101位以降を誤って「検索一致なし」に分類しません。

|指標|定義|
|---|---|
|Hit@1 / Hit@5 / Hit@10|最初の許容製品が上位K件以内にある検索の割合|
|MRR|最初の許容製品の順位の逆数の平均。10位や100位で打ち切らない|
|zero_result_count|実際に実行した検索が0件だった数|
|query_count|指定範囲のfixtureケース数|
|scored_query_count|不正なfixtureを除いた採点母数。MISSING_PRODUCTは含み、0点とする|
|failed_query_count|上位10件に入らなかったケース数。不正fixtureも別分類で含む|

失敗分類:

- `MISSING_PRODUCT`: 期待する製品がカテゴリ内のDBに存在しない。許容集合なら全候補が不存在の場合。
- `NO_SEARCH_MATCH`: 製品は存在するが現在の検索条件に一致しない。
  inactive / スペック行欠落の場合はそれぞれ `INACTIVE_PRODUCT` / `MISSING_SPEC_ROW` を理由に記録。
  その他は現在のFTS・identifier・typed条件の組み合わせで非一致と報告し、原因を過剰に断定しません。
- `RANKING_FAILURE`: 一致するが11位以下。
- `EXPECTED_DATA_INVALID`: 形式不正、重複したcase ID、不明な検索条件、単一selectorで複数製品に一致するなど。

デフォルトは総合スコアと失敗ケースのquery・expected・rank・上位10件を表示します。
`--verbose` とJSONでは成功ケースも確認できます。`retrieved_count` は診断で実際に取得した件数で、
検索総ヒット数ではありません。`search_exhausted` とページ数も記録します。
DB/APIエラーは0件検索に変換せずコマンドを失敗させます。
低スコアは測定結果なので終了コード0、不正fixtureや実行エラーは1です。

### JSON出力・再現性

```sh
npm run --silent audit:completeness -- --json --output .cache/completeness.json
npm run --silent audit:duplicates -- --json --output .cache/duplicates.json
npm run --silent benchmark:search -- --json --output .cache/search-benchmark.json
```

`node src/cli.js <command> --json` も純粋なJSONをstdoutに出します。
npmのバナーを抑えて機械処理する場合は上記の `--silent` を付けてください。
`--output` はJSONをファイルにも保存します（親ディレクトリは事前に用意）。
`--json` なしで `--output` を使うと、コンソールは人間向け表示・ファイルはJSONになります。

共通形式は `schema_version: 1`、`kind`、`generated_at`、`catalog`、`scope`、`summary`。
詳細は完全性の `categories`、重複の `identifier_conflicts` / `possible_name_duplicates`、
ベンチマークの `results` / `by_category` に格納します。出典とODC-By通知も `catalog.sources` に含めます。

`catalog_sha256` は監査で読んだ製品行（内部ID・同期情報を含む）・型付きスペック・identifierの指紋です。
ベンチマークはfixtureファイルと `src/queries.js` のSHA-256、実行SQL/paramsも保存します。
同じ上流commitでも独自identifierや内部IDが違えば、別の測定対象として区別できます。
raw JSONの直接比較・外部公式サイトとの照合はこの監査に含めません。

測定中は同期・手動補完のwriterを停止してください。live sync leaseと測定前後のsync runを確認し、
同期を検知した場合は中断します。複数のD1クエリに跨がる全DBスナップショットトランザクションは取得しないため、
同期を通さない外部書込との同時実行は再現性を保証しません。
コマンドは全カタログをページ単位で読み込み、現行約3万製品をメモリ上で集計するため、通常の製品検索より読み取り量が多くなります。
既存接続の `--remote` にも対応しますが、baseline測定はローカルD1で確認しています。

### Golden Queryの追加

1. 現在DBの製品・identifierを確認し、検索意図と対応するSKUを決めます。
2. fixtureに一意な `id`、既存 `category`、`query`、`expected` を追加します。
3. `benchmark:search -- --verbose` で解決された製品と順位を確認します。
   不正/曖昧な期待値を検索実装の不具合として数えないでください。

```json
{
  "id": "cpu-285k-additional-example",
  "category": "cpu",
  "query": "intel 285k",
  "expected": { "upstream_id": "e2cf2532-8c57-4ec2-96fb-4aaa846c8ca6" }
}
```

`expected` は以下のいずれかを使用できます。

- `{ "upstream_id": "<UUID>" }` または `{ "upstream_key": "CPU/<UUID>" }`
- `{ "identifier": { "type": "mpn", "value": "BX80768285K", "region": "all" }, "manufacturer": "Intel" }`（regionは任意）
- `{ "mpn": "BX80768285K", "manufacturer": "Intel" }`
- `{ "nameContains": ["Core Ultra 9", "285K"], "manufacturer": "Intel" }`（NFKC/大小文字を無視したAND条件）
- `{ "upstream_ids": ["<UUID-1>", "<UUID-2>"] }`（許容集合）
- `{ "anyOf": [{ "upstream_id": "<UUID>" }, { "mpn": "<MPN>" }] }`（種類の異なるselectorの許容集合）

単一selectorが複数製品に一致したらinvalidです。必要なら `manufacturer` / `source` で絞るか、
`upstream_ids` / `anyOf` に確認済みの個別IDを列挙します。
許容集合の一部だけが消えた場合も `missing_targets` と `missing_expected_target_count` に残します。
rootに `search` を追加すると、既存検索の `filters` / `ranges` / `facets` / `identifier` / `orderBy` を併用できます。
`limit` とkeywordはベンチマーク側が管理します。名称/MPN条件をIDと同じselectorに混ぜて暗黙fallbackすることはありません。

オフラインの `npm test` は小さな合成DBで監査・指標・125位の検出・原因分類を検証します。
GitHub CIでは既存の実データ取込後に3つの監査を実行し、JSONをartifactに保存します。
40ケースは代表的なモデル検索のbaselineで、全カテゴリ・全製品の検索適合率を保証するものではありません。

## ライセンス・Attribution

データソースは **BuildCores OpenDB**:

- リポジトリ: https://github.com/buildcores/buildcores-open-db
- ライセンス: **Open Data Commons Attribution License (ODC-By) v1.0**
- ライセンス本文: https://opendatacommons.org/licenses/by/1-0/
- 上流ライセンスファイル: https://github.com/buildcores/buildcores-open-db/blob/main/LICENSE.txt

> Contains information from [BuildCores OpenDB](https://github.com/buildcores/buildcores-open-db),
> which is made available under the [ODC Attribution License](https://opendatacommons.org/licenses/by/1-0/).

BuildCores由来のデータをこのプロジェクトの独自収集データとは扱いません。
本プロジェクトで行う加工は、カテゴリ名・検索用分類・単位付き列・identifier索引への正規化です。
元の内容は `upstream_raw.raw_json` に意味内容を保ったコンパクトJSONとして保持します。

出典・ライセンスURI・AttributionはDBの `sources` にも保存しています。
派生DBを公開・再配布する場合はODC-By 1.0の条件で、ライセンス本文またはURIと既存の通知を保持してください。
DB exportでは `sources` を含め、CSV等の部分exportにも対応する出典・ライセンス通知を添付してください。
将来のAPIや見積もりサイトでも、ユーザーが確認できる場所に上記Attributionを表示してください。
`NOTICE.md` と取得物の上流ライセンス通知を併せて引き継いでください。

ODC-Byはデータベースに関するライセンスです。上流のライセンス本文は変更しません。
