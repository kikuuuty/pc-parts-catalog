# Phase 2 evaluation contract

## 検索実装変更前の固定

2026-09-12、ローカルD1の29,599 active製品を、検索結果の順位を使わず
`loadQualityCatalog()`で読み、各selectorの一致集合とサンプルの名称・メーカー・typed specを確認した。

- BuildCores: `eec0df175504ebd15f0f3e3a8249a18a22f00940`
- catalog: `614b8b834cdcf9839fa6fd77d4ecc8c511c023b1b3852a65a91b98038eada57f`
- 拡張fixture hash: `68d4f73da2ba143c06b5307cd84b97cb232db6489fbcee77b94e9974d925bfb7`
- 検索変更前engine `src/queries.js`: `1d42ffa87a77ec719340cb30dbee841d8712e1726c7d5567f272b2e713b4e3ff`

既存`search-benchmark.json`の40件はbyte単位で不変。追加ラベルは別ファイル
`search-regression-labels.json`に置き、query/expectedを上書きできないloaderとテストで保護する。
新規80件は`search-phase2.json`。検索調整開始後はこの3ファイルを固定する。

|Category|既存＋新規|
|---|---:|
|CPU|18|
|GPU|18|
|Memory|15|
|Storage|14|
|Motherboard|14|
|PSU|10|
|Case|9|
|CPU Cooler|11|
|Case Fan|11|
|合計|120|

suiteは**regression 40 / development 52 / holdout 28**。
developmentは実装調整に使用し、holdoutの個別順位・失敗ケースは実装確定後に評価する。
holdoutも同じDBの事前に確認した製品群から設計したため、未知のカタログに対する検証ではない。
既存regressionやdevelopmentと同じモデルの別spec条件も含む。製品familyを完全分離したholdoutではない。

## Expected集合の意味

従来のUUID/MPN/単一名称selectorはそのまま。複数製品に一致する従来selectorの曖昧性エラーも維持する。
新しい明示的な集合selectorは、**benchmarkだけ**で評価する。

```json
{"set":{"fields":{"product.manufacturer":"AMD","spec.family":"Ryzen 7"}}}
```

- `fields`: `product.*` / `spec.*`の既存schema列への型付き完全一致。配列値は同じ列内のOR、列間はAND。
- `nameContains`: NFKC/空白整理/小文字化した名称へのAND部分一致。
- `nameTokens`: 名称の文字/数字tokenの完全一致。例えばH7からH700を除外する。
- 条件はすべてAND。集合は指定categoryのactive製品だけから作る。
- field名・型を検証し、未知列や文字列での数値指定、空selectorを不正fixtureとして検出する。
- NULLは数値や文字列と一致しない。typed specを期待値とした場合、表示名と矛盾するレコードもtyped値を評価基準にする。
  これは公式仕様の正しさを証明するものではない。CPU Coolerの120mm airは高さではなく`fan_size_mm=120`を意図する。
- WiFiのtyped列は存在しないため、board WiFiはchipsetと名称中のWIFIを根拠にする。
  WiFiのない型番から無線機能を推測することはしない。
- broad familyは世代を限定しない。新しさによる順位変更はtop 5と合成テストで別途確認する。
- G.Skillの句読点省略、AIO/airとtyped cooling type、単位付きspecは検索入力の一般表記として設計した。

## 実DBの根拠例

|Query意図|selectorで確認した製品数|根拠例|
|Ryzen 9 family|19|AMD Ryzen 9 3900XT / 7900等、`family=Ryzen 9`|
|B650E|23|Gigabyte B650E AORUS TACHYON / ASUS ROG STRIX B650E-F、`chipset=AMD B650E`|
|B650E WiFi|12|上記chipset＋名称WIFI|
|AM5 ATX|239|`socket=AM5` AND `form_factor=ATX`|
|990 PRO 2TB|2|Samsungのheatsinkあり/なし、`capacity_gb=2000`|
|SN850X 2TB|2|WD Blackのheatsinkあり/なし、`capacity_gb=2000`|
|DDR5 6000 CL30 32GB|143|Corsair Dominator / Kingston FURY / ADATA XPG等、4つのtyped値が一致|
|850W Gold|298|Seasonic / PowerSpec / Rosewill等、`wattage=850`、`efficiency_rating=80+ Gold`|
|360mm AIO|518|Thermalright / Lian Li / Antec等、`water_cooled=1`、`radiator_size_mm=360`|
|120mm air cooler|138|TRYX TURRIS / NZXT T120等、`water_cooled=0`、`fan_size_mm=120`|
|120mm PWM fan|1,459|`size_mm=120` AND `pwm=1`|

全120件の一致集合、ID、サンプルとspecは`.cache/phase2-fixture-evidence.json`に保存。
確認スクリプトは`node scripts/inspect-search-phase2.js --fixtures`。
検索baseline採取前のレビューでNH-D15Sを含めない名称条件とH700を含めないH7 token条件を確定した。

## Metrics

Hit@1/5/10、全順位MRR、0件検索、既存failure classificationを維持する。
queryの`class`と`suite`は任意の追加metadataで、従来fixtureも指定可能。

`acceptable`を明示した広いqueryにはPrecision@5/10を追加する。
分母は常にKで、未充足の枠は非適合。空結果なら0。summaryは対象queryのmacro平均。
少数製品のexact queryは原則precision評価を付けず、対象母数を`precision_query_count`に明示する。
新規の広いspec-only検索にもprecisionを付け、`broad` class限定の値は`by_class.broad`で別途確認する。

```sh
npm run benchmark:search -- --suite regression
npm run benchmark:search -- --suite development
npm run benchmark:search -- --suite holdout
npm run benchmark:search -- --suite new
npm run benchmark:search -- --class broad
npm run benchmark:search -- --fixture test/fixtures/search-benchmark.json
```

既定は全120件。`--fixture`指定時はそのファイルだけを読み、追加ファイルを暗黙に混ぜない。
`--summary-only`は個別順位を表示せず集計だけを表示する（JSON artifactには全詳細を保存）。
