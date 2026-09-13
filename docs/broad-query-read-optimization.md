# Broad-query D1 read optimization — 2026-09-13

## 結果

**候補・順位・scoreを変えず、`ddr5`を35,963→16,568 reads（53.9304%削減）にした。**
29件のbroad corpusは371,744→190,326 reads（48.8019%削減）、120 Goldenはtop20完全一致。

- production: https://pc-parts-catalog.kikuuuty.workers.dev
- 最終version: **`af26291a-eb53-410a-b22a-73a6cef5b49c`**。
- local **161ケースの全候補・全候補score・debug・LIMIT21結果**がBeforeとstrict一致。
- remote **19ケース**（代表broad7＋exact6＋offset6）でも全候補・score・結果がBeforeとstrict一致。
- 最終production **120 Golden top20＝remote direct、120/120**。Hit/MRR/Precision不変。
- `ddr5 <10,000 reads`の理想目標は未達。candidate削減やranking変更で合わせていない。
- **Worker CPUはPOST p50/p95=1/3msを維持したが、maxは7→9ms、別のGET MISSで14ms。最大値までの非悪化は実証できていない。**
- D1 rows_readは削減できたが、SQL duration/HTTP latencyが一律に改善した結果ではない。
- INDEX/migration追加なし。DB size、sync write costの追加なし。**Paid維持推奨は変わらない**。

変更したruntimeファイルは`src/queries.js`だけ。
ranking仕様、BM25 weight、exact/spec/freshness boost、fallback、normalization、FTS projection、Golden/expected、
products/specs/identifiers、Worker API、pagination、Cache API/key/TTL/epoch、rate-limit設定は維持した。

前提の検索仕様は[Phase 1](search-relevance.md) / [Phase 2](search-phase2.md)、
cacheとrate保護は[production cache](production-cache.md) / [production rate limiting](production-rate-limiting.md)。

## Before baseline / corpus

SQL変更前に`319f86c`のエンジンで以下を保存した。

|Artifact（Git外）|内容|
|---|---|
|`.cache/broad-read-before.json`|実local D1、120 Golden＋29 broad＋6 exact＋6 offset＝161ケース|
|`.cache/broad-read-remote-before.json`|実remote D1、broad7＋exact6＋offset6＝19ケース|
|`.cache/broad-worker-before.json`|production POST、同じ13検索を2巡＝26 HTTP、tail照合|

各D1ケースはSQL/params、EXPLAIN QUERY PLAN、rows_read/written、SQL duration、elapsed、returned、
top20 upstream_key、LIMIT21の全列、debug全列、全候補ID/relevance/tier/spec/manufacturer/freshness/score/matchを保存。
result/debug/candidateのSHA-256、エンジン原文・SHA、fixture SHA、sync stateも記録した。
offsetケースには`EXPLAIN`のVM bytecodeも保存した。

主計測は**debugなし・LIMIT21＋bound OFFSET**で、Workerの20件＋lookaheadと同じ条件。
debug取得・全候補診断・plan取得は別SQLであり、その費用を主queryのrows_readへ混ぜない。
remote elapsedはREST往復、Worker CPUはtailのruntime cpuTime。SQL durationと同一視しない。

29 broadは全9カテゴリの自然な検索語を事前固定し、実DBで全て結果を確認した。
各queryの候補数・順位・read costを診断し、診断用の安価/高価という分類を検索条件には使わない。
数十行のmodel、数百〜数千行のfamily/複合query、万行台の広いspec/genericが混在する。

## Root cause

### 1. 同じ候補の繰り返しJOINと一時表走査

変更前は概ね:

```text
strict_fts: FTS + local identifier + trusted identifier + typed補助候補をmaterialize
  ↓
strict: 全hitにproducts/specのPK JOIN、scope、GROUP BY id、materialize
  ↓
ranked: 同じproducts/specを再JOIN、ranking、materialize
  ↓
最終SELECT: 同じproducts/specを再JOIN、ORDER BY score、LIMIT/OFFSET
```

products/spec全表走査はなかったが、**PK lookupでも候補数×繰り返し回数のreadがかかる**。
FTS候補が大きいほど、materializeした一時表の走査も増える。

`ddr5`の実候補:

- 全カテゴリのliteral FTS hits: **3,490**。
- indexed typed補助: **256**（このsnapshotでは全てliteral FTSと重複）。
- UNION ALL直後: **3,746**。
- category/active/spec row/scopeとID重複排除後: **2,661**。
- 最終20件を返しても、2,661件分のrank計算と繰り返しlookupが必要だった。

変更前prefix診断（それぞれ独立した`SELECT * FROM <CTE>`、加算する値ではない）:

|終了段階|結果行数|rows_read|
|---|---:|---:|
|strict_fts|3,746|7,752|
|strict|2,661|19,993|
|ranked / scored|2,661|27,980|
|実際のLIMIT21検索|21|35,963|

### 2. 同一MATCH条件を別tierで再評価

generic single-token等では、namePhrase/nameExact/modelExactのMATCH式が同一になる場合がある。
元のCASEは先勝ちなので、後続の同一条件は到達不能なのに、独立したIN集合を作るplanになっていた。
例として`geforce` / `radeon` / `atx` / `6000`のproduct_fts MATCH plan nodesは**7→5**。
これは実行回数の保証ではなくplanの数で、CASEのshort circuitで実行されないnodeもある。

**`ddr5`自体はspec-onlyでproduct_fts MATCHはもともと1つ**。その改善の主要因をduplicate MATCHとは説明しない。
異なる意味のMATCHは統合せず、spec-onlyでもBM25計算を省略しない。

### 3. OFFSETは候補rank計算を省略できない

VMには変更前後とも`OpenEphemeral`＋`OffsetLimit`＋`IfNotZero`＋`Last/IdxLE/Delete`があり、
最終ORDER BYは**limit+offset件の上位集合を維持するtop-N実装**だった。
「必ず全候補を最終sort表に保存する」のが主要因ではない。
ただし全候補のscore比較は必要であり、ID重複排除用GROUP BYには別の`SorterOpen`が残る。

## Optimization

### Narrow hit aggregation → 1回のPK lookup → 列の引き継ぎ

変更後の基本形:

```sql
strict_fts AS NOT MATERIALIZED (
  -- 従来と同じFTS / local / trusted / typed sources
),
strict AS NOT MATERIALIZED (
  SELECT h.id, h.relevance, 0 AS fallback,
         p.name AS _p_name, /* その他の公開列 */
         s.ram_type AS _s_ram_type /* その他のspec列 */
  FROM (
    SELECT id, max(relevance) AS relevance
    FROM strict_fts GROUP BY id
  ) h
  CROSS JOIN products p ON p.id=h.id
  CROSS JOIN memory s ON s.product_id=p.id
  WHERE /* 従来と同じscope */
),
ranked AS NOT MATERIALIZED (
  -- 既存のranking式を引き継いだ列に対して評価
),
scored AS ( /* 従来のscore計算 */ )
SELECT /* 公開列へ元の名前でprojection */
FROM scored r
ORDER BY r.score DESC,r.id
LIMIT ? OFFSET ?
```

memoryは説明例。全keyword検索に同じ戦略を適用し、query文字列による分岐はない。

- GROUP BYの入力は**id/relevanceの狭い行**。全製品列をGROUP BYの一時sortへ運ばない。
- products/specは重複IDをまとめた後に1回だけ取得し、scope/ranking/結果で共有する。
- `_p_` / `_s_`で内部列名を分離。CPU manufacturerのような同名列も、最終出力では従来のSELECTと同じ順・名前に戻す。
- FTS hit CTEはco-routineへ流し、BM25がFTS cursorの有効なcontext内で評価される構造を保つ。
- **fallbackありの場合はstrictをMATERIALIZED**。scope適用後のstrict-empty判定と返却候補が同じ集合を共有する。
- **debug=trueはrankedをMATERIALIZED**。score/tier/match等の複数debug列でrankingを再評価しない。
- public debug=falseはranked spoolを作らず、ORDER BYに必要なrankingを評価する。
- schema由来の固定projection文字列はmodule内で事前生成。ユーザーqueryや結果を保存するcacheではない。

通常broadのplanは`MATERIALIZE strict_fts / strict / ranked`がなくなり、
小さい`search_input`と`exact_identifiers`のみmaterializeする。`NOT MATERIALIZED`という字面だけでなく実planで確認した。

### 到達不能なCASE条件だけを除去

```sql
CASE WHEN <A> THEN 650 WHEN <A> THEN 600 ... END
```

から後続の`WHEN <A>`だけを除く。strict/fallback**両方**のMATCH文字列が前の条件と完全一致する場合に限定する。
異なる式を文字列正規化で同一扱いしたり、同じ結果になると推測して削除したりはしない。
最初のtier、BM25 weight、加点、計算順はそのまま。

### Identifier lookupの不要経路

既存`searchTerms()`で既に決まっているidentifierKindを使い、対象外形状では空のexact_identifiers CTEにする。
MPN/barcodeの場合は従来と同じtype条件をSQL生成時に選ぶ。trust判定の全カテゴリ・inactive込みdistinct製品数≤3は維持する。
空の経路でもkeyのparameter slotを保持し、後続LIMITや100 bindsの位置を変えない。

## 同値性の根拠とtyped acceleratorの判断

各hit IDに対してproducts.id/spec.product_idはPKで、scope条件はその1組の行だけで決まる。
したがって、scopeを適用してからmax(relevance)を取る処理と、IDごとのmaxを取ってから同じscopeを適用する処理は同値。

```text
GROUP(id, MAX relevance, FILTER(scope, HITS JOIN products JOIN specs))
=
FILTER(scope, GROUP(id, MAX relevance, HITS) JOIN products JOIN specs)
```

同一IDの他列も一意なので、その列を取得し直さず引き継いでも値は変わらない。
typed row欠損・inactive・明示filters/ranges/facets/identifierで除外される集合も同じ。
local identifierの複数hit、FTS＋typed＋trustedの重複でもmax(relevance)を保持する。

typed値を新たなhard filterにする方法は採用しなかった。
名称にDDR5等がありtyped値がNULL/矛盾する製品も従来候補であり、typed indexだけへの置換はその集合を保証できない。
CPU family/chipsetについてもliteral/identifier側を落とさない。**候補集合を減らす必要なくread目標を達成できた**。

### 256件上限の再確認

既存の上限・scope適用位置・index列順を変更していない。

|Query|literal FTS hits（全カテゴリ）|typed補助数|うちliteral FTSにないID|最終候補|
|---|---:|---:|---:|---:|
|ddr5|3,490|256|0|2,661|
|ddr5 6000|844|256|1|845|
|ddr5 32gb|1,243|256|1|1,244|
|am5|307|256|101|401|
|850w gold|291|256|6|296|
|360mm aio|38|256|242|280|
|120mm air cooler|20|138|137|139|
|nvme 2tb|377|256|1|378|

29 corpusのbounded spec seed13件中12件で256に到達。chipset identityは別の既存経路であり256の対象ではない。
`b650e`は既存chipset indexから23 hit、literal FTS41 hit等と統合した候補41件を維持した。
`ryzen 7`は既存literal FTS37件に対するfamily boostで、typed-onlyな全family製品を追加する意味へ変更しない。

このsnapshotの`ddr5`補助候補が全て重複することを理由に、将来も不要とみなして削除してはいない。
`360mm aio`等ではtyped補助がrecallの大部分を担っている。

## Before / After reads

代表7件はlocalとremoteの両方で同じ値を観測した（LIMIT21、offset0）。

|Query|Before rows_read|After rows_read|削減率|
|---|---:|---:|---:|
|ddr5|35,963|16,568|53.9304%|
|ddr5 6000|11,681|5,001|57.1869%|
|ryzen 7|452|193|57.3009%|
|rtx 5080|931|469|49.6241%|
|b650e|791|406|48.6726%|
|850w gold|5,202|2,380|54.2484%|
|360mm aio|3,696|1,694|54.1667%|
|**7件合計**|**58,716**|**26,711**|**54.51%**|

残る22件もlocal D1実測では全て改善した。

|Category / Query|Before → After rows_read|
|---|---:|
|memory / ddr5 32gb|16,469 → 6,996|
|memory / 6000|14,555 → 7,907|
|memory / 32gb|23,297 → 9,922|
|gpu / 5070 ti|955 → 481|
|gpu / radeon|16,015 → 8,023|
|gpu / geforce|43,024 → 21,530|
|cpu / ryzen 9|236 → 103|
|cpu / intel|14,636 → 11,480|
|cpu / amd|7,789 → 6,211|
|motherboard / b650|3,195 → 1,560|
|motherboard / x870e|1,442 → 757|
|motherboard / z890|1,745 → 875|
|motherboard / am5|5,872 → 2,600|
|psu / 850w|6,991 → 3,051|
|psu / 1000w|5,173 → 2,297|
|psu / gold|17,158 → 7,449|
|cpu_cooler / 120mm air cooler|1,876 → 900|
|storage / nvme|18,454 → 7,695|
|storage / 2tb|8,170 → 3,537|
|storage / nvme 2tb|6,195 → 2,784|
|case / atx|83,734 → 50,458|
|case_fan / 120mm pwm|16,047 → 6,999|

### Corpus集計（実local D1）

|指標|Before|After|
|---|---:|---:|
|broad query数|29|29|
|total rows_read|371,744|190,326|
|median / p95 / max reads|6,991 / 43,024 / 83,734|3,051 / 21,530 / 50,458|
|broad total削減率|—|48.8019%|
|Golden query数|120|120|
|Golden total reads（LIMIT21）|262,763|133,986|
|Golden median / p95 / max reads|657 / 7,176 / 30,660|370 / 3,858 / 16,494|
|Golden total削減率|—|49.0088%|

### Exact model regression

|Query|Before|After|順位 / debug / 全候補|
|---|---:|---:|---|
|9800x3d|19|13|同一|
|14900k|49|29|同一|
|285k|19|13|同一|
|990pro|79|43|同一|
|sn850x|103|55|同一|
|rtx5080|931|469|同一|

### OFFSET

`ddr5 offset=0/20/40/60/80/100`は、全6ケースで**35,963→16,568 reads**。
各pageのLIMIT21行とdebug値が一致。6 page合計は215,778→99,408 reads。
score計算対象2,661件は同じなので、offset間のread量が同じである性質は残る。
APIのlimit、offset、lookahead、returned、has_more、next_offset、window_limit/window_exhaustedは変更していない。

## Quality / invariance / tests

|指標|Before＝After|
|---|---:|
|Hit@1|98.33333333%|
|Hit@5 / Hit@10|100% / 100%|
|MRR|0.9895833333|
|Precision@5（44件）|98.18181818%|
|Precision@10（44件）|98.63636364%|
|Zero / failed queries|0 / 0|
|Golden top20 exact equality|120/120|
|全候補＋全score＋debug strict equality（local）|161/161|
|同一remote内strict equality|19/19|

local full FTS 29,599文書・全列のfingerprintも既存canonicalと一致:
`53f62a6f47d6eeb9869c57429f8552235faf2224f05e900c7e0e25142d082f22`。
今回D1に送った変更用DDL/DMLは0。カタログsync/FTS再構築も行っていない。
local/remote間の浮動小数bit一致は従来同様保証しないが、**それぞれのruntime内Before/Afterでは丸めずstrict比較**した。

成功したlocal gate:

- `npm test` / `npm run check`: **84 tests**（既存81＋今回3）、schema generator一致。
- `npm run verify:plans`: **37/37**。従来28＋broad/index/cross-category/listing 9パスを追加。
- 161ケースのEXPLAINでproducts/spec全走査0、候補/全debug/結果の一致。
- 120 Goldenの通常benchmarkでHit/MRR/Precision summary全体が保存済みbaselineとdeep equality一致。

`test-support/search-read-before.js`は旧SQL構造の独立oracle。valid input用にvalidation boilerplateだけ省略し、
変更していないmodel/grammar helperを共有する。旧SQL/paramsは161ケースで変更前artifactと照合した。
synthetic DBでNULL/矛盾spec/typed row欠損/inactive/複数local identifier/共通・typed同名列、
300件超のtyped seed、late scoped match、family/freshness、strict/fallback、explicit order、offset0/20/100、100 bindsを比較。
full scan、FTS virtual index、不要なranked/strict_fts materializeと最終再JOINも検出する。
1行しかないtyped tableのscanをSQL回帰と誤認しないよう、plan testには複数のtyped値を持つデータを用意している。

## Remote duration / Worker CPU

### Remote direct（各1回、REST往復を含む）

|Query|SQL ms Before → After|REST elapsed ms Before → After|
|---|---|---|
|ddr5|180.56 → 180.11|347.85 → 374.29|
|ddr5 6000|24.47 → 20.80|199.49 → 188.12|
|ryzen 7|11.76 → 18.32|200.80 → 191.34|
|rtx 5080|46.92 → 55.80|229.16 → 233.02|
|b650e|21.59 → 26.52|211.17 → 215.21|
|850w gold|89.49 → 102.62|271.05 → 288.91|
|360mm aio|45.47 → 52.74|232.04 → 249.19|

異時刻の小標本で、query preparation/通信/DB状態も含む。read削減をSQL処理時間の短縮と同一視しない。
local broadの単回SQL p50/p95/maxも7/18/19→9/24/34msだった。
中間実装のold/new交互3回測定ではddr5の中央値11→11ms、ddr5 6000は11→5ms。
この交互測定は最終duplicate-MATCH折り畳み前の参考であり、最終値へ置き換えていない。

### Production POST: 同じ13 query × 2巡

3.5秒間隔、POST limit20/offset0、すべて既存のno-store/BYPASS経路。rate limiterは有効のまま。

|指標|Before|最終After|
|---|---:|---:|
|HTTP requests / 200 / 429|26 / 26 / 0|26 / 26 / 0|
|D1 queries|26|26|
|rows_read|119,832|54,666|
|全本文一致|—|26/26|
|Worker CPU p50 / p95 / max ms|1 / 3 / 7|1 / 3 / 9|
|2巡目CPU p50 / p95 / max ms|1 / 3 / 3|1 / 2 / 2|
|Worker elapsed p50 / p95 / max ms|94 / 111 / 120|87 / 135 / 465|
|D1 SQL p50 / p95 / max ms|7.61 / 29.94 / 32.97|8.72 / 41.23 / 42.95|
|HTTP p50 / p95 / max ms|125.26 / 143.32 / 151.11|117.99 / 176.63 / 496.86|

初回実装ではCPU=3/6/11msの増加を観測したため、固定projectionの事前生成とspec-only時の不要なMATCH句生成省略を追加した。
この変更の**生成SQL/paramsは検証済み161ケースと完全一致**（`broad-compiler-invariance.json`）。
再測定でPOST p50/p95は元に戻ったが、最大値までの非悪化は実証できていない。
最大HTTP値496.86msも除外していない。原因をcold isolateと断定しない。

### GET / cache / production Golden

- 代表7 queryのcold GET→repeat: **7 MISS / 7 HIT、200=14、429=0**。
- MISS合計26,711 reads。各MISSが新SQLのremote direct metadataと同じread値。
- HITはD1=0、rate_limit_status=not_checked、Before POSTと全本文一致。
- GET14件のCPU p50/p95/max=4/14/14ms、HIT7件は2/4/4ms。
  以前のmixed HIT 1/2/3msとはquery分布・標本数が異なり、非悪化を断定しない。**Free 10ms問題は残る**。
- 既存`verify:api --paced --golden --golden-only --cache-repeat`も成功。
  120 queryのHTTP top20＝remote direct、保存済みtop10/expected rank一致、GET119のrepeat HIT、POST1のrepeat BYPASSを確認。
  health/categories/advanced POSTも正常。benchmark用bypassやlimiter停止は使っていない。

## Migration / size / deployment

|項目|Before|After / 追加cost|
|---|---:|---:|
|Local DB size|138,653,696 bytes|138,653,696 bytes|
|Remote DB size|141,815,808 bytes|141,815,808 bytes|
|新INDEX / migration|—|なし|
|migration rows_written / duration|—|0 / 実行なし|
|追加sync insert/update write cost|—|0|

両deployで既存predeployを通過: 0001〜0006、sync complete、active29,599、FK0、lease0、cache epoch valid、rate bindings一致。
最終bundle45.46KiB、gzip13.64KiB、startup20ms。startup時間はinvocation CPUとは区別する。
Worker/cache/rate-limit本体とwrangler.jsonは変更していない。新SQLでも結果同一を確認できたため、cache epoch/schema keyも維持した。

初回SQL最適化deployは`1fb7dfd0-1a1d-41a4-a1a9-2aa090947864`、固定SQL片の事前生成を追加した最終版は冒頭のversion。
remote Before開始時のREST 403はwhoamiによる認証確認後に解消。失敗runはbaselineへ含めていない。
最終CPU測定も一度tail event欠落で失敗し、部分runは`broad-worker-final.json`へ残した。
後続の全26件照合runを`broad-worker-final-complete.json`へ別保存し、欠落を0 CPU/0 readsに置換していない。

## Free D1 5M/dayの再試算

既存mixed100の各queryを今回の実SQL readで置き換えると、cacheなし合計は**349,020 reads**、平均**3,490.2 reads/query**。
Beforeは753,939、平均7,539.39だった。
独立したhit確率の仮定では`mean_reads = 3,490.2 × (1-hit率)`。

|Hit率の仮定|After平均reads/HTTP|5M相当 Before検索/日|5M相当 After検索/日|
|---|---:|---:|---:|
|0%|3,490.20|663|1,432|
|50%|1,745.10|1,326|2,865|
|80%|698.04|3,315|7,162|
|90%|349.02|6,631|14,325|
|既存実測のquery別64 HIT / 36 MISS分布を再利用|242.41|9,888|20,626|

最終行は独立モデルと違い、**高costの人気queryがより多くHITする実測分布**。
今回のSQL costをその分布に再生した計算で、最適化後に100 HTTPを再実測した値ではない。
同じHIT分布ならmixedのD1 readsは50,564→**24,241**。現在のtrafficの将来値を保証しない。

全read枠を検索だけに割り当てた試算。管理/health/sync/監査/他DBの余裕を差し引く。
例えば最終行で検索に半分の2.5Mを割り当てれば約10,313検索/日。
Workers 100k requests/dayより先にD1 readが制約になる分布だが、別のquery構成では変わる。

**Freeへ戻す判断は改善したが、当面Paid維持を推奨**。
DB約135.25MiBはFree 500MB/DB内で追加write負担もない一方、CPU14ms、未観測の実traffic、差分syncのwrite量、
coloごとのcache、unique/POST/deep pages、stampedeが残る。
Rate LimitingのFree可否は前タスクの「要再確認」を引き継ぐ。colo-local / eventually consistentで、
5M/dayの正確な課金quotaではない。FreeはD1 hard daily limit、Paidはusage/billing alerts等を併用する。
プラン設定は変更していない。

## 再現コマンド / artifacts

`.cache/`を用意し、writer停止・read予算確保の上で実行する。Beforeファイルは新エンジンで上書きしない。

```sh
# 旧エンジンで固定したBefore（実施済み）
node scripts/measure-broad-read.js --output .cache/broad-read-before.json
node scripts/measure-broad-read.js --remote --sample-only --output .cache/broad-read-remote-before.json
node scripts/measure-broad-worker.js --phase before

# 最適化後
npm run check
node scripts/measure-broad-read.js --compare .cache/broad-read-before.json --output .cache/broad-read-after.json
npm run verify:plans -- --summary-only --output .cache/broad-plans-local.json
npm run benchmark:search -- --summary-only --output .cache/broad-quality-after.json
node scripts/analyze-broad-candidates.js
node scripts/verify-broad-compiler.js
node scripts/measure-broad-read.js --remote --sample-only --compare .cache/broad-read-remote-before.json --output .cache/broad-read-remote-after.json
npm run worker:deploy
node scripts/measure-broad-worker.js --phase after --compare .cache/broad-worker-before.json --output .cache/broad-worker-final-complete.json
node scripts/verify-broad-cache.js
# HTTP検証同士はresource budgetが落ち着くまで60秒以上あける
npm run verify:api -- --url https://pc-parts-catalog.kikuuuty.workers.dev --remote --golden --golden-only --cache-repeat --paced --baseline .cache/search-fts-remote-after.json --output .cache/broad-api-golden.json
node scripts/report-broad-read.js
```

`.cache/broad-read-analysis.json`には旧pipeline段階別costとmaterialization hintだけ変えた試行、
`broad-candidate-analysis.json`にはtyped寄与・FTS fingerprint・sort bytecode、
`broad-read-summary.json`にはquality照合・read削減・CPU・Free試算を保存する。
SQL/paramsを含む診断artifactはGit外。production structured logやAPIへSQL/debug/keywordを追加しない。

## Remaining issues

1. **CPU/latencyの実traffic観測**: POST p50/p95は維持できたが最大CPU非悪化は未証明。GET MISS14ms、HTTP外れ値も残る。
2. **production stampede**: 前タスクのcold6並列＝6 D1問題は残る。同じ回数なら単価は下がるが、collapsingの解決ではない。
3. **Workers Cache移行**: request collapsing、HEAD契約、canonical validation、gateway/inner entrypointを別途評価。
4. **rate limit tuning**: 今回はthreshold/classifierを維持。新read単価と実trafficを観測してから調整する。
5. **sync＋epoch deploy自動化**: complete/readiness/quality確認との連携。
6. **Phase 3 fuzzy search**: 現品質・cost baselineを新しい比較元にする。
7. **cursor pagination**: offsetごとの全候補rank再評価は残る。API契約変更として別途設計。
8. **さらに低いbroad reads**: ddr5は依然16,568、case/atxは50,458。候補集合同値を保つ追加のaccess-path最適化を検討し、typed hard filterや無根拠truncateにはしない。

Contains information from [BuildCores OpenDB](https://github.com/buildcores/buildcores-open-db),
made available under [ODC-By 1.0](https://opendatacommons.org/licenses/by/1-0/).
