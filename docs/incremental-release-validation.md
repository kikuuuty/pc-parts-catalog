# 差分snapshotのrelease検証・復旧

## 調査時点と修正前の再現

開始時HEAD: `4ecb66194cb42a8da4c4c073332fe98b53de7d6a`。作業ツリーはクリーン、AGENTS.mdなし。
GitHubで確認した同HEADの通常CI `35495676091` はsuccess、最新production release
`35497292055` はfailureでした。runログではsync
`82211efd-b17a-461b-981a-88803ec90cc9` がcomplete、active 48,223、FTS integrity成功、
`Source catalog integrity failed`で停止、Worker deploy未実行です。
これはrun時点の記録であり、以後の本番DB/Worker状態を推定するものではありません。

上流データcommit（このリポジトリのコードcommitとは別）:

- A: `eec0df175504ebd15f0f3e3a8249a18a22f00940`
- B: `07e5be1dad48b1913a90a1b6f34e702cce3c475a`

修正前に`node --test test/source-integrity.test.js`を実行し、Aの10製品からBで1製品だけ変更した
正常な同期が、unchanged 9製品の`product fields`不一致でFAILすることを再現しました。
同期された内容は正しく、旧検証が行更新履歴と最新snapshotを同一視していました。

## source_commitの責務

|Field|意味|
|---|---|
|`products.source_commit`|その行を最後に更新したupstream commit。unchanged行は古い値を保持|
|`sync_runs.source_commit`|カタログ全体として同期したsnapshot。releaseは最新completeとの一致を要求|

`verifySourceCatalog`はcanonical製品比較から**source_commitだけ**を除外します。
upstream_id/key、category、manufacturer/name/series/variant、release_year/URL、identity_version、
content_hash、normalization_versionおよび他のnormalized fieldは厳密比較します。
raw全文の等価性、typed specs、upstream identifiers/facetsの集合、missing/unexpected active製品も
引き続き検証します。content_hashが一致しても各比較は省略しません。
local identifiers/enrichmentは別責務で、source由来として比較・上書きしません。

関連経路を点検し、migration/projection fingerprintで行のsource_commitを保持する検証は残しました。
benchmarkやsmokeが確認するcompleted snapshot一致も維持します。hash、normalizer、sync planner、
unchanged行の一括更新、count guardの閾値変更は行っていません。

## 診断・phase・artifact

### Source integrity report（schema_version: 2）

保存先: `.cache/release-source-integrity.json`。独立ローカル検証ではその専用directory内。

- `snapshot_commit`、`sync`（id/source_commit/status/時刻/normalizer）
- `status` / `pass`
- `products`、`expected_products`、`products_checked`、`raw_checked`
- `mismatch_count`: field別不一致を含む総数（不一致製品数とは異なる）
- `by_kind`: product_field/specs/identifiers/facets/raw/missing_active/unexpected_active
- `product_fields`: name/content_hash/normalization_version等のfield別件数
- `details`: `{upstream_key, kind, field}`。既定50サンプル、設定上限200
- `errors`: 従来利用者向けの短い文字列サンプル。全件リストではない
- `omitted` / `truncated`: 省略詳細数とフラグ

全件を数え、`pass`は`mismatch_count`で決定します。sampleLimit=0でも不一致はFAILです。
expected/actual値やraw全文、SQL、provider body、stackは新診断へ保存しません。
製品キーは200文字以内。失敗時もレポートを保存してから公開を停止し、読み取り途中の例外も部分結果を保存します。
保存自体のエラーは元の検証エラーを置き換えません。成功経路で保存できなければ公開を停止します。

### Phaseの読み方

`release-ux-report.json.phases`とCLIの`release-<command>-report.json.validation`:

```json
{
  "source_integrity": "failed",
  "filter_metadata": "not_run",
  "search_quality": "not_run",
  "query_plans": "not_run"
}
```

`running`にしたphaseだけを失敗時`failed`にします。検索品質未実行を`golden: failed`とはしません。
既存の`golden`、`deploy`、`post_deploy`フィールドは互換性のため保持します（未実行の従来表記は`not run`）。
deployとpost_deployの成功は別です。smokeの部分結果も`verification`へ残します。
通常CI/releaseは`if: always()`で`.cache/release-*.json`をartifact化し、source/filter/UXの失敗詳細も含めます。

## Filter APIの公開判定

共通関数`verifyFilterMetadata(db, {snapshot, output})`をローカルCLIと公開前gateで使用します。
呼び出し元のDB adapter / releaseOwnerを保持し、別DBのopen/closeや書き込みはしません。

検証する内容:

- 全30カテゴリのregistry整合性、control/target/value_type/label/unit、候補型・順序・重複・上限
- finiteかつmin<=maxのrange、正のstep、空候補/null range/同一端点を許容
- step倍数でない端点を拒否しない
- 独立に正規化されたsnapshotから候補・rangeを算出して完全一致確認（SQLの自己比較ではない）
- source integrityのactive集合保証と合わせ、inactive値混入や候補欠落も検出
- metadata SQLのquery plan、read budget（4×active + 2×当該カテゴリfacet行数 + 100）、writes=0
- 候補上限超過はcategory/field/count/limitを診断へ保存。512件上限は変更しない

公開前診断: `.cache/release-filter-metadata.json`。snapshot/sync、カテゴリ別状態、plan、statement/adapter
operation数、D1 read/write/durationを記録します。メトリクス欠損はnullでFAILです。
コストはmetadata SQL分。EXPLAINは別の`plan_statements`、sync状態照会は管理上の追加queryです。
query adapterはstatementを個別実行するため、Workerのbatch操作数と同一視しません。

`verifyProduction`は全30カテゴリのHTTPとsource候補を確認し、代表8条件をPOSTへ往復します。
filters/ranges/facets、数値0/1、複数選択、片側rangeをカバーし、無関係な条件をAND合成しません。
CORS、OPTIONS、400/404/405、Cache-Control/TTL/Ageを確認します。
本番は初回HITを許容し、連続した取得でPOPが同じなら次回HIT必須（Ageと経過時間から正当なTTL満了と分かる場合は次の有限試行へ進む）。POP変更/不明時は最大3回、判定不能なら
`inconclusive`で公開後検証を停止します。pacedRequests/Retry-After/既存rate limiterを維持します。

一般検索・Detail用のsource製品とidentifier用source製品は独立に選びます。
検証済みsourceに識別子が一件もないカテゴリだけ、identifierを理由付き`not_applicable`にできます。
sourceに存在する識別子がDB/APIで見つからない場合はFAILで、一般検索・Detail・Filterをskipしません。

## 再実行可能なA→B検証

```sh
npm run verify:release:cross-snapshot
# delta sync完了後に後続gateが失敗した場合、同じ隔離DBで再検証:
npm run verify:release:cross-snapshot -- --resume .cache/cross-snapshot-<generated-id>
```

スクリプトは`.cache/cross-snapshot-*`を新規作成し、専用config、ランダムlocal D1 ID、state、upstream checkoutを配置します。
既存の`.wrangler/state`、`.cache/upstream`、本番DBを利用/初期化しません。
既存migrationを適用し、Aの全件import・確認、Bの**差分**sync、readiness/source/filter/search/plans、
同Bのreuse、専用port 8791のWrangler Workerで実HTTPを順番に実施します。使用中portは再利用せず停止します。
sourceは固定commitだけで評価し、報告先の引数化は既定のproduction出力を変えません。
再開には完了済みdelta証拠とmanifest一致が必要で、DBを作り直さず、gateを省略しません。

通常CIの`test`ジョブは従来の固定A検証と小規模cross-commit単体テストを維持します。
Filter/source/searchを共有release gate内で各1回計測し、従来の重複benchmarkは除きました。
依存する`cross-snapshot`ジョブはpush/PR/CI手動実行で上記A→B統合検証を必須実行します。
別runner・別DBであり、同一ローカルD1へ複数検証ジョブを並列実行しません。

主な成果物:

- `.cache/cross-snapshot-latest.json`: 今回のdirectory/status
- `<directory>/manifest.json`, `report.json`: 同期計画/結果、phase、provenance、再利用、HTTP
- `<directory>/source-a-integrity.json`, `release-source-integrity.json`
- `<directory>/source-{a,b}/inspection.json`, `upstream-categories.json`: source schema/coverage検証
- `<directory>/release-filter-metadata.json`, `release-ux-report.json`
- `<directory>/worker.stdout.log`, `worker.stderr.log`

CIの`cross-snapshot-release-verification` artifactに成功・失敗とも保存します。
ローカルDB本体やupstream raw checkoutをartifactへアップロードする必要はありません。

## 今回の実測と後続failureの分類

環境: Windows / Node 24 / Wrangler 4.131.1、専用local D1/workerd。**remote D1の課金/遅延測定ではありません**。
実行directory: `.cache/cross-snapshot-5JOEsU`。

|検証|今回の結果|
|---|---|
|A initial import|48,134件、source/readiness合格|
|A→B plan/result|追加90、更新921、inactive化1、unchanged47,212、reactivated0、complete|
|B active|48,223、検証済みsourceのカテゴリ件数と一致|
|unchanged検証|47,212件の行・spec・identifier・facet・timestampが不変、取り込み対象にも含まれない|
|旧比較との差分|source_commitのみ47,212件。その他canonical/raw/spec/identifier/facet不一致0|
|readiness|migration履歴、FK、SQLite、typed spec、FTS integrity合格|
|Filter metadata|30カテゴリ合格、36 SQL、121,311 rows_read、rows_written=0|
|search quality|236 fixture + Detail/resolve評価、既存品質・費用基準で合格|
|query plans|45件合格|
|B再実行|reuseComplete=true、同じsync ID/epoch、ingest 0、保護対象table/FTS fingerprint不変|
|実HTTP|236検索比較、30カテゴリ一般検索/identifier/Detail/Filter、8 metadata検索、cursor/resolve、境界、cache合格|

ローカルB sync IDは`5bb7d4a7-fc59-48a4-9243-3c42516b2e8e`（本番のsync IDとは別）です。
再実行はlease用の書き込みを伴いますが、製品の再取り込みはありません。
Filter direct計測は36 SQL / 36 adapter operations + 36 EXPLAIN。
HTTP Workerログは30 cold requestで36 SQL / **30 binding operations**（各1 batch）、同じ121,311 reads、writes=0。
CPUのcache再取得ではquery/operation/read=0を確認しました。

最初のB gateは`ext-keyboard-12`で停止しました。同期/保存/検索の回帰ではなく、上流の正当なspec補完に
旧fixtureの列挙集合が追従できない問題です。AULA F75 MAXの次の5製品で、未設定だったpolling_rateが1000になりました。

- `31b16f82-6c8c-404d-9a9e-1b06985e3c78` (Black Transparent)
- `cf92235e-4086-4192-869c-4e5654b17045` (Black)
- `d0e71a19-9a77-41c8-a810-4bec219eca45` (Caramel Pudding)
- `d6ca64fc-e739-4a99-a121-095ffa0ec8fa` (White Blue)
- `e6c31e4c-d20f-4440-8f08-c815a0c66eca` (Black Red)

upstreamのA/B Git差分で確認し、旧19件+5件の24件は同じ「名前のAULA単語 AND polling>=1000」というsource条件に一致します。
`search-ux-overrides.json`に元の意味を表す`nameTokens:["AULA"]`を追加しました。クエリ、range、厳密なFP/FN=0の基準、
旧fixture/evidenceは維持し、B専用のID/commit例外は追加していません。小規模回帰テストでは新しいsource一致製品が期待集合へ入り、
FTSから消せば引き続きFAILすることを確認しました。その後同じ隔離DBで全gate/HTTPまで再開し成功しています。

今回実行した経路は`npm test`、`npm run schema:check`、最終`npm run check`（209テスト＋schema check成功）、上記cross-snapshotコマンド（初回失敗、原因修正後resume成功）です。
`verify:catalog` / `verify:filters:local` / `verify:plans` / `benchmark:search` / `release:verify -- --local` /
`verify:worker:local`を別名で繰り返す代わりに、隔離スクリプトから同じsource/readiness/Filter/evaluateUX/plan/smoke関数を使用しました。
この変更を含むGitHub CIはpush前のため未実行で、本番DB書き込み・migration追加・deploy・workflow dispatch/rerunは未実施です。

## 同期complete・Worker未公開からの本番復旧（実行は別途許可後）

1. 修正を含むコードをmainへ反映し、そのコードSHAの通常CI（固定A＋cross-snapshot）が成功していることを確認する。
2. 現在のproduction `sync_runs`の最新状態、snapshot、sync ID、進行中lease、Worker versionと有効epochを読み取り確認する。
   runログや旧Workerが残っていることだけで現在のDB状態を推測しない。
3. 最新completeがBのままであることを確認する。別snapshotへ進んでいたら停止し、古いBへ自動的に戻さない。
4. 明示的な本番操作許可後、**修正済みmainから新しいrun**を開始する。旧runのRe-runは修正前コードSHAを使うので復旧方法にしない。

```sh
# 本番操作許可・上記条件確認後にのみ実行する手順例（今回未実行）
gh workflow run sync.yml --repo kikuuuty/pc-parts-catalog --ref main \
  -f upstream_ref=07e5be1dad48b1913a90a1b6f34e702cce3c475a
```

既存immutable pin、migration gate、maxProducts/writeBudget、lease、全公開gateを経由します。
再利用可能ならBのcomplete sync ID/epochを保持します。DBが同Bで既に同期済みでも、source/Filter/search/plansは改めて検証します。

確認・記録を分ける:

- syncがcompleteか、snapshot / sync IDはどれか
- 公開前validationがすべてpassedか
- deployがsuccess/already deployedか、Worker version / epochはどれか
- post_deploy / Filter smoke / Golden HTTPが合格したか

source/filter/quality失敗ならdeployせず、失敗artifactを調べます。deploy後smoke失敗なら「公開成功」と報告しません。
本番DBの自動rollback・初期化・全件再取り込みは行いません。コードとデータ更新を切り分け、まず固定Bで復旧します。
