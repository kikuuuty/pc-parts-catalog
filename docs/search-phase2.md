# Phase 2: category-aware spec relevance

既存`searchQuery()`、FTS5、D1 bindingの延長として実装する。
`src/search-intent.js`はquery専用parserであり、カタログnormalizer・製品・identifier・補完データを変更しない。
評価のclass/suite/expectedは検索コードへ渡さない。

## 解釈する表記

|Category|明確な表記|既存フィールド|
|---|---|---|
|Memory|32GB、64GB、DDR5、6000MHz、6000MT/s、CL30|capacity_gb、ram_type、speed、cas_latency|
|GPU|16GB、32GB|vram_gb|
|Storage|1TB、2TB、1.2TB、32GB、NVMe|capacity_gb、nvme|
|PSU|850W、1000W、80+ Gold / Gold等、ATX/SFX等|wattage、efficiency_rating、form_factor|
|Case Fan|120mm、140mm、PWM|size_mm、pwm|
|CPU Cooler|360mm AIO、360 AIO、120mm air cooler|water_cooled、radiator_size_mm / fan_size_mm|
|Motherboard|AM5、LGA1700、ATX、Micro-ATX/mATX、Mini-ITX、DDR4/5|socket、form_factor、ram_type|
|Motherboard|B650E、X870E、Z890等のchipset形状|chipset（モデルidentityとして評価）|

- NFKCを維持。単位の前に空白があっても認識する。StorageのTBは既存DBと同じ十進で1TB=1000GB。
- MemoryのGBは**キット合計容量**。`2x32GB`というmodule表記を合計32GBと取り違えない。
- 単位なしmemory speedは、DDR/CLという文脈があり、1600～12000の100刻みの場合だけ解釈する。
  `6000`単独や、`5080`、`990`、`285`、`14900`はspecへ変換しない。
- 単位なしradiator sizeはAIO/水冷という明示的文脈内の標準サイズだけ。
  CPU Coolerの`360mm`単独は高さかradiatorか曖昧なのでtyped寸法に変換しない。
- 1つのfieldへ矛盾した値（例: `32gb 64gb`、`air aio`）を指定した場合は、勝手に一方を採用せずliteral検索に戻す。
- `gskill`は既存ブランドG.Skillの句読点省略として`g.skill`へ展開する。
  大規模な同義語・typo辞書は導入しない。
- `psu`、`fan`、`cooler`というカテゴリ名は、そのカテゴリで他のspecを解釈できた場合だけ除く。
  `Cooler Master`のブランド名は除かない。
- WiFiはtyped boolean列がないのでliteralな検索語のまま。CPU CoolerのAM5はkeywordからfacetへ変換しない。

## 候補の取得とspec boost

### モデル＋spec

`990 pro 2tb`は`990 pro`をモデル側のAND条件として残し、capacity=2000をspec signalにする。
モデル候補を先に取得し、その中でspecが一致する製品を上位へ出す。
別モデルの2TB SSDが容量一致だけで候補に入ることはない。
候補のNULL specをWHEREで一律除外せず、既知一致 > 不明 > 既知不一致の弱い加点で扱う。

したがって、`990 pro 2tb`では2TB製品の下に1TB/4TBの同モデルも残る。
容量を厳密に限定したい場合は従来の明示的`filters`/`ranges`を使う。

### Spec-only、広いメーカー/シリーズ語＋複数spec

名前にunitがない製品も、既存typed値が一致すれば補助候補として取得できる。

1. 元のliteral FTS一致を保持。
2. 対応する左端INDEXがある場合だけ、typed条件を満たす補助候補を追加。
3. 補助取得は**category/active/明示的filters/ranges/facets/identifierの適用後、最大256件**。
4. INDEX列順＋product IDで候補選択を決定的にし、全カテゴリのランキングへ拡張しない。

数字を含まないメーカー/シリーズ語に複数specが付いた検索も、十分なINDEXがあればこの方式を用いる。
例えば`asus am5 atx`をメーカー語だけで全製品へ展開する代わりに、literal一致＋indexed spec/ASUS一致を取得する。
補助経路でも、残った未解釈語はすべてFTS ANDで要求する。
FTS照合のID集合は一度作り、型付き候補ごとに同じ複数語MATCHを再実行しない。

上限は**追加のtyped補助経路だけ**。従来のliteral FTS集合やexact identifier候補を256件へ切り捨てない。
これは候補数・費用を制御するためのrecall上限で、typed-onlyな全一致製品の列挙を保証するものではない。
対応INDEXがないspec-only（例: Goldだけ）はliteral FTSを候補として、specを順位付けに利用する。

## Model / family / manufacturerの優先度

Phase 1の完全一致・prefix・フィールド別tierを維持し、次を追加する。

- 明確なCPU family語（Ryzen 7、Ryzen 9、Core i7、Core Ultra 9等）に対する`family`一致。
- Motherboardのchipset tokenに対する`chipset`完全一致。
  `B650-E`という製品名と`AMD B650E`というchipsetは同一とは限らない。
  chipsetsはメーカーprefix付き/なしの完全値をINDEXで照合し、nameだけの前方一致より強く扱う。
  残りのWIFI、メーカー、モデル語もFTS ANDで要求する。
- query内でmanufacturer全体が一致した場合の小さな加点。
  Phase 1のmanufacturer column weightを維持し、その完全一致を補強する。

`exact name / trusted identifier / model tier`の差は、spec・manufacturer・freshnessの合計で逆転しない。
spec-only検索では名称に単位があるかどうかのtier差を付けず、typed一致を優先する。
明示的`orderBy`は従来どおり優先される。

## 弱いfreshness

**明確なCPU family queryだけ**を対象に、同じ強いfamily一致の中でrelease_yearを弱く評価する。
GPU、Memory、Storage等へ一律にrelease_year順を適用しない。generationの桁数をカテゴリを跨いで比較することもしない。

- release_yearがNULLなら中立（score 0）。古い年への代入や年の推測はしない。
- 既知の年は固定の基準年からの差を小さな上下限内へ圧縮する。
  NULLは既知の古い製品より上になることもあり、「NULL=最古」の扱いではない。
- queryにexact modelが含まれる場合は適用しない。
- 壁時計に依存しないので、同じDB・同じqueryの結果は日付が変わっても同じ。

これは最新世代・最適プラットフォーム・推奨CPUの判定ではない。
新しいrelease_yearを持つ旧プラットフォームのrefresh SKUが上位になる場合もある。

## Debug

```sh
npm run search -- --category cpu --keyword "ryzen 7" --verbose
npm run search -- --category storage --keyword "990 pro 2tb" --verbose
npm run search -- --category motherboard --keyword "b650e wifi" --verbose
```

既存の`search_score`、`search_match`、`search_fts_relevance`に加え、debug時だけ
`model_score`（一致tier）、`spec_score`、`manufacturer_score`、`freshness_score`、`search_fallback`を返す。
`family-chipset`、`spec-intent`というmatch typeも追加した。具体的な数値は内部実装用で固定API仕様ではない。

## D1 / migration / performance

`0005_spec_search_indexes.sql`は以下4 INDEXの追加だけ。

- `memory_search_capacity(capacity_gb,ram_type,speed,cas_latency,product_id)`
- `memory_search_speed(speed,ram_type,cas_latency,capacity_gb,product_id)`
- `motherboard_search_chipset(chipset,product_id)`
- `cooler_search_fan(fan_size_mm,water_cooled,product_id)`（fan_size_mmがNULLでない行）

既存のPSU wattage、Storage capacity、Fan size、Cooler radiator、Motherboard socket等のINDEXを再利用する。
FTSの再構築、upstream再取得、再同期、製品値の変更は不要。
bindは引き続きquery JSONとidentifier keyの2個で、scopeを番号付きparameterで共有し、100個上限を維持する。
spec/identityの列名はparserのallowlistと`models`で制限し、ユーザー文字列をSQL列名へ挿入しない。

FTSとtyped INDEXの候補→products/spec PKという経路でランキングする。
補助取得に上限を付けても、literalな広いFTS queryは多数候補を返すため、すべての検索費用が一定になるわけではない。

評価定義は[search-evaluation-phase2.md](search-evaluation-phase2.md)、実測は[search-quality-phase2.md](search-quality-phase2.md)。
