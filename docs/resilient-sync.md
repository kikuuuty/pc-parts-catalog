# 上流変化に耐えるカタログ同期

## 契約と停止範囲

上流Schemaとの一致と、Catalogで保存・公開できることを分離する。
`src/input-contract.js`はCatalog所有の入力契約（世代1）、`normalize.js`は正規化世代2。
Schemaの取得・解釈・Ajvコンパイル・参照解決失敗は診断に記録する。
必須項目/enumの追加や、単純な`properties`探索の失敗では全体停止しない。

|状態|処理|
|---|---|
|任意スペックの欠落/null、不正型・値|その項目をnull/不明にする。配列は正常要素を保持。診断・取得率を集計|
|自由文字列の新しい選択肢|型・長さ・文字列安全性を満たせば保持。Mouse.shape、Headphones.connection_types等|
|固定意味の未知値|推測しない。RAM.profile_support未知値はxmp/expo=null、Webcam.frame_rateは既存の明示5形式のみ|
|未使用の追加項目|元rawに保持、公開モデルへ追加しない。unmodeled_field診断|
|名前/基本構造/サイズの不備、JSON破損|製品隔離。同一性を確認できる既存製品は旧版保持、新規は非公開|
|パスとUUIDの不一致、同一カテゴリの衝突、配置変更|カテゴリ保留。先勝ち/後勝ちで解決しない|
|対応カテゴリ消失・空化、件数/品質の大幅変化|カテゴリ全体の更新・削除を保留|
|新しい未対応カテゴリ|完全なGitツリーから検出・報告。自動公開しない|
|取得/読み取り不完全、DB障害、ロック喪失、内部不変条件違反、予期しない例外|全体失敗。隔離や警告付き成功へ変換しない|

数値文字列・単位付き文字列を数値化しない。0/falseは対応する型では有効値。
正数専用項目（画面サイズ等）の0は既存どおり不明。製品名から新しいスペック補完はしない。
既存のCPU family/GPU series/PCIe等の限定変換は継続する。
rawは変換前JSONを保存する（従来どおり再シリアライズでありバイト原本ではない）。
正規化用オブジェクトとは別。フィールド単位の旧値引継ぎはしない。

上限: 名前1000文字、通常文字列/識別子200文字、URL2048文字、使用配列256要素、
入力数値0〜1e9、元JSON700,000 bytes、深さ32/50,000ノード、正規化行1,500,000 bytes。
releaseYearは0〜9999の整数を受け入れ、0は従来どおり不明。識別子のNFKC変換後は1000文字以下。
既存の容量積算・PCIe数値抽出・socket文字列変換で上限を超える場合も、該当項目だけを不明にする。
バッチは従来の25製品・1,800,000 bytes以下。正規化後のモデルとDB制約を両方検証する。
内部モデル不一致は入力issueではなく実装エラー。

## 識別子と存在確認

永続キーは`buildcores + <upstream category>/<UUID v4>`。カテゴリをまたぐ同UUIDは
別製品。名前一致・型番類似で統合しない。新規UUIDの捏造をしない。
新規行の数値IDも既存INTEGER PRIMARY KEYの採番順と排他制御を前提に計画で固定し、適用後照合する。

存在一覧はGitの完全なtreeを根拠にする。対応カテゴリ直下のUUID名の通常JSONファイルに
限り、JSON破損時もそのキーを存在証拠に使う。内部ID不一致や非標準配置はカテゴリ保留。
読めない/欠けたローカルファイルは削除ではなく失敗。UUID/ファイル名のケースも書き換えない。

対応形式は`metadata.part_numbers: string[]`と
`identifiers: {version, identifiers: [{type,value,region}]}`。
上流`docs/DATA_MODEL.md`のversionは**形式世代ではなく競合検出用の更新カウンター**。
正のsafe integerを認め、version=3以上を未知形式にしない。
別のschema_version/format_version付き形式、配列直置き、数値IDは解釈しない。
MPNは安全な文字列、EAN/JANは8/13桁、UPCは8/12桁、GTINは8/12/13/14桁の文字列。
外側空白は形状検証時のみ除き、保存値と出典は維持する。チェックディジット補正・
ゼロ埋め・数値化をしない。value_keyのNFKC/大文字化/trimは既存ルールを維持する。
不正要素だけを除外し、他の識別子や独立したpart_numbersを残す。

## 固定適用計画と再開

manifest (`src/application-plan.js`) に固定commit、入力/正規化/品質方針世代、
基準sync ID/計画hash、基準状態digest、存在一覧、隔離理由、カテゴリ保留、許可削除、
公開予定行（受入れまたは検証済み旧版）と保護する非active行、予定件数、全体SHA-256を保存する。
旧版のraw/spec/識別子/facet/search document/実際のsource_commit/世代/hash、
永続ID、ローカル識別子・補完情報hash、保持行timestampも含む。

基準は直近の**complete**のみ。前manifestがあれば実DBをそれと照合する。
初回の旧世代1からの移行は最後のcomplete commitを別checkoutへ取得し、旧正規化器で
公開行・件数を再現する。rawと保存hash、typed spec、識別子、検索文書も照合する。
非active旧行はraw/旧世代hashの一致を確認して保護し、有効な新入力なしに復活させない。
正規化器v1は移行検証のため凍結して残す。

ロック取得後に基準を再確認し、製品書き込み前に計画を保存する。
forward migration `0011_sync_manifest.sql`はsync_runsへplan_hash/base_sync_idだけを追加する。
全データ履歴DBや警告テーブルは追加しない。
Actionsはpin → plan → **計画artifact upload成功** → sync → releaseの順。
再試行は最初のpin/planをrestoreする。新規週次実行は直近completeの
report_json.artifact_run_idから前計画artifactをread-only取得してhash照合する。
ローカル保存先は`.cache/application-plans/<hash>.json`。

再開時は各行が「固定基準」か「計画どおりの適用済み状態」のどちらかであることを検証する。
DB応答喪失後も無条件再送せず適用済み行を除く。partial/failedから正常基準を作らない。
同一millisecond内の再試行でも、ロック下でsync開始時刻を単調増加させる。UUIDの辞書順で古いrunを最新と誤認しない。
同じcommitでも別計画/syncに置換された古い実行はsupersededとなる。
計画/基準artifact喪失時は停止し、部分DBから再構築しない。
通常のローカル補完編集は次の新規計画に取り込めるが、同一計画の再開途中に編集されたら停止する。

## 削除・品質ガード

削除はacceptedの補集合ではない。完全な存在一覧から消え、カテゴリ保留がなく、
基準active数に対する全体・カテゴリ別20%削除上限を満たす場合のみ許可する。
全変更の適用が済むまで削除を始めない。削除許可は部分適用後に再計算しない。
保留行には書き込まず、非active行も勝手に復活させない。

`QUALITY_POLICY`世代1:

- 存在数は従来の80%〜150%（小規模増加は+10まで）を維持。超過はカテゴリ保留。
- 製品隔離: 全滅、または5件以上かつ10%超。20件以下では20%超も保留。
- 主要項目: 同一キーで以前取得できた項目の20%超、かつ20件以上の喪失で保留。
  基準カテゴリ20製品以下は20%超を件数条件なしで検知（大カテゴリ内の疎な項目とは区別）。
- 識別子: 所有製品・種類別所有製品を比較。要素数は20%超かつ20要素以上、または小規模カテゴリの全要素喪失で保留。
- 初回: 安定して広く埋まる主要項目は20件以上で取得率50%未満、小規模で全件不明なら保留。
  Mouse.shape等、正常でも疎な項目には初回下限を適用しない。基準があれば疎な項目も相対喪失を検知する。

主要項目はCPU socket/core_count、RAM type/capacity、GPU chipset/VRAM、Monitor
screen size/resolution等をprimaryFieldsで明示する。20%は既存削除保護と同じ変化幅、
20件は少数欠損との区別、初回50%は基準なしでの大規模形式不一致検知用。
未使用追加項目/上流Schema診断を隔離率へ加算しない。
Screen size欠落96/約3,900件は約2.5%で、単独では20%超喪失にならない。
基準9月21日にもサイズ不明96件があり、Schema必須違反と公開品質の急変を区別する。

## 後段検証・状態

readiness件数、source integrity、Filter oracle、検索品質、HTTP smokeは同じmanifestの
公開予定集合を使う。実DB/検索結果から期待集合を作らない。保持行は旧世代/旧raw/旧source_commitも
厳密に検証する。非active・ローカル補完も固定hashで確認する。FTSの文書内容とprojection検証も継続する。

保持されている製品の検索ケースは通常実行。非公開の隔離対象を明示キーで指すケースと、
維持元なしの保留カテゴリのみ理由付き除外できる。全体90%以上と各intent実行を必須とし、空評価を合格にしない。
初回保留カテゴリは空のFilter契約を検証し、HTTP製品サンプルはnot_run/理由付きにする。
HTTPの一般契約・cache・pagination用サンプルも公開予定集合から選ぶ。固定SKUの期待値はGoldenで検証する。
既存の総公開件数20,000〜100,000、品質・性能gateは残る。

処理statusはcomplete/partial/failed、quality.statusはclean/warnings/held。
complete+heldは固定計画の適用完了であり、上流全体が最新になった意味ではない。
予算切れpartialはdeploy不可。DB/lease/実装障害はfailed。
cacheは従来のcompleted sync ID/FTS/cache世代を使い、同一計画の完了再利用ではepochを維持。
公開APIに品質確認用の追加D1読み取りはない。

inspection.jsonは全issue数・理由/カテゴリ/field別件数と100件サンプルを分離する。
manifest/sync-reportには隔離/維持数、カテゴリlast_good_commit/held_since、公開中source_commit別件数、
保持行retained_sinceを記録。phaseはpassed/failed/not_runを区別する。
ログに値・SQL・認証情報・provider本文を出さず、Actions注釈に上流文字列を直接埋め込まない。

## 検証・本番適用手順

```sh
npm run check
node --test test/resilient-sync.test.js
node --max-old-space-size=8192 scripts/validate-upstream-history.js --sync --commits 94ece095c351fbdb4e26d13f63a145bcffd820de,3ff68236937d6b08cb38369921cf053c95d3e4fc,e3e3ef0936cdbe2fce5121c9421efe48e1de4387
node --max-old-space-size=8192 scripts/verify-application-plan-local.js --directory .cache/resilient-validation
```

最後のcommandは専用checkout/Node SQLiteのみ使用。通常テストはローカルGit fixtureを含みネットワーク不要。
履歴検証はネットワークが必要で、--baselineに正常基準checkoutを指定できる。
結果は`.cache/resilient-validation/summary.json`とcommit別inspection。
既存検証DBを再開するときだけ`--resume`を指定する。コード変更で入力hashが変わった場合は
別の`--output`で再検証する。後者のcommandは3コミットを再取得し、最新コードの入力hashを
保存計画と照合してから、最終DBのreadiness・source integrity・query plansを確認する。
実測結果・変更一覧は[検証報告](resilient-sync-validation.md)を参照。

`verify-search-local.js`はローカル複製に0011まで適用し、旧世代基準が別commitなら
`--baseline-repo`を要求する。検索/Filter/HTTP/benchmarkの期待集合はmanifestへ統一した。
`measure-sync-cost.js`はローカル検証複製でaccepted行を同じ値で再投入し、書き込み増幅だけを測る。
hash破壊による強制更新は行わない。計画作成の読み取り費用はこの再投入測定に含まれない。
`production-transition.js`/`transition-http.js`/`migrate-isolated.js`は過去の一回限りの移行用であり、
現行manifest同期の復旧には使わない。

本番手順（この実装・ローカル検証では未実施）:

1. 差分/検証結果を確認し、既存writerの停止を確認する。
2. 0011を既存のmigration手順で別途適用する。既存migrationは変更しない。
3. 正常基準commit/前計画artifactを保存する。手動運用は計画を
   `.cache/application-plans/<hash>.json`へ復元する。旧世代移行は基準Gitの取得が必要。
4. 新workflowがpin/plan artifactを製品書き込み前に保存する。
   製品上限10,000、書き込み予算2,000,000を変更しない。
5. 世代1→2は全受入れ製品のhashを変える。約48,000件なので製品上限だけでも最低5回必要。
   予算によりさらに分割され得る。partialなら同じworkflowの失敗jobを再試行し、
   **同じcommit/plan**で再開。日次残予算は本番側の実測で判断する。
6. complete後、source/FTS/Filter/検索品質/性能/readinessを通して既存deploy/HTTP smokeへ進む。
   保留は上流修正後の新計画で通常更新に復帰する。
7. artifact期限は90日。部分実行の計画が復元不能なら停止したまま、バックアップ/同一計画を復元して復旧する。

入力処理はActionsのCPU/ディスク上で行う。D1には差分製品、lock、最小sync記録を保存する。
manifestは約200 MB（非圧縮）のローカル/artifactデータになるため、CI/releaseのNode heap上限は6 GiB。
artifactはhiddenな`.cache`内の計画も明示的にuploadする。
計画作成/再開/完了照合には全件のpaged読み取りを追加するため、読み取り量と所要時間は増える。
SQLite changesはD1 rows_written（FTS/index等を含む課金計測）ではない。
本番日次予算やplanを推測せず、上限を自動で引き上げない。

公開テーブルへ段階的に書く既存方式を継続し、全カタログの原子的切替は保証しない。
partial期間は新旧混在し得る。行単位原子性、削除保護、完了/deploy抑止、計画による再開が保証範囲。
手動SQL/migration/補完編集を適用期間へ混在させない。
