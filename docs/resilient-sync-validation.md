# Resilient BuildCores sync 検証報告

実施日: 2026-10-24。判定契約・閾値・復旧手順は[設計と運用](resilient-sync.md)。
本番D1書き込み、リモートmigration、Actions手動起動、本番再Sync、Workerデプロイは実施していない。

## 判定と保証

- 上流Schemaは診断。Catalog入力契約を満たす任意項目は保存し、不正な任意値はnull/不明。
- 名前・基本構造等の不備は製品隔離。存在一覧にある既存製品は検証済み旧版を保持、新規は非公開。
- 同一性の曖昧さ、カテゴリ消失、件数・主要項目・識別子の大幅劣化はカテゴリ保留。
- 削除は完全Git存在一覧と固定計画から判断し、acceptedの欠落を削除とみなさない。
- 入力、正常基準、隔離・保留・削除、公表予定データを製品書き込み前のmanifestに固定。
  同期・再開・source/Filter/検索/HTTP検証が共有する。内部例外・DB障害・ロック喪失は失敗。
- 永続キー/数値ID、ローカル識別子・補完、行単位原子性、予算・削除保護を維持。
  公開テーブルへの段階的適用であり、partial期間の全カタログ原子的切替は保証しない。

## 実行

```sh
npm run check
node --max-old-space-size=8192 scripts/validate-upstream-history.js --output .cache/resilient-verified --commits 94ece095c351fbdb4e26d13f63a145bcffd820de,3ff68236937d6b08cb38369921cf053c95d3e4fc,e3e3ef0936cdbe2fce5121c9421efe48e1de4387 --sync
node --max-old-space-size=6144 scripts/verify-application-plan-local.js --directory .cache/resilient-verified
git diff --check
```

通常の`npm run check`はネットワーク不要。schema生成照合と**336テストが成功**。
変更JavaScript 41ファイルの`node --check`も成功。
`git diff --check`成功。最新コードによる3コミットの入力hashは全て保存計画と一致し、
最終DBのreadiness・source integrity・query plan **45/45**も成功した。
最新同期コードでの完了再利用も製品書き込み0。
環境はNode v24.16.0 / Windows / Node SQLite。最終照合プロセスのpeak RSSは約3,679 MiB。
履歴取得には専用`.cache/resilient-source`を使用し、既存`.cache/upstream`は変更していない。

固定基準は`992dacfa9f516a5251fb01b70c9894bb23ad69d4`の48,288件。
元rawから旧正規化器v1を用いてローカルSQLiteへ作成し、独立したGit基準と照合して移行した。

## 全件同期結果

|commit|存在/accepted/公開|隔離|retained|保留カテゴリ|追加|更新|非active化|適用回数|
|---|---:|---:|---:|---:|---:|---:|---:|---:|
|`94ece095…`|48,421|0|0|0|142|48,279|9|5|
|`3ff68236…`|48,444|0|0|0|27|930|4|1|
|`e3e3ef09…`|48,534|0|0|0|90|976|0|1|

全3コミットでsource integrity、FTS integrity、30カテゴリのFilter検証が成功。
検索評価は各236/236ケースを実行し、正しさの失敗0・除外0。
各完了後の同一計画再実行は同じsyncを再利用し、製品書き込み0。
最初の移行は製品上限10,000で4回partial、5回目complete。
全5回のplan_hashは同一で、全更新が終わるまで削除は行われなかった。
最終DBは48,534 active + 13 inactive（旧世代1が9件、世代2が4件）。
数値IDのhigh-waterと最大IDはともに48,547。
active行の実際の出典commitは94ece095が46,622件、3ff68236が846件、e3e3ef09が1,066件で、
内容不変行の出典を最新commitへ付け替えていない。

### 診断（件数はイベント数であり製品数ではない）

|診断|94ece095|3ff68236|e3e3ef09|
|---|---:|---:|---:|
|Schema enum|7|0|0|
|Schema required|0|96|96|
|不正任意値|14,052|14,055|13,847|
|不正識別子要素|595|595|597|
|不正配列要素|43|43|43|
|未使用追加フィールド|240,073|241,320|243,598|
|不明スペック（通常の欠落を含む）|95,413|95,422|95,221|

`94ece095`のenum違反はMouse.shape 5件、Headphones.connection_types 2件。
型として安全な自由文字列を保持できた。
後2コミットのrequired違反96件はMonitor。screen_size不明は基準にも96件あり、
同一キー比較での新たな主要項目喪失は0。全体の約2.5%の通常欠損を、カテゴリ障害と誤認しなかった。
不正任意値には従来もnullになっていた空文字等を含み、上の件数を新規品質喪失として加算しない。
全3コミットは`complete + quality.status=warnings`。

### カテゴリ別accepted/公開件数

全カテゴリで隔離・retained・保留は0。詳細な取得率・識別子数・喪失率はsummaryの`categories`に保存。

|category|94ece095|3ff68236|e3e3ef09|
|---|---:|---:|---:|
|cpu|789|789|789|
|memory|4,876|4,876|4,876|
|motherboard|3,701|3,701|3,701|
|gpu|3,863|3,865|3,865|
|storage|3,495|3,499|3,505|
|psu|3,297|3,300|3,301|
|case|3,799|3,804|3,804|
|case_fan|3,496|3,500|3,509|
|cpu_cooler|2,414|2,413|2,421|
|accessory|320|320|339|
|capture_card|32|32|32|
|chair|319|320|333|
|desk|360|361|364|
|headphones|3,116|3,116|3,117|
|keyboard|4,219|4,222|4,222|
|laptop|118|118|118|
|lighting|26|26|28|
|microphone|115|115|118|
|monitor|3,881|3,881|3,896|
|mouse|4,473|4,473|4,474|
|mousepad|131|131|131|
|network_card|178|178|178|
|os|11|11|11|
|prebuilt_desktop|200|200|200|
|sound_card|84|84|84|
|speaker|573|573|573|
|stand|10|11|17|
|thermal_compound|227|227|229|
|vr_headset|4|4|4|
|webcam|294|294|295|

## 回帰検証と検証中の修正

`test/resilient-sync.test.js`の16テストは、正常更新・既存/新規隔離・実削除の混在、
旧版保持・inactive再出現・正常復帰、カテゴリ保留と他カテゴリ更新、未知enum/型/識別子形式、
JSON不備/完全Git一覧/Schema変更、基準改変・計画喪失・改ざん・superseded、
DB応答喪失・ロック喪失・予算partial・再開、旧世代基準、診断上限・評価除外上限を含む。
初回CPU/RAM保留時も、実Worker fetch handlerの契約・Filter・cache・paginationを
合成SQLite fixture上で確認した（本番HTTP性能測定ではない）。

検証中に修正した問題:

- `localeCompare`がゼロ幅文字入り識別子を同順位にしていたため、digestの集合整列をbinary順へ変更。
- 前manifestがある基準へ、古いGit baselineを再照合していた問題を修正。
- releaseYear上限追加により2製品の出力が変わったため、古い`.cache/resilient-final`の結果を
  最終証跡に流用せず、`.cache/resilient-verified`へ全件再適用した。
- 容量積算/PCIe/socket/NFKC展開後の上限と、HTTPの初回保留カテゴリ参照を修正。
- 同一millisecondのrunをランダムUUID順で誤選択する競合を修正。ロック下で開始時刻を単調増加させる。

## 証跡

- `.cache/resilient-verified/summary.json`: 全件同期、カテゴリ品質、各適用回、Filter/FTS/source/検索。
- 同ディレクトリの`<commit>/inspection.json`、`search.json`: 件数・制限付き診断と全検索評価。
- `current-code-verification.json`: 最新コードの3入力hash照合、no-change再同期、readiness、source integrity、query plans。
- `.cache/application-plans/<hash>.json`: 固定計画。非圧縮198,764,099 / 198,973,245 / 199,516,849 bytes。
- `.cache/resilient-verified/catalog.sqlite`: 最終ローカルDB。

保存計画hash（再実行時は基準sync ID・作成時刻により変わる）:

```text
94ece095: 014a0ce7774d551271a8f01cf0af71635409e5d0dfd90eb28069e2a939f3c7a8
3ff68236: 93dc3924aaac8e3f4586e1128e564406335ad3398d7ebf3462e86c309f268757
e3e3ef09: 96ca3d105b9c4fa1f106ca043b54dae0c0666b012b2150d91d423f48a13cbf3d
```

## Migration・D1影響・本番手順

`0011_sync_manifest.sql`は`sync_runs.plan_hash`と`base_sync_id`の2列だけを追加する。
既存migrationは変更していない。入力契約1、正規化器2への移行で正常基準48,288件のhashが変わる。
消失9件を除く48,279件を更新し、追加142件とともに再正規化した。保持対象は旧世代・旧出典のまま扱える。

ローカルSQLite changesの合計は各1,675,434 / 37,119 / 40,915。
これは**本番D1 rows_writtenではない**。検索レポートも`performance=not_measured_on_D1`であり、
各506件のコストメタデータ不足を明記している。性能gate合格とは主張しない。
計画/再開/完了照合の全件paged readが増える一方、公開APIの品質確認用D1 readは増えない。
保持行への書き込みもない。manifest本体はD1へ入れず、ローカル/Actions artifactに保存する。

本番適用は、writer停止確認 → 0011を別途適用 → 正常基準Git/前manifestを確保 →
pin/plan artifact保存 → 同一計画で同期を再開 → complete後の全release gate → deploy/HTTP検証の順。
製品上限10,000・書き込み予算2,000,000は維持。世代移行は製品上限だけで最低5回に分かれる。
partial/failedはdeploy不可。計画喪失時は部分DBから作り直さず、同じartifactを復元する。

未測定・未実施: 本番D1課金量/性能、リモートmigration、Actions artifact往復・前run download、
実workerdでの今回の全件release実行、本番Worker HTTP smoke、Worker deploy。
今回変更した補助Workerd計測CLIは構文確認済みだが、各CLIの全件実行はしていない。

## 変更ファイル

|目的|ファイル|
|---|---|
|入力・診断|`src/input-contract.js`, `src/diagnostics.js`, `src/upstream.js`|
|正規化世代|`src/normalize.js`, `src/normalizers/legacy.js`, `src/model.js`, `src/extended-models.js`|
|固定計画・同期|`src/application-plan.js`, `src/sync.js`, `src/cli.js`, `migrations/0011_sync_manifest.sql`|
|品質と公開集合|`src/quality/ingestion.js`, `src/quality/publication-cases.js`, `src/quality/catalog.js`, `src/quality/integrity.js`|
|release/CI|`scripts/catalog-release.js`, `scripts/lib/release-gates.js`, `scripts/lib/production-smoke.js`, `.github/workflows/sync.yml`, `.github/workflows/ci.yml`|
|全件再現|`scripts/validate-upstream-history.js`, `scripts/verify-application-plan-local.js`|
|補助検証|`scripts/verify-all-categories.js`, `scripts/verify-cross-snapshot.js`, `scripts/verify-filters.js`, `scripts/verify-fts-fresh.js`, `scripts/verify-search-local.js`, `scripts/verify-ux-api-local.js`|
|診断・計測|`scripts/analyze-search-failures.js`, `scripts/benchmark-ux.js`, `scripts/lib/case-diagnostics.js`, `scripts/measure-product-detail.js`, `scripts/measure-sync-cost.js`|
|新規回帰/adapter|`test/resilient-sync.test.js`, `test-support/database.js`, `test-support/historical-sync.js`|
|既存テスト適合|`test/all-categories.test.js`, `test/catalog.test.js`, `test/category-fts.test.js`, `test/product-detail.test.js`, `test/release.test.js`, `test/search.test.js`, `test/spec-search.test.js`, `test/ux-source-growth.test.js`|
|文書|`README.md`, `docs/design.md`, `docs/catalog-release.md`, `docs/resilient-sync.md`, `docs/resilient-sync-validation.md`|

既存テストの変更には、過去migration検証adapterの分離と、合成fixtureの不正UPC桁数修正を含む。
変更は未コミット。push/PR作成は行っていない。
