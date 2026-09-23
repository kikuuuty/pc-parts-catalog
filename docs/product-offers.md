# Product Offers — Yahoo!ショッピング

`GET /v1/products/:id/offers` は、選択済みのactiveなカタログ製品について、
canonical JANからYahoo!ショッピングの商品検索（v3）を1回呼び、販売候補を返します。
初版はYahooのみ。価格はD1へ保存せず、catalog検索の並び順にも使用しません。

## HTTP contract

- query parameterなし。ID検証・404・405・OPTIONS・CORS `*`・`X-Request-ID`はProduct Detailと同じ。
- inactive／存在しない製品は404 `PRODUCT_NOT_FOUND`。不正pathは404、unsafe整数は400。
- browser responseは常に`Cache-Control: no-store`。内部キャッシュのみTTLを持ちます。
- `X-Cache: HIT / MISS / BYPASS`、`X-Cache-TTL`、HITの`Age`は**Offer cache**についての値。
  request IDとtelemetryは毎回生成し、キャッシュしません。

成功例（コード・価格は説明用）:

```json
{
  "product": { "id": 123, "name": "Example PC part" },
  "provider": "yahoo",
  "lookup": { "status": "complete", "strategy": "jan", "reason": null },
  "offers": [{
    "provider": "yahoo",
    "provider_item_id": "tsukumo-y_example",
    "name": "Example PC part",
    "jan_code": "0012345678905",
    "image": {
      "id": "example-product-image",
      "small": { "url": "https://images.example.net/small.jpg", "width": 76, "height": 76 },
      "medium": { "url": "https://images.example.net/medium.jpg", "width": 146, "height": 146 },
      "preferred": { "url": "https://images.example.net/preferred.jpg", "width": 300, "height": 300 }
    },
    "seller": {
      "id": "tsukumo-y",
      "name": "ツクモ パソコン Yahoo!店",
      "url": "https://store.shopping.yahoo.co.jp/tsukumo-y/",
      "image": { "id": "example-seller-image", "url": null },
      "is_best_seller": true,
      "shop_key": "tsukumo"
    },
    "price": 69800,
    "shipping": { "code": 2, "name": "送料無料" },
    "in_stock": true,
    "condition": "new",
    "url": "https://store.shopping.yahoo.co.jp/tsukumo-y/example.html",
    "fetched_at": "2026-09-23T00:00:00.000Z"
  }]
}
```

Yahoo検索が0件、または安全に採用できる一致商品が0件なら、`complete`＋`offers: []`。
安全なJANがない場合は**Yahooを呼ばず**200を返します。App IDも不要です。

```json
{
  "product": { "id": 123, "name": "Example PC part" },
  "provider": "yahoo",
  "lookup": { "status": "unsupported", "strategy": null, "reason": "no_supported_identifier" },
  "offers": []
}
```

## JAN exact lookup

`canonicalIdentifiers()`が保持する`type/value/region/origins`を使用します。
`jan`型、regionが`jp`または`all`、ASCII数字8桁または13桁、チェックデジットが正しいものだけを採用。
全桁0は拒否します。trim以外の変形・数値化はせず、先頭0を保持します。
EAN/GTIN/UPCのJANへの推定変換は行いません。

複数候補は次の優先順で1つだけ選びます。

1. `jp` → `all`（他regionは対象外）
2. 同じregionなら`origins`に`local`を含むもの → upstreamのみ
3. 同順位はtrim済みコードの文字列昇順

local identifierは既存`addLocalIdentifier()`経由の、evidenceを持つcanonical追加を意味します。
`verified_at`はcanonical viewにはないため、検証日による優先順位は推定しません。
複数JANすべてを検索する仕組みではありません。コードの有効性はSKU割当の正しさまで保証しないので、
local追加には製品と一致する根拠を付けてください。

## Yahoo request / normalization

[公式商品検索v3仕様](https://developer.yahoo.co.jp/webapi/shopping/v3/itemsearch.html)に従い、
`appid`, `jan_code`, `results=50`, `in_stock=true`, `condition=new`, `sort=+price`, `image_size=300`を
`URL` / `URLSearchParams`で構築します。タイムアウトは本文の読み取りを含め5秒。
redirect追従・自動retry・sellerごとの個別requestはありません。

- 返却`janCode`が選択JANと一致する商品だけ採用。JAN欠落・空文字・数値型・別JANは除外。
- 在庫あり／新品も返却値で確認。既知の在庫なし／中古は除外し、型の破損などはprovider error。
- `price`はYahooの表示価格（JPY）をそのまま使用。正のsafe整数のみ。
- `seller.sellerId/name/url/isBestSeller`を共通名へ変換。名称はYahooの表記を保持。
- `shipping.code/name`は区分として保持（1:設定なし、2:送料無料、3:条件付き送料無料）。
  **送料額・合計価格・実質価格は算出しません**。PayPayポイントや会員価格も比較へ混ぜません。
- optionalなseller URL／best seller／shipping情報がない場合は`null`。不正なURL schemeを公開しません。
- `fetched_at`は実取得時刻。HITで更新しません。
- 商品コード・seller ID・正確なURLの3つが同じものだけ重複排除。
  重複行の差異は価格昇順→seller ID→商品コード→URL→正規化行の文字列順で決定し、先頭を採用。
  異なるlistingを価格だけで統合しません。同じ順で最終結果も安定ソートします。
- 1回の検索で返る最大50件が対象。ページングで全Yahoo listingを収集するAPIではありません。
  schema破損は空の成功結果としてキャッシュせず、errorにします。

既知ショップは追加で`shop_key`を持ちます。**未知sellerもすべて保持**します。

|seller ID|shop_key|
|---|---|
|tsukumo-y|tsukumo|
|arkonline-store|ark|
|dospara-y|dospara|
|pc-koubou|pc-koubou|
|goodwill|goodwill|
|applied-net|applied|
|e-zoa|e-zoa|
|y-sofmap|sofmap|
|y-kojima|kojima|
|joshin|joshin|
|etrend-y|etrend|
|murauchi|murauchi|
|pc-express|caravan-yu|

## 共通画像モデル

Offerに`image: { id, small, medium, preferred }`、sellerに`image: { id, url }`を追加します。
各商品画像variantは`{ url, width, height }`。Provider非依存のJSDoc型
`OfferImage` / `ImageVariant` / `SellerImage`を`src/offers/model.js`に定義しています。
既存の価格・seller・shippingなどのfield名は変更しません。

|Yahoo field|normalized field|寸法・欠損方針|
|---|---|---|
|`hits.imageId`|`image.id`|商品画像IDをそのまま保持、欠損／空文字はnull|
|`hits.image.small`|`image.small.url`|76×76（Yahoo仕様の固定値）|
|`hits.image.medium`|`image.medium.url`|146×146（Yahoo仕様の固定値）|
|`hits.exImage.url`|`image.preferred.url`|`image_size=300`で通常表示用の画像を要求|
|`hits.exImage.width` / `height`|`image.preferred.width` / `height`|レスポンスの実寸法を保持|
|`hits.seller.imageId`|`seller.image.id`|seller画像IDをそのまま保持|
|取得なし|`seller.image.url`|現行Yahoo APIはseller画像URLを返さないためnull|

画像はoptionalなメタデータです。全画像が欠損していても価格Offerは保持します。
URLのないvariant、空文字・不正schemeなどのURLはvariant全体を`null`にします。
画像IDだけある場合もIDを保持します。`exImage`がなければ`preferred: null`で、
small／mediumからの暗黙のfallbackは行いません。必要ならUIが利用可能なvariantを選択できます。
preferredの寸法は正のsafe整数だけを採用し、欠損・不正値は各寸法を`null`とします。
要求サイズの300×300を未知の実寸法として埋めることはありません。

有効な画像URLは返却文字列をそのまま使用し、hostやqueryを書き換えません。
商品／seller画像IDからURLを推測しません。特にseller IDがURLのような文字列でもopaque IDとして扱います。
画像URLのfetch・proxy・画像binaryの保存は行わず、画像ID／URLもtelemetryへ出しません。
画像メタデータは商品価格と一緒にOffer cacheへ保存します。

別Providerを追加する場合、そのProviderのmapperで画像ID・小／中／通常表示用URLを同じ共通fieldへ変換します。
サイズは各Providerの仕様または返却値に基づき、不明ならnull。小／中画像がないProviderはnullを返せます。
seller logo URLを取得できるProviderでは`seller.image.url`へ直接mappingできるため、
フロントはYahoo固有の`imageId`／`exImage`を知る必要がありません。

## Cacheと保護

1. 既存Product Detail cache（600秒、ID＋catalog epoch）でactive productとcanonical identifiersを取得。
   MISS時は既存D1保護を使います。公開Detail response契約は同じです。
2. Yahoo cacheは`/__catalog_cache/offers/yahoo/v2`＋origin＋catalog epoch＋TTL＋strategy＋JAN。
   **App ID・製品名・upstream URLをkeyに含めません**。Offer配列のみ保存するため、
   同じJANを持つ別product IDでも共有でき、product wrapperは現在のDetailから組み立てます。
   v2は商品／seller画像メタデータを含みます。画像なしの旧v1 cacheは再利用しません。
3. `YAHOO_OFFERS_CACHE_TTL_SECONDS`は既定1800秒、許可範囲60〜3600の整数秒。
   runtimeで不正設定は503、release validationでも拒否。epoch不正／未設定やCache APIなしはBYPASS。
4. 200の正規化済み結果（0件も含む）だけ保存。エラー・unsupported・request metadataは保存しません。
   期限切れは再取得し、stale fallbackやHITによるTTL延長はありません。
5. cache match/put障害でもYahoo専用保護を必ず通します。取得成功なら200＋BYPASS。

catalog releaseのepoch更新でDetailとOfferの両方を切り替え、DB再構築時のID再割当やJAN変更と分離します。
out-of-bandなidentifier／active変更にはepoch更新が必要です。更新しない場合、
Detailの最大600秒の鮮度期間中は旧identifier／active状態が見える点は既存Detailと同じです。
新しいJANを取得した後は別Offer keyになるので旧JANの価格を混ぜません。

外部MISSにだけ`YAHOO_OFFER_MISS_LIMITER`を適用します。
production `29599007` / local `29599107`、共通キー`yahoo-offer-miss`、**30回/60秒**。
HIT・unsupported・missing App IDではYahoo tokenを消費しません。
同一isolate・同一cache keyの同時MISSはPromiseを共有し、外部requestとtokenを1つに集約します。
in-flight mapは最大32 keys、完了・失敗時に除去。Detail自体がcoldの場合は既存refill guardも作用します。
さらに同一isolateでは外部開始間隔を最低1秒とし、短時間のuncached burstは503＋Retry-After: 1で拒否します。

Cloudflare Cache APIはcolo-local、Rate Limiting bindingはcolo-local/eventually consistentです。
したがって30/分は全利用者で共有する**保守的な場所別予算**であり、厳密な全世界共通上限ではありません。
isolateをまたぐ同時MISS集約／1秒間隔も保証しません。個人利用の初版はこの境界とし、
Yahooの429や複数拠点での増幅が見られた場合は共有coordinatorを別フェーズで検討します。

## エラーとtelemetry

既存形式`{ "error": { "code": "...", "message": "..." }, "request_id": "..." }`。
upstream本文・URL・App ID・例外stackは公開せず、D1障害は従来の`DATABASE_*`で区別します。

|状況|HTTP / code|bounded telemetry reason|
|---|---|---|
|App IDなし|503 `OFFER_PROVIDER_UNAVAILABLE`|missing_app_id|
|timeout / 通信障害|503 `OFFER_PROVIDER_UNAVAILABLE`|timeout / network|
|Yahoo 4xx（429以外）|502 `OFFER_PROVIDER_ERROR`|upstream_4xx|
|Yahoo 429|503 `OFFER_PROVIDER_RATE_LIMITED`|upstream_429|
|Yahoo 5xx|503 `OFFER_PROVIDER_UNAVAILABLE`|upstream_5xx|
|invalid JSON / schema破損|502 `OFFER_PROVIDER_ERROR`|invalid_json / malformed_response|
|専用予算拒否 / pacing|503 `OFFER_PROVIDER_RATE_LIMITED`|miss_budget / pacing|
|専用limiter欠落・障害|503 `OFFER_PROVIDER_UNAVAILABLE`|protection|

YahooのRetry-Afterは1〜3600の整数秒だけ採用し、それ以外は60秒。
通常の一時的障害は30秒。既存D1 admission拒否は従来どおり429 `RATE_LIMITED`。
価格取得失敗を「販売商品がない」として200に変換しません。

`catalog_api`にはbounded route、provider、lookup_strategy、product_cache_status、
offer_cache_status/error、offer_coalesced、upstream_status_class/duration_ms、offer_count、
provider_error_reason、rate_limit_classと既存D1/elapsed情報だけを追加します。
JAN・product名・seller URL・App ID・完全upstream URLはログに記録しません。

## Secretと実API smoke

Workerは`env.YAHOO_SHOPPING_APP_ID`から読みます。ローカルはGit ignore済みの
`.dev.vars.local`へ`YAHOO_SHOPPING_APP_ID=<取得したClient ID>`を設定してください。
既存ファイルに他のbindingがある場合は追記してください。

Wrangler 4.131.1は`secrets.required`に対応していますが、このsecretはYahoo機能にのみ必要です。
未取得でも通常catalog／unit tests／release checksが動くよう、初版ではrequired declarationは設定しません。
平文varsへのApp ID追加はrelease validationで拒否します。

```sh
# ネットワーク不要。実App ID不要
npm test
npm run check
npm run verify:protection

# App ID取得後のみ、明示的な実Yahoo transport smoke（通常CIでは呼ばない）
# <verified-JAN>を実在する検証済みJANに置換
npm run smoke:yahoo -- --live --jan <verified-JAN>

# local endpointの手動確認。catalogのcanonical JANを持つactive IDを選ぶ
npm run worker:dev
curl http://127.0.0.1:8787/v1/products/<product-id>/offers
```

smokeは`.dev.vars.local`または環境変数を読み、App ID欠落／`--live`なしでは外部アクセスしません。
1回の検索の結果件数とstatus class／時間だけ表示し、0件も正常です。
transport smokeはWorkerのcache／limiterを通さないため、短時間に連続実行しないでください。
endpoint確認は2回呼び、2回目のHITと`fetched_at`の保持を確認できます。

production secret設定（App IDをコマンド引数・通常varsに書かず、対話入力）:

```sh
npx wrangler secret put YAHOO_SHOPPING_APP_ID
```

これはproductionへの変更コマンドです。この実装作業では実行していません。
本番公開前にsecret登録、新namespaceのaccount内重複確認、TTL、catalog epoch／検証snapshotの整合を確認し、
既存release gateを通してdeployしてください。既存releaseはconfig vars/bindingsを保持します。
通常CI／release smokeはYahooを呼びません。実価格の検証は上記明示smokeで行います。

## 拡張境界

- `worker.js`: product/identifier取得、HTTP・D1・request telemetry。
- `offers/identifiers.js`: canonical identifierから安全なlookup選択。
- `offers/service.js` / `cache.js`: Offer取得のcache・coalescing・外部MISS保護。
- `offers/yahoo-shopping.js`: Yahoo固有transportと共通Offerへの変換。
- `offers/model.js`: Provider非依存の画像メタデータ型（JSDoc）。
- `offers/errors.js`: 公開可能なprovider error。

MPN/manufacturer/name fallbackは未実装です。追加する場合はidentifier選択で明示的なstrategyを返し、
別の照合・確信度ルールを通してから正規化します。strategy／入力ごとにcache keyを分け、
JAN exactの契約を保ってcache世代を更新してください。他Providerは独立transportと正規化関数を追加できます。
plugin framework、価格履歴、アフィリエイト、推定送料、ポイント実質価格、購入処理はありません。

## ローカル検証結果

画像メタデータ追加時（2026-09-23）:

- Yahoo transport／Offer Workerの関連24 tests成功。画像の全項目・部分欠損・全欠損・実寸法・空／不正URL・
  seller画像ID・`image_size=300`・秘密情報非公開・画像URLの非fetch・cache保存／HIT・旧v1除外を検証。
- `npm run check`: schema check＋全276 tests成功、skip 0。
- `git diff --check`: 成功。実Yahoo API呼出し／production deployなし。

初回Provider実装時（2026-09-23）、実Yahoo API呼出し／production deployなしで確認:

- `npm test`: 271 tests成功、skip 0（Yahoo transport・Offer Workerの19 testsを含む）。
- `npm run check`: schema check＋全271 tests成功。
- `npm run verify:protection`: 29 tests成功。production/localの全14 namespacesをstrict validation。
- `npm run release:verify -- --local`: source integrity / filter metadata / search quality / query plansすべて成功。
  48,134 active製品、30カテゴリ、45 query plans。
- `npm run verify:worker:local`: workerd HTTP/direct-D1 contract成功、Golden 236件一致、
  全30カテゴリのSearch／Detail／Filter、MISS→HIT、pagination／resolveを確認。
- `npx wrangler deploy --dry-run --outdir .cache/yahoo-worker-dry-run`: bundle・7 limiter bindings成功。

release/HTTP検証時だけ、cleanな`.cache/upstream`をローカルD1と同じ固定commit
`eec0df175504ebd15f0f3e3a8249a18a22f00940`へ切り替えました。
検証後は元の`992dacfa9f516a5251fb01b70c9894bb23ad69d4`へ復元済みです。
再実行時はsnapshotと対象D1を一致させてください。検証のためのcatalog syncは行っていません。
レポートは`.cache/release-verify-report.json`と`.cache/api-local-production.json`。
実API smokeとaccount内namespace inventoryはApp ID設定／本番公開準備時の確認対象です。
