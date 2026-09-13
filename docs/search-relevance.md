# FTS5による検索relevance

検索の入口は従来と同じ`src/queries.js`の`searchQuery(category, options)`。
CLI・benchmark・呼び出し側のD1 bindingは、この関数のSQLとparamsをそのまま実行する。
fallbackも1つのSQL内で処理し、benchmark用の別ランキングは持たない。

以下はPhase 1の共通基盤。Phase 2ではcategory-awareなunit/spec解釈、family/chipset一致、
CPU family限定の弱いfreshnessを追加した。候補取得の上限やNULLの扱いを含む現在の追加仕様は
[search-phase2.md](search-phase2.md)を参照。モデル/identifierの元データ正規化は変更していない。

## Query normalization

- 入力は200文字以下、NFKC後の文字/数字tokenは1～12個。FTS演算子を含む入力も引用したtokenとして扱う。
- 通常はtoken前方一致AND。ただしASCIIの1桁数字は完全なtoken一致で、`7`から`7000`へは展開しない。
- 型番展開はASCIIの連続した3～5桁の数字と短い英字affixに限定する。
  prefixは最大5英字、suffixは英字開始で最大4英数字（`X3D`等）。
  数字のみのtokenや、`Ryzen 7`のような短いfamily番号はcompact化しない。
- 主な数字列の前後だけを空白で区切る。例: `SN850X` → `SN850X` / `SN 850X` / `SN850 X` / `SN 850 X`。
  数字列の内部やsuffixの`X3D`内部は分割しない。
- 最大3個の隣接tokenが同じ型番形状になる場合は、そのcompact/分割表記も候補とする。
  英字同士・数字同士の境界は結合しない。重ならない最長グループを使用し、展開数は入力長に対して線形。
- 追加した分割表記は**FTS phrase**で検索する。例えば`rtx5080`は`RTX special 5080`とは一致しない。
  空白付き入力の元のAND条件は保持するため、`rtx 5080`はそのような非隣接tokenも候補にできる。
  このため、両表記の全候補集合・細かなSKU順位の完全な同一性は約束しない。
- `red dragon`を`reddragon`にするような一般の単語連結は行わない。

これらは検索語の展開であり、`products.name`、series、variant、MPNやidentifierの`value_key`を変更しない。
製品側は既存の`unicode61` tokenizationを利用する。型番展開のための独自SQL関数や正規表現拡張は不要。

## Field-aware ranking / exact boost

`product_fts`は従来の`text`に加え、検索専用の`name`、`manufacturer`、`series`、`variant`、`family`列を持つ。
`family`には既存CPU family/generationとGPU chipset/chip_seriesを投影する。
`text`は従来の検索文書（上流identifierを含む）と取込契約を維持する。

0006でbackfill/ingestのフィールド投影を `product_search_projection` viewへ共通化した。
Motherboard chipsetはlegacy textとPhase 2 typed検索に保持し、familyへは追加しない。
全カテゴリのmapping・再現性検証は [FTS projection consistency](fts-projection-consistency.md) を参照。

Phase 1の一致tierは以下。Phase 2では名称全体と名称phraseの間に、明確なfamily/chipset一致を追加する。
各tierを逆転させない範囲でspec/manufacturer/freshnessのsignalも評価する。

1. 条件を満たすidentifierの完全一致。
2. 名称全体の一致（queryはNFKC/trim/lower、保存名はSQLiteのlower/trimで比較）。
3. 名称中の完全なphrase・モデル表記一致。空白を省いた型番も展開して評価する。
4. 全query tokenが名称中で完全一致。
5. queryに含まれるモデルtokenが名称中で完全一致。
6. 全query tokenが名称中で前方一致。
7. series / variant / family、またはmanufacturerを含む複数フィールドでの完全なtoken一致。
8. 通常FTS / local identifier FTS一致。

例えば`14900k`の完全なname tokenは`14900kf`のprefixより強く、
誤ったvariantに`14900KS`と書かれていても、名前の`14900K`を優先する。
`ryzen 7`では製品名のphrase/token一致がidentifierだけの`7`より強い。
ただし、これは検索上の優先度であり、名前の方が常に正しいというデータ検証ではない。

同じtier内では`bm25(product_fts, ...)`のcolumn weightを利用する。
nameを最も重く、series/family、variant、manufacturer、legacy textを順に低くする。
FTS5の負のbm25値を正のrelevanceに直し、1未満の範囲へ圧縮してtierを逆転させない。
同点は`product ID ASC`。local identifierだけの一致は通常FTS tierで、信頼できる完全一致の場合は上記boostを得る。
具体的なweightやscore値は内部調整用で固定仕様ではない。

キーワードなしの既定は従来のID順。明示的な`orderBy`はrelevanceに優先し、指定列昇順＋ID順となる。

## Identifierの扱い

完全一致は既存`identifierKey()`のNFKC・trim・ASCII大文字化をそのまま使用する。
先頭0・ハイフン・内部空白を保持する。

キーワードへの最上位boostには次を要求する。

- MPN: 英字と数字が混在し、ASCII英数字が合計5文字以上。
- barcode: 数字のみで8/12/13/14桁、かつtypeがgtin/ean/upc/jan。
- いずれも、同じキー/対象type条件を持つ**異なる製品数が3以下**。
  upstream/local、region、origin_fieldの重複はdistinct productで数える。
  頻度は全カタログ（inactiveや他カテゴリも含む）で保守的に評価する。

これは形式・頻度の簡易判定であり、barcode check digitやメーカー公式情報を検証するものではない。
`OC`、`16`、`32`、多数製品で共有するMPNは最上位boostを得ないが、通常FTSとして検索可能。
明示的な`identifier`フィルタは利用者が指定した完全一致条件であり、このboost用閾値で除外しない。

## Controlled fallback

1. category、active、typed row、filters/ranges/facets、identifierをすべて適用したstrict結果を確定する。
2. **strictが0件**で、以下を満たすときだけfallbackの候補を取得する。
   - 孤立したASCII 1文字英字がちょうど1つ。
   - その左右に数字を含むtokenがない（分離したモデルprefix/suffixの可能性を保護）。
   - その文字を落としても3個以上のtokenが残り、3桁以上のモデル数字を含む。
3. その1文字だけを落として、同じscopeで残りの語をAND検索する。

例: `gaming x trio 5080` → `gaming trio 5080`。
`gaming missing trio 5080`、`gaming 9 trio 5080`、`gaming trio 5080 x`はこのfallbackの対象外。
数字・複数文字の語は落とさず、段階的に次々とtokenを落とす処理も行わない。
strictが1件でもあればfallbackを混ぜない。ページ2でstrictが尽きてもfallbackへ切り替えない。
fallbackのscoreには通常tierを下回るpenaltyを付け、debugのmatch typeを`fallback`にする。

## Debugと実行計画

```sh
npm run search -- --category cpu --keyword 14900k --verbose
npm run search -- --category gpu --keyword "gaming x trio 5080" --verbose
npm run search -- --category storage --keyword 990pro --explain
npm run verify:plans
```

`debug: true` / `--verbose`は`search_score`、`search_match`、`search_fts_relevance`を返す。
通常レスポンスには追加しない。SQL/paramsにも正規化後のstrict/fallback表現が含まれ、解析に利用できる。

- FTS MATCHと既存identifier exact indexから候補IDを取得。全productsへのLIKE/文字列走査は行わない。
- 名前等の追加評価もFTSのcolumn指定MATCHで行う。評価用のID集合は非相関サブクエリで作る。
- keyword経路は候補→products PK→spec PKのCROSS JOIN順を明示する。
  特にfallbackの小さな集合でSQLiteが全products/specを先に走査する計画を防ぐ。
- relevanceのGROUP BY/ORDER BYや候補集合のmaterializeには一時領域を使う。
- 検索式一式をJSON1の1 bind、identifier keyを1 bindにまとめ、番号付きparameter参照でscopeを再利用する。
  既存と同じ100 bind上限を維持し、benchmarkの100件ページングも同じSQLを使う。
- verify:plansは従来12件＋検索改善5件の17件を確認し、products/spec aliasの全走査も失敗扱いにする。

## Migrationと更新

`0004_search_relevance.sql`を追加。既存migrationは変更しない。

```sh
npm run db:migrate
```

既存FTS textをmigration内で一時退避し、保存済みproducts/CPU/GPUからフィールド別FTSを再構築する。
upstreamの再取得、全件再同期、normalizer versionの変更は不要。
一時退避テーブルは最後に削除する。新しい通常B-tree indexは追加せず、FTS inverted indexを拡張する。

今後の変更取込では、既存`ingest_product`が最後にstaging行を削除するときの
`BEFORE DELETE ON ingest`フックでFTSのフィールド列を更新する。
兄弟triggerの実行順には依存せず、既存の単一SQLによる原子性・ロールバックを維持する。
無変更syncは従来どおりFTSも書き換えない。
legacy textのINSERT後にフィールドUPDATEが加わるため、変更製品ごとのFTS書込量は増える。
実際のD1 rows_writtenを監視する既存sync予算制御を継続利用する。

## Phase 1の範囲と限界

typo訂正、fuzzy/semantic検索、一般の同義語、任意の省略語、メーカーやSKUの品質修正は含まない。
元のMPNやvariantの誤りは残り、低順位の候補やBM25に影響する場合がある。
広い検索は検索語の一致を評価するため、最新世代・人気・容量・OC優先などの意図は推測しない。
Phase 1の実測は[Phase 1測定結果](search-quality-phase1.md)、現在の120件評価は
[Phase 2測定結果](search-quality-phase2.md)を参照。
