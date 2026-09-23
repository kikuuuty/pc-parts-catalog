# Bulk Offer Summary API

`POST /v1/products/offers/summary`は検索一覧向けの**既取得価格summaryの参照API**です。
最大20製品を1回のD1 queryで読み、Yahoo request、candidate cache fan-out、価格refreshは行いません。
単一`GET /v1/products/:id/offers`の最終的な正常結果から、オンデマンドでsummary cacheを更新します。

## HTTP contract

```http
POST /v1/products/offers/summary
Content-Type: application/json

{"product_ids":[372,22309,1234,372]}
```

- `product_ids`は1〜20件。正のsafe integerのJSON numberのみ。文字列、0、負数、小数、nullは400。
- 上限は重複除去**前**の入力件数。DB参照は重複除去し、responseでは**入力順・重複を保持**します。
- 未知field、空配列、query parameter、不正JSONは400 `INVALID_REQUEST`。
- 既存API共通の16 KiB body上限（413）、JSON Content-Type（415）、POST以外405、OPTIONS対応。
- `Cache-Control: no-store`、`X-Cache: BYPASS`、CORS `*`、`X-Request-ID`、`Server-Timing`は既存APIと同じ。
- productがない場合もrequest全体は200。行ごとに`missing`を返します。

成功例（価格・時刻は説明用）:

```json
{
  "products": [
    { "id": 372, "status": "complete", "lowest_price": 57629, "offer_count": 28, "fetched_at": "2026-09-23T14:15:43.130Z" },
    { "id": 22309, "status": "empty", "lowest_price": null, "offer_count": 0, "fetched_at": "2026-09-23T14:15:43.130Z" },
    { "id": 1234, "status": "pending", "lowest_price": null, "offer_count": null, "fetched_at": null },
    { "id": 372, "status": "complete", "lowest_price": 57629, "offer_count": 28, "fetched_at": "2026-09-23T14:15:43.130Z" }
  ]
}
```

### Status

|status|意味|lowest_price|offer_count|fetched_at|
|---|---|---|---|---|
|`complete`|有効な正規化Offerが1件以上|最小の正整数価格（JPY）|1〜50|実取得時刻（UTC ISO 8601）|
|`empty`|対応候補を上限まで正常に検索し、採用Offerが0件|null|0|最後の候補の取得時刻|
|`unsupported`|単一`/offers`で利用可能なJAN/EAN candidateなしを確認済み|null|0|null|
|`pending`|現在有効なsummaryがない。未取得・期限切れ・世代不一致・保存失敗等|null|null|null|
|`missing`|product不存在またはinactive|null|null|null|

**pendingは「販売商品なし」ではありません。** emptyは正常な検索結果が0件、unsupportedはbarcode非対応です。
Bulkはidentifier列挙も行わないため、まだ単一`/offers`を使っていないbarcode非対応製品も最初はpendingです。

初版はprovider errorをD1へ保存しないため、summary status `error`は導入しません。
provider errorは単一`/offers`の既存error contractで返し、有効な旧summaryがあればその期限までは利用できます。
旧summaryもなければpendingです。Bulk自身のD1／保護障害はrequest全体の500／503／429で示し、pendingへ偽装しません。

## D1 schema

Migration: `migrations/0010_product_offer_summary.sql`。既存catalog table／identifierは変更しません。

|column|type / 用途|
|---|---|
|`product_id`, `provider`|複合PRIMARY KEY。初版providerは`yahoo`のみ|
|`source`, `upstream_key`|durable product identity。numeric IDの再割当に対する照合|
|`catalog_epoch`|catalog release／identifier変更に伴う無効化|
|`generation`|summary・Offer schema・lookup policy世代。初版`v1-v2-candidates3`|
|`ttl_seconds`|保存時のOffer TTL。現在設定と一致する場合だけ使用|
|`status`|`complete` / `empty` / `unsupported`|
|`lowest_price`, `offer_count`|正規化Offerから算出した最小価格と件数|
|`lookup_strategy`|`jan` / `ean13_as_jan` / null。barcode値は保存しない|
|`fetched_at`|採用された候補の実取得時刻。unsupportedはnull|
|`observed_at`|評価した候補の最古の取得時刻（epoch milliseconds）。unsupportedは判定時刻|
|`expires_at`|summaryの有効期限（epoch milliseconds）|

`WITHOUT ROWID`で複合PKを使用し、追加の広域indexは不要です。価格・件数・statusの整合はCHECKで制約します。
製品／providerごとに1行をupsertする**現在値cache**で、epochごとに履歴を増やしません。
古い取得結果が遅れて到着しても新しい行を上書きせず、同じ取得結果の再保存はno-opです。
productへのFKは`ON DELETE CASCADE`。期限切れ行は読み取りで無効化し、次回取得時に置換します。
Offer配列、seller、商品名、Yahoo URL、App ID、JAN/EAN値は保存しません。

numeric IDは通常syncでは保持され、hard deleteでもhigh-water markで再利用を防ぐ設計です。
DB再構築ではIDが変わり得るため、保存・参照双方で`source + upstream_key`を照合し、保存時にactiveも確認します。
release時は既存`CATALOG_CACHE_EPOCH`を更新し、全summaryを論理無効化します。
out-of-bandなcanonical identifier変更時も、既存Detail／Offer cacheと同じくepoch更新が必要です。

## Freshnessと保存フロー

`YAHOO_OFFERS_CACHE_TTL_SECONDS`を共用します。既定1800秒、許可範囲60〜3600秒。
現在のepoch／generation／TTLが一致し、`observed_at <= now < expires_at`の行だけ使用します。
epochが欠損／不正なら保存をBYPASSし、Bulkではactive製品をpendingとして返します。不正TTLは503です。
stale priceを別fieldで返すことや、HITによるTTL延長はありません。

```text
GET /v1/products/:id/offers
  → 最大3候補を既存policyで逐次照合
  → 最初の非空結果、全候補空、またはunsupportedを確定
  → summarizeOffers(finalOffers)
  → D1 summary upsertをawait
  → 既存Offer response

POST /v1/products/offers/summary
  → body validation / D1 admission
  → 1 indexed batch SELECT
  → complete / empty / unsupported / pending / missing
```

- `summarizeOffers()`は各`price`を正のsafe integerとして検証し、最小値と配列件数を明示計算します。
  Providerの正規化済み結果だけが入力で、名前／MPNによる救済や別candidateのOffer unionはありません。
- 1番目0件→2番目5件なら、2番目の5件だけをsummary化。途中のemptyをD1へ保存しません。
- 候補単位のOffer cache HITからもbackfill可能。空配列はcacheの正確な保存時刻を使い、nonemptyは元の`fetched_at`を保持します。
- fallback時は**評価した全候補の最も早いexpiry**を採用。先行候補のempty cacheが期限切れになるより長く、
  後続候補の価格をsummaryとして有効扱いしません。最終候補の`fetched_at`自体は保持します。
- unsupportedは判定から同TTLで期限切れ、`fetched_at=null`。epoch変更でも無効です。
- Summaryはcacheなので、D1 write障害／保護拒否は正常なOffer responseを失敗させません。
  bounded `summary_write_status=error/protected`を記録し、後続のOffer HITで再保存を試みられます。
- 成功済みwriteのhint（最大128 entries、有効期限付き）とin-flight coalescing（最大32 entries）をisolate内に持ち、
  同じOffer HITのたびにD1 writeしません。別isolateでは安全な条件付きupsertを行えます。

## D1 query・保護・telemetry

入力IDを重複排除したJSON配列として1 bindし、`json_each(?)`の最大20行から
`products`のINTEGER PRIMARY KEY、`product_offer_summary`の複合PRIMARY KEYへLEFT JOINします。
小さいfixtureでもplannerがcatalog全表走査を選ばないよう、入力側を起点にします。
返却はJSで入力順・重複へ展開。20 × SELECT、identifier取得、candidate cache照合はありません。

- Bulkは**1 SQL statement / 1 D1 binding operation**、write 0、Yahoo fetch 0、Yahoo token 0。
- `D1_MISS_LIMITER`の既存共通キー`search-d1-miss`（60 requests/60秒）を1回消費します。
  expensive／query-refill／facet／Yahoo tierは消費しません。検索1ページ20件でも1tokenです。
- 単一`/offers`のsummary writeも同じD1保護下。cold Detailでadmission済みなら再消費せず、
  Detail HITから新規に書く場合はD1 tokenを1回消費します。write hint HITは0 SQL／0tokenです。
- 組合せごとのBulk response cacheは作らず、D1行のfreshnessを正とします。
- telemetryは既存query数／operations／rows_read／rows_written／時間に、
  `summary_product_count`（1〜20）と`summary_write_status`（固定enum）を追加します。
  ID配列、価格、商品名、barcode、seller、URL、App IDは記録しません。

Local D1の実測（20 ID、実workerd）: 全coldは**1 query / rows_read 40 / rows_written 0**、
2件complete＋18件coldは**1 query / rows_read 42 / rows_written 0**。
これは入力20行＋productのPK lookup20行＋存在するsummary行の参照に相当します。
全20 summaryが存在してもPK lookup対象は最大20行で、catalog件数に比例しません。
node:sqlite adapterの`rows_read`は返却件数の代用値のため、実D1 costの根拠には使用していません。

## 運用・拡張点

ローカルmigrationと検証:

```sh
npx wrangler d1 migrations apply pc-parts-catalog --local --env local --persist-to .wrangler/state
npm test
npm run check
npm run verify:protection

# 実Yahooを呼ぶ単一Offer＋外部アクセスしないBulkのworkerd検証
# .dev.vars.localのApp IDが必要。隔離port/epochで起動し、検証後に停止
node scripts/verify-yahoo-fallback-local.js --live --output .cache/offer-summary-live-report.json
```

48,000製品の全件Cron、Queue、バックグラウンドfan-outは初版にありません。
Bulkでpendingを見ても自動でYahoo取得を開始せず、選択した製品の単一`/offers`利用でcacheが育ちます。

将来のQueue consumerは、`offers/service.js`の既存pacing／MISS予算付きlookupから得た最終resolutionを
`offers/summary.js`の共通生成・保存処理へ渡せます。Bulk読取・summary生成・storage・Provider取得を分離しています。
enqueueの重複抑制／予算／複数consumer間のpacing調整は、その段階で追加します。

productionへのmigration／deployはこの作業では行っていません。

## 検証結果（2026-09-24）

- `npm test`: 320 tests成功、skip 0（summary 20 testsと共通保護1 testを追加）。
- `npm run check`: schema check＋320 tests成功。
- `npm run verify:protection`: 30 tests成功。
- local D1にmigration 0010を適用し、実workerd＋実Yahooで検証成功。
  A3メッシュ版は2番目candidateの2 Offer、9800X3Dは1番目candidateの27 Offerからsummaryを保存。
  20 IDのBulkは取得前pending、取得後は両製品completeとなり、最小価格・件数・取得時刻が単一Offerと一致。
  再度の単一OfferはHITでsummary writeを省略しました。
- Bulkのquery数／rows_readは上記実測どおり。検証レポートは`.cache/offer-summary-live-report.json`。
- empty／unsupported／期限切れ／世代変更／重複順序／不存在・inactive／20件warm／不正入力／保護障害／
  write障害／provider error／fallbackの最終結果だけの保存／HIT backfillの非延長をoffline testsで検証。
