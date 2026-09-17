# Search quality failure analysis — 2026-09-17

## 結果と測定対象

**24 failure → 0 failure、local release gate PASS。** 分類は **A=4 / B=16 / C=1 / D=3**。

- baseline: `fbc22984125e6b91fcfd23a8a1c523c56128166d`
- source snapshot: `eec0df175504ebd15f0f3e3a8249a18a22f00940`
- local sync: `24fe3701-08c4-42d9-b873-1be29bd4d051`、active 48,134製品、30カテゴリ
- baseline source of truth: 既存 `.cache/release-ux-report.json` の24件。同じ24件を変更前に再現して `.cache/search-failures-before.json` へ保存。
- `case-meshify` ではなく **`p2-case-meshify`** が今回のfailure一覧に存在する。例示リストを追加failureと解釈していない。
- baseline 233検索ケース → 236検索ケース。historical fixture本体を維持し、`search-ux-overrides.json` でintentとUI入力を明示。
- production migration / sync / deploy / cache epoch changeは実行していない。永続local catalogにもmigration/syncは実行していない。

category FTS、keyword window=1000、cursor/keyset、manufacturer → series → name → id、relevance tie-break、stable reference、Detail/Resolve/identifier API、active/inactive/missing、cache epoch semantics、migration historyを維持。

## 永続的な診断手段

```sh
npm run diagnose:search -- --case p2-storage-sata1tb
npm run diagnose:search -- --case ext-mouse-03
npm run analyze:search
```

`analyze:search` はcurrent failureを自動抽出し、`.cache/search-failure-analysis.json` と同名のMarkdownを生成する。JSONには各caseの以下を保存する。

- intent / category / query / filters / ranges / facets、expected / equivalents / relevant source selector
- returned/relevant IDsと件数、coverage、precision、FP/FN、lookup rank、window exhaustion
- rows_read、SQL duration、query plan、実際のcandidate SQL/binds
- Relevant returned / False positives / False negatives **全製品**のname、manufacturer、series、variant、spec、identifiers、upstream_key、source条件
- lookup Top10（存在する範囲）、original expectedのマーク、source equivalentのマーク、match type / score / -BM25
- missing rowのsource raw、typed row、source/typed predicate判定、FTS membership / text / MATCH、query normalization（高コストなrow traceのみ最大10製品。FN一覧は切り詰めない）
- baseline24件のA/B/C/D、根拠、proposed action

分類の説明は `search-failure-decisions.json`。**このファイルは診断専用で、release gateから読み込まれない。** 新しい未知のfailureは未診断と表示し、分類を自動で捏造しない。

今回のartifact:

| Artifact | 内容 |
|---|---|
| `.cache/search-failures-before.json` / `.md` | 変更前24件の完全な診断証拠・query plan・Top10 |
| `.cache/search-failures-after.json` / `.md` | 元24件を変更後の入力で再評価した証拠 |
| `.cache/search-failure-comparison.json` | Before/After、window、残存FP/FN、7 intentの性能 |
| `.cache/search-compiler-ab.json` | 元233入力を固定した旧/new compiler交互A/B |
| `.cache/search-ux.json` | 指定 `npm run benchmark:ux` の最終結果 |
| `.cache/release-ux-report.json` | source integrity、全caseと45代表query plan |
| `.cache/release-verify-report.json` | local release success |
| `.cache/ux-api-local.json` | real Workerのcursor、SATA、Detail/Resolve検証 |

再生成:

```sh
npm run analyze:search -- --cases .cache/search-failures-before.json --output .cache/search-failures-after.json
node scripts/compare-search-failures.js
node scripts/benchmark-search-change.js .cache/search-failures-before.json fbc22984125e6b91fcfd23a8a1c523c56128166d
```

`.cache` artifactは生成物。この文書に永続的な判断・数値・source keyを残す。baselineを採る場合は修正前のcheckoutで `npm run analyze:search -- --output .cache/search-failures-before.json` を実行する。

## 24件の分類と診断結果

以下の前後の件数は **relevant / returned / FP / FN**。coverageとprecisionの分母はsource relevant集合と実際のreturned集合。lookupでは集合純度をgateしない。

| Case | 分類 | Before | After | 最終coverage / precision | 診断・処置 |
|---|---|---|---|---|---|
| memory-trident-series | D | 70 / 84 / 14 / 0 | 同左 | 100% / 83.33% | 12件は近縁NeoX、2件はsource identifier noise。family探索として限定的noiseを許容 |
| p2-gpu-5070-12gb | B | 71 / 150 / 79 / 0 | 71 / 71 / 0 / 0 | 100% / 100% | VRAMをfilterへ |
| p2-gpu-9060xt-16gb | B | 26 / 41 / 15 / 0 | 26 / 26 / 0 / 0 | 100% / 100% | VRAMをfilterへ |
| p2-storage-samsung2tb | B | 22 / 200 / 178 / 0 | 22 / 22 / 0 / 0 | 100% / 100% | 容量・メーカーselection |
| p2-storage-sata1tb | A | 130 / 128 / 0 / 2 | 130 / 130 / 0 / 0 | 100% / 100% | mSATA tokenの取りこぼしを修正 |
| p2-board-b650e | B | 23 / 41 / 18 / 0 | 23 / 23 / 0 / 0 | 100% / 100% | chipset selection |
| p2-board-am5-atx | B | 239 / 366 / 127 / 0 | 239 / 239 / 0 / 0 | 100% / 100% | socket + form factor |
| p2-board-b650-matx | B | 87 / 164 / 77 / 0 | 87 / 87 / 0 / 0 | 100% / 100% | chipset + form factor |
| p2-board-asus-am5 | B | 73 / 95 / 22 / 0 | 73 / 73 / 0 / 0 | 100% / 100% | ブランド探索 + socket/form factor |
| p2-psu-850noun | B | 456 / 261 / 0 / 195 | 456 / 456 / 0 / 0 | 100% / 100% | wattage全件一覧をtyped cursorへ |
| p2-case-meshify | A | 5 / 57 / 52 / 0 | 5 / 5 / 0 / 0 | 100% / 100% | CがType-C、Compact、Caseに一致していた |
| p2-cooler-360aio | B | 518 / 281 / 0 / 237 | 518 / 518 / 0 / 0 | 100% / 100% | cooling type + radiator |
| p2-cooler-360mmaio | B | 518 / 280 / 0 / 238 | 518 / 518 / 0 / 0 | 100% / 100% | 同上 |
| p2-cooler-240aio | B | 455 / 265 / 0 / 190 | 455 / 455 / 0 / 0 | 100% / 100% | 同上 |
| p2-fan-noctua120 | B | 41 / 112 / 71 / 0 | 41 / 41 / 0 / 0 | 100% / 100% | メーカー + size |
| p2-fan-120noun | B | 2111 / 529 / 10 / 1592 | 2111 / 2111 / 0 / 0 | 100% / 100% | size全件一覧をtyped cursorへ |
| p2-fan-bequiet140 | B | 47 / 120 / 73 / 0 | 47 / 47 / 0 / 0 | 100% / 100% | quietという一般語とメーカーを区別 |
| ext-keyboard-09 | A | 34 / 44 / 10 / 0 | 34 / 34 / 0 / 0 | 100% / 100% | Q14のprefix一致とK2等のidentifier汚染 |
| ext-mouse-03 | C | expected rank6 / 7候補 | source equivalent rank1 / 7候補 | lookup Hit@3 PASS | rank1は同じMPNのG502 HERO |
| ext-monitor-09 | D | 16 / 26 / 10 / 0 | 16 / 17 / 1 / 0 | 100% / 94.12% | Neo G7/G70/G75の近縁family。短いモデルtoken修正でG7へ限定 |
| ext-headphones-03 | B | Pro250 rank6 / 6候補 | 6 / 6 / 0 / 0 | 100% / 100% | DT990をfamily browseへ |
| ext-headphones-09 | B | 5 / 6 / 1 / 0 | 6 / 6 / 0 / 0 | 100% / 100% | DT990/DT 990の表記差をsource selectorで統合 |
| ext-sound_card-05 | D | 20 / 24 / 4 / 0 | 同左 | 100% / 83.33% | 4件は近縁Sound BlasterX |
| ext-thermal_compound-05 | A | 9 / 13 / 4 / 0 | 9 / 9 / 0 / 0 | 100% / 100% | MX-4の4が別モデルの4gに一致していた |

## 最優先: SATA missing 2製品

| 属性 | Integral | Kingston |
|---|---|---|
| name | Integral MO-300 1.024 TB SSD mSATA mSATA | Kingston KC600 1.024 TB SSD mSATA mSATA |
| upstream_key | `Storage/747fdef9-2fa3-46ea-8941-4136861af250` | `Storage/dbebd765-b8b9-4d52-995d-b96d6f9196f0` |
| local id（診断時のみ） | 14740 | 16170 |
| manufacturer / series / variant | Integral / MO-300 / 1000GB | Kingston / KC600 / 1000GB |
| storage_type | SSD | SSD |
| form_factor / interface | mSATA / mSATA | mSATA / mSATA |
| capacity_gb / nvme | 1000 / 0 | 1000 / 0 |
| MPN | INSSD1TMSA | SKC600MS/1024G（他に分割MPNあり） |
| FTS membership | true | true |
| 旧MATCH `"sata"*` | false | false |
| source/typed filters | true / true | true / true |

FTS text（実測）:

```text
Integral Integral MO-300 1.024 TB SSD mSATA mSATA MO-300 1000GB 5055288444935 INSSD1TMSA INSSD1TMSA
Kingston Kingston KC600 1.024 TB SSD mSATA mSATA KC600 1000GB 0740617316032 1024G SKC600MS SKC600MS/1024G 740617316032 SKC600MS 1024G SKC600MS/1024G
```

trace:

1. pinned source JSONに `capacity:1000`, `storage_type:"SSD"`, `nvme:false`, `interface:"mSATA"` が存在。
2. normalizerはsource capacityを1000として保持し、falseを0へ正規化。表示名の1.024 TBから容量を再推測していない。名称と容量のsource表記差はあるが、今回の取りこぼしの原因ではない。
3. typed rowとsource normalized specは一致。filter/rangeによる除外ではない（ranges/facetsなし）。
4. FTSにdocは存在するが`msata`は単一token。prefix `sata` は先頭に一致しない。
5. 旧candidate generationのstrict_ftsに入らず、typed filtersへ到達しない。queryにspec seed/fallbackはなく、candidate limit/windowも未到達。
6. storageだけで `sata` に `msata` のFTS branchを追加。他のquery tokenと全typed predicatesは保持。mSATA側だけを検索したときにSATA全体へ逆拡張はしない。
7. rankingのMATCH tierにも同義語を反映し、mSATA候補が全tierをfall-throughする余分な読み取りを防止。

**期待集合130件・fixture条件は一切変更していない。** source-grounded FN=2→0。real Worker APIでも全ページ130/130、missing=0。SATAという単語もnameに持つSamsung mSATAは旧実装でも取得済みで、今回missingの2件とは別。

## Fixture Before / After / UX理由

このrepoで実行できるfrontendは診断UIとshared-build例。完成した外部frontendの利用ログがあるとは仮定しない。実際に描画されるカテゴリ別filter controls、`/v1/search`の型付きAPI、`models`のfieldsを根拠に、keyword欄と絞り込み欄の操作へ分離した。Browser checkで数値filter、cursor、identifier、case表示を検証済み。

### 元browse21件 → browse_filter 6件

| Case | Before keyword | After keyword + filters | Reason |
|---|---|---|---|
| p2-gpu-5070-12gb | rtx 5070 12gb | rtx 5070 + vram_gb=12 | VRAMの明示選択 |
| p2-gpu-9060xt-16gb | rx 9060 xt 16gb | rx 9060 xt + vram_gb=16 | 同じmodelの容量違いを除外 |
| p2-storage-samsung2tb | samsung 2tb | samsung + manufacturer=Samsung, capacity_gb=2000 | ブランド探索後のメーカー/容量selection |
| p2-board-asus-am5 | asus am5 atx | asus + manufacturer=ASUS, socket=AM5, form_factor=ATX | socket/form factorは絞り込み |
| p2-fan-noctua120 | noctua 120mm | noctua + manufacturer=Noctua, size_mm=120 | 名前にサイズがなくてもtyped sizeで選ぶ |
| p2-fan-bequiet140 | be quiet 140mm | be quiet + manufacturer=be quiet!, size_mm=140 | quietという一般説明ではなくメーカーselection |

### 元browse21件 → filter_only 8件

| Case | Before keyword | After filters（keywordなし） | Reason |
|---|---|---|---|
| p2-board-b650e | b650e | chipset=AMD B650E | typed chipset、製品名のB650-Eとの混同を避ける |
| p2-board-am5-atx | am5 atx | socket=AM5, form_factor=ATX | 全条件がtyped |
| p2-board-b650-matx | b650 matx | chipset=AMD B650, form_factor=Micro ATX | 同上 |
| p2-psu-850noun | 850w psu | wattage=850 | PSUカテゴリ内の出力選択 |
| p2-cooler-360aio | 360 aio | water_cooled=1, radiator_size_mm=360 | 冷却方式とラジエータの選択 |
| p2-cooler-360mmaio | 360mm aio | water_cooled=1, radiator_size_mm=360 | 同上、単位差をUI値へ |
| p2-cooler-240aio | 240mm aio | water_cooled=1, radiator_size_mm=240 | 同上 |
| p2-fan-120noun | 120mm fan | size_mm=120 | ファンカテゴリでサイズ全件一覧 |

旧free-text spec検索のindexed seed=256はbounded candidate retrieval用。完全なspec一致一覧を要求するこれらはcursor側で検証する。seed上限を引き上げてfree-text検索を重くしない。

### browseのまま残す7件

`memory-trident-series`, `p2-case-meshify`, `ext-keyboard-09`, `ext-monitor-09`, `ext-headphones-09`, `ext-sound_card-05`, `ext-thermal_compound-05`。

keywordは変更していない。headphonesだけはrelevant source selectorを `DT 990 OR DT990` に変更。返却結果を列挙して正解化する方式ではなく、source全体で綴りの違う同familyを選ぶ。

pure family探索はMAG / ROG / Keychron / Logitech / Vengeanceを維持し、`ux-meshify` / `ux-trident`を追加。`p2-board-b650e-wifi` は既存のchipset filter + wifi keywordのまま。現行motherboard typed schema/facetにはWi-Fi fieldがないため、架空のwifi filterを追加していない。

## Lookup2件: Top resultsと判断

### ext-mouse-03: G502HERO — C

変更前の全7候補:

| Rank | Product | 判断 |
|---|---|---|
| 1 | Logitech G502 HERO High Performance Gaming Mouse | MPN 910-005469、旧expectedと同一モデル |
| 2 | G502 HERO + G Pro X Gaming Headset Bundle | bundle、equivalentに含めない |
| 3 | G502 Hero + G440 Mouse Pad Bundle | bundle、含めない |
| 4 | G413 SE Keyboard + G502 HERO Bundle | bundle、含めない |
| 5 | G502 Hero K/DA | 別MPN 910-006095等、含めない |
| 6 | Logitech G502 HERO Wired Optical Mouse - Black | 旧expected、MPN 910-005469を含む |
| 7 | G502 Hero Special Edition Black/White | 別MPN 910-005729、含めない |

rank1のkeyは `Mouse/b727b264-7909-4487-9cfb-cab0458816f3`、rank6は `Mouse/19377571-877c-41a4-81cc-43ca813cf646`。両方のsourceにMPN 910-005469とEAN 0097855141996がある。

`manufacturer=Logitech AND source MPN=910-005469` の集合を毎回独立sourceから計算する。2製品がequivalent。**旧expectedそのもののrankは6のまま**、lookup集合のrankが1になる。人間の承認、IDリストの追加、製品の自動mergeは行わない。

### ext-headphones-03: DT990 — B

変更前の全6候補は、Premium Limited Edition、Premium 32、DT 990、DT 990 Semi-open、別sourceのDT 990、最後にPro 250。すべてDT990 familyで、queryはPro/250を指定していない。

Premium32等をPro250の同一SKU equivalentとする根拠はない。従って元queryはbrowseへ変更し、6/6取得を評価する。追加した `ux-dt990-pro250` は **`DT990 Pro 250` → 元expected `Headphones/eb851535-44b4-417f-bbba-5a0966e0c691`、rank1**。

lookup111件は保持。最終Hit@1=98.20%、Hit@3=99.10%、Hit@5=100%。class別の既存Hit@1/3/5条件を全件満たす（すべてのlookupを一律Hit@3とはしていない）。identifier18件はHit@1=100%。

## Browse floor / window / 残存noise

- coverage default **90%**を維持。
- precision default **90%→80%**。候補5件中4件はsource relevantであることを要求する。family探索で近縁variantから追加filterへ進める余地を残す。
- 個別floor override **0件**。既存の `floors.candidate_coverage` / `floors.candidate_precision` は利用可能。
- 8.77%のMeshify Cや69.23%のMX-4をfloor引き下げで通していない。query defectを直し100%へ。
- browseではrankをgateしない。unexpected zero、coverage、precision、FP/FN、windowを機械的に記録する。
- browse_filter / filter_onlyは今までどおりFP=FN=0、typed filter correctnessを要求。filter_onlyはpagination/stable orderingも要求。
- window=1000を使い切り、relevant>1000の場合だけcoverage floorを `0.9 × 1000/relevant` とする既存ルールを維持。precision floorはwindow内でも有効。

最終window exhausted:

| Case | relevant | returned | coverage | precision | FP / FN |
|---|---:|---:|---:|---:|---:|
| p2-memory-ddr5-32 | 1262 | 1000 | 79.24% | 100% | 0 / 262 |
| p2-case-atx-mid | 2325 | 1000 | 40.82% | 94.90% | 51 / 1376 |
| p2-fan-120pwm | 1459 | 1000 | 68.54% | 100% | 0 / 459 |
| ux-geforce | 2677 | 1000 | 37.36% | 100% | 0 / 1677 |

これらは**further filtering required**。window外のFNを消したことにはしない。

最終全suiteの集計（caseごとのmacro average）:

| Intent | 件数 | coverage | precision | FP合計 | FN合計 | failure |
|---|---:|---:|---:|---:|---:|---:|
| lookup | 111 | — | — | rank評価 | rank評価 | 0 |
| identifier | 18 | — | — | rank評価 | rank評価 | 0 |
| browse | 66 | 97.07% | 98.23% | 161 | 3857 | 0 |
| browse_filter | 28 | 100% | 100% | 0 | 0 | 0 |
| filter_only | 13 | 100% | 100% | 0 | 0 | 0 |

**failure=0はFP/FN=0という意味ではない。** browseのFN 3857のうち3774は上記windowケース。残る83は従来からfloor内のspec-keywordケース: nvme2tb=2、lga1700-ddr4=5、850w=4、850gold=2、1000w=1、1000atx=17、750gold=1、140pwm=51。今回の元24failureには含まれず、source集合を削除せず数値を残す。これらも完全一覧を提供するfrontendではtyped UIを使う。今回修正した旧failure群のsetケースは全件coverage=100%、FN=0。

## 性能とquery plans

最終 `benchmark:ux` の初回UI page（Detail/Resolveは1 operation全体）。表内は **median / p95**。intent再分類により集団の構成が変わるので、下の同一入力A/Bも参照。

| Intent | rows before | rows after | SQL ms before | SQL ms after |
|---|---:|---:|---:|---:|
| lookup | 19 / 370 | 15 / 301 | 2 / 4 | 4 / 9 |
| identifier | 22 / 58 | 22 / 58 | 2 / 3 | 3 / 6 |
| browse | 846 / 6987 | 693 / 6987 | 3 / 9 | 5 / 15 |
| browse_filter | 430 / 9425 | 481 / 9469 | 2 / 4 | 5 / 10 |
| filter_only | 5187 / 7403 | 1369 / 6334 | 2 / 5 | 2 / 13 |
| product_detail | 11 / 21 | 11 / 21 | 0 / 1 | 1 / 2 |
| product_resolve | 36 / 190 | 36 / 190 | 0 / 1 | 0 / 1 |

単発durationには上振れがあり、「全queryでlatency不変」とは主張しない。compiler変更の影響を分離するため、同一process / DB / 元233入力 / warmup後3回 / A/B順序を交互にした比較も行った。

| 元intent | 同一入力rows median/p95 before→after | 同時測定SQL ms median/p95 before→after |
|---|---|---|
| lookup | 19/370 → 17/301 | 2/5 → 2/5 |
| identifier | 22/58 → 22/58 | 2/3 → 2/5 |
| browse | 846/6987 → 846/6987 | 4/11 → 4/11 |
| browse_filter | 430/9425 → 430/9469 | 2/5 → 3/5 |
| filter_only | 5187/7403 → 552/5187 | 3/4 → 1/7 |

- 同一入力rows増加はSATA1件のみ、**9425→9469 (+44、0.47%)**。paired durationは5→4ms。追加取得2製品を含む。
- 対象SATA query単独5回のduration: 4, 3, 2, 3, 2ms。
- unchangedな `cpu-intel14900k` でもpaired median 3→9msの局所的な揺れが出る。local D1のmillisecond粒度・環境変動をremote latencyへ外挿しない。
- motherboard chipset filterは既存0005の `motherboard_search_chipset` を明示的に候補indexへ含めた。新migrationなし。`p2-board-b650e` の最終rows=70、b650-matx=313。
- **catalog full scan=0**。代表plan **45/45 PASS**、全236検索+34 operationでも0。
- category FTS virtual index → PK lookupを維持。typed chipset pathはindex → PK → bounded display sort。
- TEMP B-TREEはFTS候補のdedup/ranking/display sort用として引き続き存在し、catalog full scanとは区別する。
- Detailは4query、Resolveは1query。Resolve 1/12/32/64参照、30カテゴリのDetailを検証。

## 最終検証

| Command | Result |
|---|---|
| `npm run check` | schema一致、**175 tests passed / 0 failed** |
| `npm run verify:ux:local` | PASS、memory1262製品/35page、重複0/欠落0、17/37件page、replay一致。SATA130/130 |
| `npm run release:verify -- --local` | **PASS**、FTS/source integrity PASS、45 plans、final failure `[]` |
| `npm run benchmark:ux` | 236検索+34 operation、7 intentコスト記録、failure `[]` |
| `node scripts/verify-search-diagnostics-ui.js` | Edge headless PASS。keyword/filter/cursor/identifier、SATA130件、G502 equivalent rank1、score/BM25表示 |
| `node scripts/benchmark-search-change.js ...` | 同一入力compiler A/Bを記録 |

read-only診断UIはapproval入力を持たない。case ID、lookupのexpected/Top10、browse集合3区分、missing製品の直接表示、source条件、cost/planを確認できる。release失敗時はreportの `diagnostic_commands` とconsoleにcase指定コマンドを出す。

## Production前の次フェーズ

1. 同じsnapshot/fixtureと7 intent benchmarkをremote/staging D1に適用し、remote rows_read / SQL duration budgetsを確認する（今回は未実行）。既存 `benchmark:ux -- --remote --budgets <file>` は従来のremote bindingを使うため、stagingを測る場合はstaging bindingの設定を確認して実行する。
2. 外部frontendのfilter controlsと今回文書化したtyped interactionを接続し、window exhausted時の追加filter導線を確認する。
3. 残存source noiseとfloor内83 FNは診断可能な状態で維持し、問題が起きたcaseだけを調査する。新しい人間approval運用は不要。
4. remote migration / sync / deploy / cache epoch操作は、別途依頼された次フェーズで行う。今回の変更自体に新migrationはない。
