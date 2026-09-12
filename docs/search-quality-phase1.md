# Search quality Phase 1 — 2026-09-12

## 同一DB・同一Golden Queryでの比較

Node v24.16.0、Wrangler 4.131.1、WindowsのローカルD1 bindingで測定した。
実装前に既存benchmarkを実行し、[baseline](catalog-quality-baseline.md)と同じ結果を確認した。

- BuildCores commit: `eec0df175504ebd15f0f3e3a8249a18a22f00940`
- 製品数 / active: **29,599 / 29,599**、normalizer version **1**
- Before/Afterのcatalog SHA-256: `614b8b834cdcf9839fa6fd77d4ecc8c511c023b1b3852a65a91b98038eada57f`
- Before/AfterのGolden fixture SHA-256: `3e2fec360c8051c375ec4091783b88dc09997da834c44979f05effaf86e64bc8`
- Before `src/queries.js`: `baf3b1bd883261058e08d859450eb5f15f154d26a71acd9e8a7b7dc0195f3993`
- After `src/queries.js`: `1d42ffa87a77ec719340cb30dbee841d8712e1726c7d5567f272b2e713b4e3ff`

カタログ指紋とfixture指紋の一致を比較スクリプトでも検証した。
製品・スペック・identifierの値、upstream、local enrichment、重複レコードを変更していない。
Golden Queryの期待値も変更していない。

|指標|Before|After|
|---|---:|---:|
|Golden Query / scored|40 / 40|40 / 40|
|Hit@1|87.5%（35/40）|**97.5%（39/40）**|
|Hit@5|92.5%（37/40）|**100.0%（40/40）**|
|Hit@10|95.0%（38/40）|**100.0%（40/40）**|
|MRR|0.8958333333|**0.98125**|
|Zero results|2|**0**|
|MISSING_PRODUCT|0|0|
|NO_SEARCH_MATCH|2|0|
|RANKING_FAILURE（11位以下）|0|0|
|EXPECTED_DATA_INVALID|0|0|

40ケース中、期待集合の最初の一致順位が悪化したものは**0件**。
従来1位の35ケースはすべて1位を維持した。
この指標は広い検索では「許容集合の最初の一致」を評価し、全結果のprecisionを保証するものではない。

## 主要ケース

広い型番/シリーズ検索の順位は最初の適切な候補。`gaming x trio 5080`は既存fixtureの特定OC製品を評価する。
候補数は追加測定のLIMIT 100で確認した（今回、表に掲載する件数はすべて100未満）。

|Query|Before|After|確認結果|
|---|---|---|---|
|`14900k`|14900Kが3位|**1位**|KF → KS → Kから、K → KS → KFへ|
|`14900ks`|14900KSが1位|**1位**|variantにKSとある14900Kは2位のまま|
|`9800x3d`|1位|**1位**|AMD Ryzen 7 9800X3D|
|`285k`|1位|**1位**|Intel Core Ultra 9 285K|
|`990pro`|0件|**6件、適切な候補が1位**|Samsung 990 PRO系|
|`990 pro`|6件、1位|**6件、1位**|compact入力と同じ6製品を取得|
|`rtx5080`|14件、1位|**77件、1位**|identifier内の連結表記だけに依存しなくなった|
|`rtx 5080`|77件、1位|**77件、1位**|両入力でRTX 5080系を取得|
|`ryzen 7`|Ryzen 7が6位|**1位**|変更後37件。先頭はRyzen 7 1700X|
|`gaming x trio 5080`|0件|**4件、期待OC製品は4位**|controlled fallbackで回収|
|`sn850x`|8件、1位|**8件、1位**|WD Black SN850X系|
|`sn 850x`|0件|**8件、1位**|compact入力と同じ8製品を取得|

`990pro` / `990 pro`の変更後先頭は`Samsung 990 Pro 2TB SSD M.2-2280 PCIe 4.0 x4 NVMe`。
`rtx5080` / `rtx 5080`の変更後先頭は`ASUS PRIME GeForce RTX 5080 16GB GDDR7`。
対象製品がDBに存在しないケースは上記にはなかった。

### 残るHit@1未達

`gaming x trio 5080`の変更後順位:

1. MSI GeForce RTX 5080 16G GAMING TRIO WHITE
2. MSI GeForce RTX 5080 16G GAMING TRIO GDDR7
3. MSI GeForce RTX 5080 16G GAMING TRIO OC WHITE
4. **MSI GeForce RTX 5080 16G GAMING TRIO OC**（fixtureの期待製品）

入力からOCやWHITEの優先意図を決める一般規則は今回導入していない。
残りtokenは全製品名に一致し、BM25のフィールド内出現・文書長により上記の順になる。
このケースを1位にするための特例や期待値の拡大は行っていない。

## パフォーマンスとINDEX

`npm run verify:plans`は**17/17成功**。従来12件の検証に、型番exact、compact、短いfamily数字、
fallback、keyword identifier boostの5件を追加した。

- FTS5の`VIRTUAL TABLE INDEX ...:M6`を利用する。
- keyword候補からproducts/specを`INTEGER PRIMARY KEY (rowid=?)`で引く。
- identifierは既存`upstream_identifier_exact` / `local_identifier_exact`を利用。
- 新しい通常B-tree INDEXは追加していない。検索専用FTS列とinverted indexを拡張した。
- products/specの全走査は17代表クエリ・追加12ケースとも**0件**。
  `SCAN product_fts VIRTUAL TABLE INDEX`、`SCAN strict/ranked`などの候補集合走査は全products走査ではない。
- 候補のGROUP BY、relevance ORDER BYの一時B-treeを利用する。

開発中にfallbackのJOIN順で全products/spec走査が発生したため、候補起点のCROSS JOINへ修正した。
最終のfallbackは`rows_read=59`。この全走査を再発させないチェックをverify:plansに含めた。

### 読取コストと時間

|測定|Before|After|
|---|---:|---:|
|40 benchmarkの検索elapsed合計|3,000.2 ms|2,958.3 ms|
|同elapsed中央値|76.28 ms|74.99 ms|
|同elapsed最大|87.61 ms|85.95 ms|
|40 benchmarkのrows_read合計|4,482|**15,441**|
|追加12ケースのD1 meta.duration中央値|1 ms|2 ms|
|同最大|4 ms|7 ms|

検索時間はローカルbindingとの往復時間を含む。単回のBefore/After測定であり、速度向上を主張するものではない。
ローカル観測では著しいレイテンシ悪化はなかったが、**ランキング評価・候補増加により読取量は約3.45倍**になった。
リモートD1のレイテンシ・課金量は未測定。

追加主要ケース（LIMIT 100）のrows_read:

|Query|Before|After|
|---|---:|---:|
|`14900k`|13|48|
|`990pro`|2（0件）|78（6件）|
|`990 pro`|37|90|
|`rtx5080`|57（14件）|930（77件）|
|`rtx 5080`|309|930|
|`ryzen 7`|437|450|
|`gaming x trio 5080`|2（0件）|59（4件）|

verify:plansの既存「RTX 5080＋GPU filters」（LIMIT 20）は222 → 650行。
他のキーワードなし代表クエリのINDEXとrows_readは従来値を維持した。

## MigrationとDBサイズ

追加migration: `migrations/0004_search_relevance.sql`。
既存DBへの適用がローカルD1で成功。既存FTS textと保存済み製品/分類列だけから再構築するため、
upstream再取得・全製品再同期は不要。既存0001～0003は変更していない。

|D1 meta.size_after|Before|After|増分|
|---|---:|---:|---:|
|bytes|130,990,080|138,330,112|**7,340,032（7 MiB、約5.6%）**|

これはmigration完了後のD1サイズであり、退避テーブル・WALを含む適用中のピーク使用量ではない。
変更取込では検索フィールドのFTS UPDATEが1回増える。既存のrows_writtenベースのsync予算制御を維持する。

## 回帰テスト・実行したコマンド

`test/search.test.js`に実DB不要の8テストを追加し、合計**35テスト成功**。
主要モデル・未収録モデル、名称とvariant矛盾、compact/空白/ハイフン/NFKC、自然言語の非compact化、
短い数字、identifier頻度、fallbackの抑止条件・scope・ページング、stable tie、100 binds、
既存DB migrationでのデータ不変性、後続syncとロールバックを検証した。

```sh
# 実装変更前に実行済み
npm run benchmark:search -- --output .cache/search-before-phase1.json
node scripts/measure-search-phase1.js before

# 変更後に実行済み
npm run db:migrate
npm test
npm run check
npm run verify:plans
npm run benchmark:search -- --output .cache/search-after-phase1.json
node scripts/measure-search-phase1.js after
```

すべて成功。最後のスクリプトは主要ケースの順位・EXPLAIN・D1メトリクスを保存し、
Before/Afterの指紋一致を確認して比較JSONを生成する。

Git管理外の測定結果:

- `.cache/search-before-phase1.json` / `.cache/search-after-phase1.json`
- `.cache/search-cases-before-phase1.json` / `.cache/search-cases-after-phase1.json`
- `.cache/search-phase1-comparison.json`
- `.cache/query-plans.json`

## 残った問題

- `gaming x trio 5080`の特定OC製品は4位で、Hit@1未達。
- broad family検索には新しさの優先を設けていない。`ryzen 7`の先頭は1700X。
- 空白付き入力の元のAND条件とcompact入力のphrase展開では、一般に候補集合・細かな順位が異なる可能性がある。
- 型番形状の対象外、複数の余分な語、複数文字の誤語、typo、任意の略称には対応しない。
- 元データのvariant/メーカー不整合や低品質MPNは残る。検索で低く扱ってもデータの正誤判定にはならない。
- identifierの簡易形状/頻度判定はcheck digitや出典の検証ではない。
- local identifierと製品名を跨ぐ複数語検索は従来どおり非対応。
- カタログ全走査は回避したが、複数のFTS評価と順位付けでread/writeコストは増える。

検索仕様は[search-relevance.md](search-relevance.md)。
Contains information from [BuildCores OpenDB](https://github.com/buildcores/buildcores-open-db),
made available under [ODC-By 1.0](https://opendatacommons.org/licenses/by/1-0/).
