# 気になったときだけ使う検索チェック

定例レビュー、承認者、理由、確認件数のノルマはありません。
検索がおかしいと感じたときだけ、ローカルで再現できます。

```sh
npm run diagnose:search
# release reportのcaseを直接開く
npm run diagnose:search -- --case p2-storage-sata1tb
```

ブラウザで **http://127.0.0.1:8788** を開き、カテゴリと検索語を入力して「検索」を押します。
Ctrl+Cで終了します。別のportを使う場合は`-- --port 8789`を指定できます。

## できること

- 実際の検索APIと同じ検索結果・順序を見る
- 必要ならメーカー・容量などのtyped filterやrange、facetを加える
- 検索語を空にしてfilter-onlyの一覧・cursor paginationを試す
- 製品の仕様・識別子を確認する
- 「詳しい診断情報」を開いてmatch type、score、query plan、rows_read、SQL durationを見る
- Case IDからfixtureの実入力・source expected集合・現在の結果を再実行する
- lookup: original expected / source equivalentsを区別し、Top10のMPN・score・BM25・rankを見る
- browse: Relevant returned / False positives / False negativesを分け、missing製品を直接見る
- 各製品のspecとsource relevant条件を確認し、missingのFTS/typed row/MATCHを追う

実Workerのfetch handlerと検索compilerを使い、ローカルD1だけを読み取ります。
外部検索・production API・price Providerへの接続は行いません。検索結果や操作を保存・承認する必要はなく、release gateへの入力にもなりません。
costはAPI検索部分の値です。追加の説明用EXPLAIN/debug queryは含まず、local値を本番latencyとは扱いません。

## 自動テストとの関係

release gateはsource/FTS integrity、lookup/identifierの機械評価、候補集合、pagination、product reference、performanceを自動確認します。
**人間が未確認でも、気になると感じても、それ自体でreleaseは停止しません。**
以前のreview overlayはrelease経路から読み込まれません。確認者・理由・fixture承認hashの提出は不要です。
lookup fixture全111件は自動評価用のデータであり、人間の作業リストではありません。

自動評価をまとめて実行したいときは次を使えます。

```sh
npm run benchmark:ux
npm run release:verify -- --local
npm run analyze:search
```

`analyze:search` はcurrent failureを抽出して `.cache/search-failure-analysis.json` / `.md` に診断証拠を保存します。全FP/FN一覧を保存し、高コストなrow traceはcaseごと最大10件です。release reportにも `npm run diagnose:search -- --case <id>` が出ます。

今回の24件の分類・変更前後・filter操作の根拠・性能測定は [search-failure-analysis.md](search-failure-analysis.md) を参照してください。分類メモは診断専用で、自動release判定への入力ではありません。

## ローカルDBがまだない場合

通常のローカル開始手順でsnapshot取得・migration・syncを一度行ってください（[README](../README.md#ローカル開始)）。
取得には接続が必要ですが、準備後の診断はオフラインで使えます。診断ツール自体はfetch/sync/migrationを実行しません。
DBのsync後は診断serverを再起動すると、新しいepochでcursorを試せます。
