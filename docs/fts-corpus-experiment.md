# FTS corpus実験と検索品質評価（2026-09-16）

## 結論

**現時点では2-FTS方式を維持する。カテゴリ別FTSは実験実装として保存する。**

カテゴリ必須の検索とBM25母集団を揃える意味はある。しかし同一snapshotで、
legacy120件の品質は同等、extended102件では期待SKUのrank回帰が1件発生し、
期待rankが改善したqueryは0件だった。検索read costは改善したものの、
sync SQL実行時間とschemaの複雑さは増えた。理論的な自然さだけを採用理由にしない。

production D1 migration / sync / deployは実施していない。
実測は **ローカルD1（workerd）**。本番D1の課金量・ネットワーク遅延の実測値とは区別する。

## 固定した比較条件・baseline

- BuildCores commit: `eec0df175504ebd15f0f3e3a8249a18a22f00940`
- active products: **48,134**。全製品のcontent hashとraw JSONを固定snapshotに照合。
- A: `product_fts` **29,599文書** + `extended_product_fts` **18,535文書**。
- identifiers: **180,802**。raw JSON: **91,137,805 bytes**。
- 既存120件のfixture / expected / labels / reviewed hash / rank・precision floorは維持。
  reviewed hash: `68d4f73da2ba143c06b5307cd84b97cb232db6489fbcee77b94e9974d925bfb7`。
  従来の内部suite名（regression 40 / development 52 / holdout 28）も維持し、
  比較レポートでは120件全体を **legacy regression suite** として集計する。
- extended hash: `0159fb0832226c96918e2d24052e5917ea357069cac71999d0284a5c5c28f4be`。
  **人間レビュー待ち**。rank / precision floorは自動生成していない。
- SQLite backupでA/Bを独立複製し、BだけローカルD1のatomic batchで実験migrationを実行。
- 同じ `VACUUM; ANALYZE` を両方へ適用。圧縮前のサイズも保存。
- **FTS以外の全対象tableの内容hashが一致**。productsのID・timestampも比較時点で一致。
- 全六列のFTS文書hashも一致:
  `409bcf8b63b92adf97f2197f9621ce572078bad1b5dc5054781e1d4a23216d95`。

今回の保存先は `.cache/corpus-ab-g9axkT/`。
最新の場所は `.cache/corpus-ab-latest.json` に記録する。

| Artifact | 内容 |
| --- | --- |
| `manifest.json` | snapshot、fixture/implementation hash、Node、DBの場所 |
| `baseline.json`, `category.json` | 全222 queryのexpected、rank、top20 IDs/keys、score全内訳、fallback、通常SQL・params・plan、rows_read、SQL/total時間、ページ数、zero result |
| `corpus-baseline.json`, `corpus-category.json` | 各FTSの文書数・平均長・query tokenのDF/出現率・prefix DF・MATCH展開 |
| `comparison.json` | rank delta、worst regression、top1/5/10脱落、top5/10/20 overlap、top20位置変化、全category/class/suite集計 |
| `schema.json` | DB/FTSサイズ、schema件数、migration/statement/triggerサイズ、データhash |
| `sync-cost.json`, `sync-integrity.json` | 全件refresh・no-changeの実測、refresh後の全件再検証 |
| `category-fts-experiment.sql` | registryから生成した実験SQL。production migrations外に保存 |
| `report.md`, `summary.json`, `review.json` | 表形式の比較、集計、query単位のレビュー根拠 |
| `bm25-explanation.json` | 回帰queryのphrase DF、列別TF、文書長、BM25式の再現検証 |

## 実装方式

`scripts/lib/corpus-experiment.js` がregistryのcategoryから `${category}_fts` を生成。
production registryと `searchQuery()` の既定動作はそのまま利用する。
実験query adapterだけが参照FTS名と診断時のscore式を切り替える。

全FTSは `text,name,manufacturer,series,variant,family`、`unicode61`、
`prefix='2 3 4'`。backfillは既存FTSの六列をそのままコピーする。

ingestは次の順序を維持する。

1. 共通 `ingest_product` がproducts / raw / identifiers / facets / typed specsを保存。
2. staging行の削除直前に、categoryが一致するFTS hookが対象FTSをdelete + insert。
   名前・family等は永続化済みの `product_search_projection` から取得。
3. category変更・非active化は旧categoryの専用hookで旧FTSから削除。
   hard deleteにも専用hookがある。
4. 共通triggerとFTS hookは同一statement transaction内。sibling triggerの作成順に依存しない。

30個のFTSへ1製品を重複登録しない。共通ingest triggerへ30本のFTS SQLを足す構造にもしていない。
ただし30カテゴリ×3 hookの管理・条件判定コストは残る。
sync lease、chunk transaction、partial/resume、local enrichment・local identifier保護は既存コードを使用する。

### 30カテゴリFTS・文書数・Golden件数・カテゴリ別品質

Hit@1とMRRは比率。A/B同一なら一つの値を表示。各カテゴリでHit@10=1、zero result rate=0。
rowsは通常検索 `LIMIT 20` のmedian/p95。

| FTS | 文書数 | Golden | Hit@1 A/B | MRR A/B | rows A | rows B |
| --- | ---: | ---: | --- | --- | --- | --- |
| cpu_fts | 789 | 18 | 1 | 1 | 25/513 | 25/513 |
| memory_fts | 4,838 | 15 | 1 | 1 | 1013/6996 | 1013/6996 |
| motherboard_fts | 3,701 | 14 | 1 | 1 | 691/3074 | 691/2882 |
| gpu_fts | 3,837 | 18 | .944444 | .958333 | 169/909 | 169/909 |
| storage_fts | 3,495 | 14 | 1 | 1 | 55/11254 | 45/11157 |
| psu_fts | 3,297 | 10 | 1 | 1 | 1866/3406 | 1575/3039 |
| case_fts | 3,778 | 9 | .888889 | .944444 | 289/16494 | 289/16494 |
| case_fan_fts | 3,460 | 11 | 1 | 1 | 1476/6999 | 933/6987 |
| cpu_cooler_fts | 2,404 | 11 | 1 | 1 | 696/1701 | 357/1701 |
| accessory_fts | 321 | 2 | 1 | 1 | 14/14 | 14/14 |
| capture_card_fts | 32 | 5 | 1 | 1 | 11/185 | 11/61 |
| chair_fts | 255 | 2 | .5 | .75 | 14/35 | 14/35 |
| desk_fts | 335 | 2 | 1 | 1 | 13/13 | 13/13 |
| headphones_fts | 3,096 | 12 | .916667 | .930556 | 22/592 | 22/340 |
| keyboard_fts | 4,214 | 12 | .916667 | .958333 | 45/847 | 45/731 |
| laptop_fts | 118 | 2 | 1 | 1 | 14/14 | 14/14 |
| lighting_fts | 14 | 2 | 1 | 1 | 21/28 | 21/28 |
| microphone_fts | 115 | 5 | 1 | 1 | 13/81 | 13/61 |
| monitor_fts | 3,867 | 12 | 1 | 1 | 22/15168 | 22/15113 |
| mouse_fts | 4,466 | 12 | .916667 | .937500 / .930556 | 49/3255 | 47/1154 |
| mousepad_fts | 130 | 2 | 1 | 1 | 11/11 | 11/11 |
| network_card_fts | 178 | 5 | 1 | 1 | 13/338 | 13/288 |
| os_fts | 11 | 2 | 1 | 1 | 13/13 | 13/13 |
| prebuilt_desktop_fts | 200 | 2 | 1 | 1 | 14/14 | 14/14 |
| sound_card_fts | 84 | 5 | 1 | 1 | 21/303 | 21/193 |
| speaker_fts | 573 | 5 | 1 | 1 | 22/187 | 22/112 |
| stand_fts | 1 | 1 | 1 | 1 | 13/13 | 13/13 |
| thermal_compound_fts | 227 | 5 | 1 | 1 | 13/115 | 13/115 |
| vr_headset_fts | 4 | 2 | 1 | 1 | 11/11 | 11/11 |
| webcam_fts | 294 | 5 | 1 | 1 | 49/52 | 49/52 |

`local_identifier_fts` は共通の補助indexとして別に存在し、BM25 contributionは従来どおり0。
上表の30個/比較の2個はproduct corpus数であり、全FTS数はA=3 / B=31。

## FTS integrity

**48,134 / 48,134合格**。active productは正しいFTSにちょうど1文書、他カテゴリFTSには0文書。
missing / duplicate / wrong-category / inactive-orphanはいずれも0。
各FTSをrowid順の500行pageで読み、全productとのmembershipを検証する。

さらに全48,134製品を同じsnapshot内容でrefresh後、両方式で同じFTS六列hashに戻ることを確認。
全productsのID・content hash・metadataを照合し、変化は `updated_at` のみ。
raw / specs / identifiers / facets / local dataは完全一致。sync_runsの追記は別に記録。

自動テストはcategory変更、非active化、再出現、hard delete、multi-row失敗rollback、
partial importとresume、no-change、local enrichment/identifier保持を検証する。

## Golden結果

| Suite | 指標 | A: 2 FTS | B: 30 FTS |
| --- | --- | ---: | ---: |
| Legacy 120 | HIT | 120/120 | 120/120 |
| | Hit@1 | 118/120 (.983333) | 118/120 (.983333) |
| | Hit@5 / Hit@10 | 1 / 1 | 1 / 1 |
| | MRR | .989583 | .989583 |
| | Precision@5 | .981818 | .981818 |
| | Precision@10 | .986364 | .986364 |
| | zero result | 0 | 0 |
| Extended 102 | HIT | 102/102 | 102/102 |
| | Hit@1 | 98/102 (.960784) | 98/102 (.960784) |
| | Hit@5 | 101/102 (.990196) | 100/102 (.980392) |
| | Hit@10 | 1 | 1 |
| | MRR | .974673 | .973856 |
| | Precision@5 | .991304 | .991304 |
| | Precision@10 | .895652 | .895652 |
| | Recall@10 | .674396 | .674396 |
| | zero result | 0 | 0 |

Legacyの全queryでexpected rankは同じ。既存 `assertGolden` のquery別rank/precision gateもA/Bとも合格。
全体Precisionだけで個別回帰を相殺していない。

extendedの根拠は `test/fixtures/search-extended-evidence.json` にname、source path、
MPN等のidentifier、仕様、facet、関連製品一覧として保存した。
作成recipeはsnapshotだけを読み、検索順位や候補結果をexpectedに採用しない。
102件中、exact/manufacturer表記が同一になるcapture-cardとwebcamの2組を含む。
従って独立した検索入力は100種類であり、件数を独立な利用頻度の推定とは解釈しない。
重み付けと曖昧な同一モデルのSKU集合は初回人間レビューの対象。

### Query class別 Hit@1 / MRR

| Suite | Class | N | Hit@1 A/B | MRR A/B |
| --- | --- | ---: | --- | --- |
| Legacy | exact_model | 18 | 1 | 1 |
| | compact_model | 4 | 1 | 1 |
| | manufacturer_model | 24 | 1 | 1 |
| | identifier | 3 | 1 | 1 |
| | family | 8 | 1 | 1 |
| | model_spec | 19 | 1 | 1 |
| | spec_only | 28 | 1 | 1 |
| | broad | 15 | .933333 | .966667 |
| | fallback | 1 | 0 | .25 |
| Extended | exact_model | 12 | 1 | 1 |
| | compact_model | 4 | .5 | .604167 / .583333 |
| | manufacturer_model | 24 | .916667 | .958333 |
| | variant | 24 | 1 | 1 |
| | identifier | 15 | 1 | 1 |
| | broad | 11 | 1 | 1 |
| | typed_spec | 4 | 1 | 1 |
| | facet | 4 | 1 | 1 |
| | range | 4 | 1 | 1 |

identifier 15/15、exact_model 12/12はtop1。manufacturer_modelでは2件、compact_modelでは2件がtop1でない。
typed_specは現行APIの明示的typed filter併用であり、新カテゴリ向け自然言語spec parserを追加したという意味ではない。

Precisionは明示的acceptableのあるqueryのmacro平均、分母は常にK。
Recall@10は複数acceptableを定義したqueryについて `top10内の関連数 / 全acceptable数`。
Goldenはbinary relevanceのみなので **nDCG@10は未算出**。
欠落rankのdeltaはnullとし、missingへの遷移を独立に回帰分類する。勝手にrank=11等へ丸めない。

## BM25診断

- normal: production score式そのもの。
- without_bm25: `relevance/(1+relevance)` の寄与だけ0。他のtier/spec/manufacturer/freshness/fallbackは維持。
- bm25_only: 同じ候補集合・scope・strict/fallback選択に対してrelevance順。
  typed/identifier由来のrelevance=0候補はIDでtie-breakする。
  明示的orderByは保持するため、その場合はscore順の診断ではない。今回のGoldenはorderBy指定なし。
- 各queryの全候補を並べ替えてからページ取得。top20だけを後から再ソートする近似ではない。
- debugはMATERIALIZEDの有無が通常SQLと違うため、コスト測定に使用しない。
  debugのtop20と通常SQLのtop20を全222件・両方式で一致検証した。
- 全222件で **BM25無効top20がA/B一致**、共通top20製品の非BM25 score component差も0。
  FTS membershipを利用するidentifier trust等の副次的な挙動変化はこのsnapshot/query集合では観測されなかった。

| BM25がexpected rankへ与えた影響 | A | B |
| --- | ---: | ---: |
| improves | 7 | 7 |
| hurts | 5 | 5 |
| unchanged | 210 | 210 |
| mean(normal - without) | -.004505 | +.004505 |
| 最大改善 | -3 | -3 |
| 最大悪化 | +3 | +4 |

Legacyだけでは0 improves / 2 hurts / 118 unchanged。
extendedでは7 improves / 3 hurts / 92 unchanged。

例:

| Query | A normal / without / only | B normal / without / only | 評価 |
| --- | --- | --- | --- |
| Keychron Q1 QMK V2 Knob | 2 / 5 / 2 | 2 / 5 / 2 | BM25で3順位改善 |
| gaming x trio 5080 | 4 / 1 / 4 | 4 / 1 / 4 | 既存のBM25起因悪化を可視化 |
| G502HERO | 4 / 2 / 4 | 6 / 2 / 6 | Bで悪化幅が拡大 |
| DT990 | 6 / 5 / 6 | 6 / 5 / 6 | suffix/別SKUが上位 |

BM25統計はローカルの `fts5vocab(row/instance)` とunicode61自身のtokenizationを使用する。
平均文書長は六列のtoken数合計、prefix DFは複数termのdoc IDのunion。
この診断による追加queryはproduction検索の実行経路には入らない。

### Worst regressionの原因

`ext-mouse-03` / `G502HERO`:
expected `Mouse/19377571-877c-41a4-81cc-43ca813cf646`
（Logitech G502 HERO Wired Optical Mouse - Black）が **4→6位**。
同じtier=650、spec/manufacturer/freshness=0、BM25無効ならA/Bとも2位。

| 統計 | extended_product_fts | mouse_fts |
| --- | ---: | ---: |
| 文書数 | 18,535 | 4,466 |
| 平均文書長 | 27.149771 | 23.794671 |
| `g502` token DF | 34 | 34 |
| `hero` token DF | 41 | 14 |
| 実際の `"g502 hero"*` phrase DF | 7 | 7 |
| 実際の `"g 502 hero"*` phrase DF | 1 | 1 |

単語のDFだけを見ると原因を取り違える。実検索は複数phraseへのcompact展開である。
expected文書は54 tokensで、通常phraseはnameとtextに、追加のspaced phraseは低weightのtextだけに出現する。
上位へ入るkeyboard bundleは32 tokens。同じ六列でもcorpusの平均長とphrase IDFの相対寄与が変わり、
長いexpected文書がbundle/別variantより下へ落ちる。
`bm25-explanation.json` はphraseごとの列別TF・DF・length normalizationを使って
**各corpus内の実際のBM25を誤差1e-10未満で再現検証**している。
異なるcorpus間でBM25絶対値の大小を品質指標にはしていない。

expectedやfloorを変えてこの回帰を消していない。
同一G502 HEROの別recordをacceptableに含めるべきか、bundle/K/DAを非関連とするかは人間レビュー事項。

### その他top1でないextended query

- `ext-keyboard-02`: Q1 QMK V2 Knob、2→2。別のKnob Wired Mini recordが1位。
- `ext-headphones-03`: DT990、6→6。Premium Limited-Editionが1位。
- `ext-chair-01`: BLACKLYTE Athena Fabric Black、2→2。**Athena Pro**が1位。

## Rank delta / top-K overlap / top10レビュー

- finite rank delta平均（B - A、正が悪化）: **+.009009**。
- expected rank改善0、回帰1、変化なし221。
- top1からの脱落0、top5からの脱落1、top10からの脱落0。
- worst: `ext-mouse-03`、+2。

| K | mean intersection count | mean Jaccard |
| --- | ---: | ---: |
| 5 | 3.378378 | .974528 |
| 10 | 5.855856 | .986182 |
| 20 | 9.801802 | .981200 |

短い結果集合を含むためintersectionの分母を一律Kにして「一致率」とは呼ばない。
Jaccardは両集合のunionが分母、両方空なら1。順位の変化は別の `top20_rank_changes` に記録する。

Legacyのtop10 membershipが変わったqueryは10件:

| Query ID | レビュー結果 |
| --- | --- |
| gpu-rtx5080 | 追加/脱落とも明示的acceptable内 |
| p2-memory-ddr5-32 | 同上。top10が全入れ替わるが全てDDR5 32GBのjudged set内 |
| p2-memory-ddr5-6000 | 追加/脱落とも明示的acceptable内 |
| p2-memory-corsair32 | Corsair DDR5 32GBのexpected set内でSHUGO→Vengeance。Precision未定義 |
| p2-memory-6400-cl32 | 追加/脱落とも明示的acceptable内 |
| p2-storage-nvme2tb | 同上 |
| p2-board-b650e-wifi | 同上 |
| p2-case-itx | 同上。既存P@10=.8を維持 |
| p2-fan-corsair120 | Corsair 120mm PWMのexpected set内でHD120→RS120。Precision未定義 |
| p2-fan-arctic140 | Arctic 140mm PWMのexpected set内でF→P14 Max。Precision未定義 |

新たな非関連top10混入はこの判断集合では観測されない。
acceptable未定義の3件はreportが引き続き `manual relevance review required` として残す。
expected set所属は確認できても、順位の望ましさまで自動承認しない。

## D1 read / SQL duration / query plan

通常SQL `LIMIT 20`、warmup後5回、queryごとにA/B順序を交互にしたpaired measurement。
表のmedian/p95は各queryの5回medianを222件で集計。各回の生値・query内p95も保存。
rank探索用 `LIMIT 100` の全ページ合計costは別途各resultの直下に保存する。

| 指標 | A | B |
| --- | ---: | ---: |
| rows_read median | 57 | 55 |
| rows_read p95 | 3,246 | 2,882 |
| SQL duration median | 2 ms | 2 ms |
| SQL duration p95 | 8 ms | 5 ms |
| 既存representative plan gate | 45/45 | 45/45 |
| Goldenのcatalog scan | 1 | 1 |
| temp B-treeを含むGolden plan | 222 | 222 |

Goldenのscanは両方とも `ext-stand-01`。Standのtyped tableは1行であり、
optimizerが選んだ小table scanを隠さず報告する。Bで新規scanは0。
FTS候補のGROUP BYとranking ORDER BYのtemp B-treeは残る。
全catalog full scanやtemp B-treeを消した、といった解釈はしない。
元の `hasCatalogFullScan` 判定と45件のindex gateを変更していない。

## DB size / sync / migration

| 指標 | A | B |
| --- | ---: | ---: |
| compacted DB bytes | 201,039,872 | 202,276,864 |
| product-FTS関連bytes（dbstat） | 27,701,248 | 28,864,512 |
| product FTS数 | 2 | 30 |
| product FTS shadow table数 | 10 | 150 |
| sqlite_schema entries | 111 | 368 |
| migration bytes | 67,272（現行7ファイル累計） | 75,036（追加実験SQL） |
| 最大statement bytes | 31,277 | 30,155 |
| 最大CREATE TRIGGER bytes | 31,277 | 30,155 |
| 全件refresh rows_written（全statement） | 1,444,777 | 1,415,178 |
| 全件refresh rows_read（全statement） | 6,589,607 | 6,423,077 |
| 全件refresh SQL duration合計 | 19.070 s | 30.002 s |
| 全件refresh wall time・計量run | 309.891 s | 254.379 s |
| 全件refresh wall time・先行run | 197.032 s | 237.434 s |
| no-change rows_written | 2 | 2 |
| no-change wall time・計量run | 4.282 s | 4.136 s |

DB増分は **1,236,992 bytes / +.615297%**。raw JSON等の差は0。
FTS自体は約4.20%増加。固定shadow table/schema overheadも含む実測値。

refreshはcontent hashを実験DBで無効化して、**同一snapshotの全48,134製品を更新**したworkload。
初回insertのcostとは区別する。再測定前には元の比較DBから再複製する。
counterはsync関数の全statementをwrapperで計数し、最終report更新とlease解放も含めた。
従来sync reportの狭いcounterは `reported_rows_written` として併記
（A=1,444,775 / B=1,415,176、no-change=1）。

writeは約2.05%減るが、計量runのSQL duration合計はBで約57.3%増えた。
wall timeは2回で勝敗が逆転しており、ローカルproxy・host負荷の影響が大きい。
**「syncが20%遅くなる」等の単一wall timeからの断定はしない**。
trigger条件判定の増加を含め、remote/stagingでの反復測定が必要。

実験migrationは155 statementsのatomic D1 batchとしてローカルで成功。
3.245秒elapsed / .720秒SQL、rows_read=97,388 / rows_written=48,285。
共通ingest triggerはFTS処理を除いて小さくなった。

### D1上で想定される問題

- 30-way UNIONの診断はローカルD1で `too many terms in compound SELECT` となったため、
  integrityはFTS別page方式に修正した。production検索は1個のproduct FTSだけを参照する。
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) のSQL statement上限100,000 bytesに対し
  最大30,155 bytes。byte数とstatement数の両方を記録し、file全体のサイズと混同しない。
- batch全体のremote requestには30秒制約もある。ローカルの155-statement成功だけでは
  remote migrationの実行時間・ロールバック動作まで保証しない。
- 90個の新しいFTS hookと150 shadow tablesはschema保守とsync実行のコストを増やす。
- D1 remoteのrows_read/rows_written、I/O、キャッシュ、課金、初回insertの結果は未測定。
  ローカル数値から本番の請求額を換算しない。

## 採否判断とproduction反映前の残件

| 観点 | 判断 |
| --- | --- |
| search semantics | category限定に母集団を合わせるのは自然。将来の別category増加の影響も隔離できる |
| BM25 quality | 改善query数は増えず、G502HEROの悪化幅が拡大。採用根拠にならない |
| Golden quality | legacy完全維持は達成。extendedのHit@5/MRRは低下し、未レビューのSKU曖昧性もある |
| D1 read cost | ローカルp95改善。特にmouse/capture_card等で有利 |
| DB size | +.615%は小さいが、品質低下を相殺する理由にはならない |
| sync cost | write減少、SQL時間増加。wall timeは不安定でremote確認が必要 |
| migration complexity | generatorにより管理できるが、155 statementsとbatch時間制約を考慮する必要 |
| maintainability | 手書き30SQLは回避。2 corpusよりschema/trigger/運用の対象は増える |

**推奨: productionは2-FTSを維持。新しい評価・診断基盤と実験実装を継続利用する。**

productionへ進む前に必要な確認:

1. extended102件の人間レビュー（重複入力の重み、同一モデル別record、bundle/suffixの関連性、
   malformed upstream MPNを含むidentifierケース）。期待値を結果に合わせて自動変更しない。
2. `G502HERO` の4→6回帰を解消するか、正解集合の妥当性を独立レビューする。
   現在の回帰をcorpus変更の不可避な結果として承認しない。
3. legacy top10入れ替え、特にacceptable未定義の3件の順位妥当性レビュー。
4. isolated remote/staging D1で同じsnapshot/Goldenを用いたread/write/latency反復測定、
   fresh insert・incremental update・delete/reactivation・resumeの実測。
5. 実際のmigration配布経路、batch/statement時間、停止・再開・rollbackの検証。
6. productionへ進める場合には、registry routing、release readiness、FTS generation/cache epoch等の
   production integrationを別途レビューする。今回の実験adapterをそのままdeployしない。

## 再現手順

Node 24、`npm ci`、固定snapshotの `.cache/upstream` と既存の検証用ローカルD1が前提。
`--source-location` は既存fresh verifierが出す `{directory, configPath}` 形式のJSONを指定する。
元のDBはread-onlyで開き、実験は `.cache/corpus-ab-*` に複製する。
各stageは同じmanifestのfixture/implementation hashを検証する。

```powershell
npm run golden:extended:check
npm run experiment:fts -- --stage prepare --source-location .cache/all-categories-fresh-location.json
# prepareが表示したディレクトリを以降に指定
npm run experiment:fts -- --stage measure --directory .cache/corpus-ab-XXXXXX
npm run experiment:fts -- --stage cost --directory .cache/corpus-ab-XXXXXX
node scripts/verify-corpus-cost.js --directory .cache/corpus-ab-XXXXXX
npm run experiment:fts:report -- --directory .cache/corpus-ab-XXXXXX
npm run check
```

`npm run experiment:fts` はprepare/measure/costを続けて実行する。
qualityの候補回帰はJSONへ記録される実験結果であり、自動的なproduction採用gateではない。
既存baselineのreviewed Golden floorとrepresentative query planは検証gateとして扱う。

通常のbenchmarkでも独立suiteを選択できる:

```powershell
npm run benchmark:search -- --fixture test/fixtures/search-extended.json --suite extended --output .cache/extended-search.json
```

`prepare-extended-golden.js` の既定動作は固定fixtureとsource recipeの照合だけ。
`--write` は未作成ファイルだけをexclusive create、`--candidate` は `.cache` にレビュー用案を出力する。
既存expectedやreviewed hashを検索結果から更新する経路はない。

データの出典・ライセンスは [NOTICE.md](../NOTICE.md) と [fixture README](../test/fixtures/README.md) を参照。
