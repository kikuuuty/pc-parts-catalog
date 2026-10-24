# 削除率保留・計画保存前再試行の追加検証

## 対象と結果

2026-10-24、`kikuuuty/pc-parts-catalog`のレビュー対象
`8efdf93f9654df7e3bdb1955b4b18ed60059ec22`からの修正。
作業開始時のHEADは同commit、作業ツリーはクリーンで、後続変更・修正済み箇所はなかった。
今回の2経路を修正し、18件の回帰テスト（各テスト内の境界/障害パターンを含む）を追加した。
ローカルSQLiteでの実同期、共有artifact adapterの分岐・操作順序、既存の後段検証が成功した。
本番適用は実施していない。

## 原因と修正

### 1. 件数不変の大量入れ替え

従来は件数等の品質判定後に適用行を選択し、カテゴリ別削除率超過をassertで全体停止していた。
総数が同じでも既存キーが30%置き換わるケースは事前品質判定を通過してしまう。

独立した前計画/上流ソースで正常基準を検証した後、適用行確定前の`ingestionQuality()`で判定する。
分母は基準カテゴリactive件数、分子は完全・同一性確認済みの上流存在キー集合にない基準activeキー数。
acceptedの補集合を使わず、隔離された存在キーも含め、重複存在情報を集合で扱う。
曖昧な同一性は既存の保留を優先し、不完全なsnapshotは停止する。

同じ`maxDeleteFraction`（共通の既定値20%）を厳密に超えたカテゴリだけ
`category_delete_fraction`でheldとする。閾値ちょうどは許可、基準active=0は候補0・割合0。
全カテゴリの適用行を選んだ後も既存のカテゴリ/全体assertを最終保護として残す。
新規計画に判断と診断値を固定し、partial DBから再計算しない。

`quality.categories.<category>.deletion`に`baseline_active`、保留前`candidates`、
`fraction`、`max_delete_fraction`を保存する。保留後の実削除0でも検出30件/30%が残る。
旧active/inactiveの全情報を維持し、安全な別カテゴリだけ更新する。

### 2. pin保存後・計画保存前の失敗

従来はattempt 2以降で計画artifactと計画ファイルを必須とし、uploadもattempt 1限定だった。
未書き込みでも計画が未保存なら同一runで復旧できなかった。

workflowがrun-scoped artifact一覧を全ページ照会し、共有ヘルパーが以下を区別する。

|状態|結果|
|---|---|
|正常な固定計画あり|restore・hash/commit/実行/基準を検証、同じ計画のみ利用、再作成・再uploadなし|
|正常なAPI照会で未保存を確認|元の同一run pinを用い、writer lease下の未開始検証と独立した基準整合性検証に通った場合だけ作成|
|取得不明、期限切れ、破損、不一致、基準置換/不正、書き込み開始済み|停止、計画を再作成せず製品を変更しない|

未開始検証では最新ID=pin.base_sync_id、complete、後続開始/running/未処理ingestなしを確認する。
新pinは基準計画hash/commitも固定する。基準nullなら履歴・製品とも0件が必要。
元のpinを欠く再試行や別runのpinは拒否する。moving mainは解決しない。
基準内容は前計画または固定上流で照合し、DBを自身の正解として扱わない。

`syncSnapshot()`の開始記録INSERTは最初の製品書き込みより前に実行される。
これと排他制御が未開始確認の根拠であり、report欠如は根拠にしない。
製品書き込み後のrunning/partial/failed/completeはすべて再作成不可。

workflowは取得/保存/ステップ制御を担当し、CLIは共有判定とDB検証を担当する。
新規作成時はどのattemptでも上書き禁止upload → 再取得/hash照合 → 保存済みreceipt発行の順。
応答喪失を含む保存/確認失敗はその試行を停止し、次回に保存済みならrestoreする。
sync CLIもreceipt/hashを検証し、さらにwriter lease下で計画・基準・実DBを再確認する。
`continue-on-error`や「ローカルファイルがないから作成」は使わない。

## 回帰テスト

### `test/resilient-sync.test.js`（6件追加）

- Monitor基準active100件中30件を新規30件と置換、Mouseの更新+新規追加。
  Monitorは保留、Mouseは製品数制限partial・予算制限partialを経て同一計画でcomplete。
  保留判断/予定件数を固定し、Monitorの旧製品全行・ID・raw/spec/識別子/facet/検索文書・
  出典・timestamp・ローカル識別子/補完を照合。新規30件は未保存、旧30件もactive維持。
  公開予定件数と実DB一致、complete+held、完了再実行の製品書き込み0件。
  後続の安全なsnapshotで保留解除・更新でき、維持したIDは不変。
- 20%ちょうど/21%、設定30%ちょうど/31%、重複存在一覧、基準active0を実同期。
- 30件隔離でも真の削除候補は1件だけ。隔離率という別保護は維持。
  1件隔離+1件真の削除では通常処理し、隔離製品はactive維持、真の削除だけinactive。
- 有効な再出現入力があっても、保留カテゴリの旧inactiveは復活しない。
- 旧品質方針1のpartial計画を、現在の閾値設定を変えても再評価せず同じhash/内容で再開。
- 旧品質方針1のcomplete計画を独立した基準として方針2計画を作成。
  不明な存在証拠では保留、acceptedキーが存在一覧から欠ければ停止。

大量入れ替えfixtureでは、実公開計画に対して既存のsource integrity・FTS integrity・
Filter metadata oracle・filter-only検索のexact-set評価も実行した。
既存のHTTP/検索品質/整合性異常検出テストは変更・緩和していない。

### `test/release.test.js`（12件追加）

artifact操作だけを差し替え、製品への適用には実際のローカルSQLiteを使用する。
本番のartifact CLI/plan CLI/sync CLIと同じ共有関数を
restore → create/reuse → upload → confirm → syncの順で実行する。
YAML/CLIの接続確認は補助テストであり、文字列確認だけを合格根拠にはしない。

- pin保存後、lease取得済みの計画用DB読み取りを失敗させる。製品書き込み0、開始記録追加なし、lease解放。
  同一pinで再試行し、正常基準検証・保存確認後だけ同期。
- upload前失敗、保存済み応答喪失、保存確認時API失敗。未確認時の製品書き込み0。
  次回は未保存なら検証後に再作成、保存済みなら同じhashをrestoreして上書きしない。
- 固定計画ありではcreate/uploadを呼ばず、commit/hashを維持。固定commit以外のfetchを拒否するadapterで確認。
  通常のpartial再開とcomplete再利用（追加製品書き込み0）も検証。
- running/partial/failed/実complete後のartifact喪失は停止。
  report_jsonがなくても再作成不可、DB/ローカル補完は不変。
- pin基準がpartial/failed/runningなら停止。同じcommitでも別sync ID/計画による基準置換は停止。
  upload後に基準のID・完了状態・計画hashが変わった場合もsync前に停止。
- 基準null・履歴0・製品0だけ初期作成を許可。基準null・製品あり、pin欠落/他run/基準ID欠落は停止。
- 権限エラー、429、5xx、timeout、download失敗、JSON破損、hash/commit/run/基準不一致、期限切れは停止。
  実GitHub adapterもHTTP/通信/JSON/ページ数変更・重複ID異常を未保存扱いにしないことを確認。
- 基準ID一致でもtyped spec破損を独立照合で拒否。外部writer lease保有中も拒否。

小さなfixtureは本番の件数envelopeを緩めたproduction CLIを実行するのではなく、
同じ共有判定と`syncSnapshot()`で検証する。本番の20,000〜100,000件gateはそのまま。

## 実行コマンド・実測結果

|コマンド|最終結果|
|---|---|
|`node --test test/resilient-sync.test.js test/release.test.js`|45 tests / 45 pass / 0 fail・skip、exit 0|
|`npm run check`|schema生成物一致、354 tests / 354 pass / 0 fail・skip、exit 0|
|変更JavaScript全8ファイルに`node --check <file>`|すべてexit 0|
|`git diff --check`|空白エラーなし、exit 0|

`npm run check`中の`Validation report could not be saved; original failure retained`は
既存のレポート保存失敗テストが意図的に出す診断で、当該テストもpass。
新規テストファイルは追加せず、既存2ファイルへ追加した。

## 変更ファイル・互換性

- `src/quality/ingestion.js`: 事前削除率保留、共通閾値、診断、品質方針2。
- `src/application-plan.js`: 未開始基準検証、閾値引渡し、実行情報、適用時の基準status/hash再確認。
- `src/sync.js`: lease下の回復用検証、未保存経路の自動再開禁止、共通閾値。
- `scripts/lib/plan-artifact.js`（新規）: pin/計画/receipt検証、取得/再利用/作成/保存確認の共有処理、差し替え可能なAPI adapter。
- `scripts/catalog-plan-artifact.js`（新規）: 全ページ一覧照会、gh read-only download、保存確認、安全な診断。
- `scripts/catalog-release.js`: attempt依存の必須読み込み撤廃、共有判定・固定snapshot取得・保存済みgate。
- `.github/workflows/sync.yml`: 明示的取得、新規計画のattempt非依存upload、上書き禁止、保存確認後のsync/deploy。
- `test/resilient-sync.test.js`、`test/release.test.js`: 上記回帰テスト。
- `docs/resilient-sync.md`、`docs/catalog-release.md`、本報告: 方針・復旧・診断・結果。

品質方針を1→2とした理由は、件数不変でもキー削除率でカテゴリ保留する新しい計画判断を識別するため。
保存済み計画はhash/判断を変更しない。旧計画partial再開と旧complete計画を基準にする経路を両方検証した。
新計画の任意`workflow_run_id`は実行結合を補強する。旧計画はrun-scoped artifactと既存pinで結合する。
計画形式1・入力契約1・`NORMALIZER_VERSION=2`は据え置き。正規化出力・公開API・migrationは変更していない。
この差分のための追加migration、全件再正規化、保存済み計画の変換は不要。

## 未実施・適用時の注意

- 約4.8万件×履歴commitの全件検証は今回**実施していない**。差分は正規化出力に触れず、
  問題の安全判定・操作順序を小fixtureで再現する範囲とした。以前の履歴検証を今回の実績として扱わない。
- 実GitHub APIの照会/download/upload、Actions上の再試行・artifact可視化/通信特性は未検証。
  API adapterのネットワークは通常テストで差し替えている。
- 本番D1読み書き、リモートmigration、Actions手動起動、本番再Sync、Worker deploy/本番HTTP検証は一切未実施。
- ローカルSQLiteの書き込み件数はD1の課金rows_writtenではなく、本番の時間/費用/日次残予算は未測定。
- 本番適用時は別作業で差分・権限を確認し、元のpin/計画artifactを維持して同じrunの失敗jobを再試行する。
  取得不能・書き込み開始後の計画喪失・基準不一致では停止を解除せず、同じ固定計画の復元を優先する。
