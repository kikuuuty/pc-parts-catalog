# Product Offers — Yahoo!ショッピング

`GET /v1/products/:id/offers` は、選択済みのactiveなカタログ製品について、
canonical JANを最優先し、canonical EAN-13も含む上位最大3候補を順番にYahoo!ショッピングの商品検索（v3）で照合します。
正常な200応答を正規化してOfferが0件だった場合だけ次候補へ進み、最初の完全一致Offerを返します。
初版はYahooのみ。価格はD1へ保存せず、catalog検索の並び順にも使用しません。

## HTTP contract

- query parameterなし。ID検証・404・405・OPTIONS・CORS `*`・`X-Request-ID`はProduct Detailと同じ。
- inactive／存在しない製品は404 `PRODUCT_NOT_FOUND`。不正pathは404、unsafe整数は400。
- browser responseは常に`Cache-Control: no-store`。内部キャッシュのみTTLを持ちます。
- `X-Cache: HIT / MISS / BYPASS`、`X-Cache-TTL`、HITの`Age`は**Offer cache**についての値。
  最後に評価したcandidateのcache状態を表します。request IDとtelemetryは毎回生成し、キャッシュしません。

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

上位最大3候補すべてで安全に採用できる一致商品が0件なら、`complete`＋`offers: []`。
安全なJANもEAN-13もない場合は**Yahooを呼ばず**200を返します。App IDも不要です。

```json
{
  "product": { "id": 123, "name": "Example PC part" },
  "provider": "yahoo",
  "lookup": { "status": "unsupported", "strategy": null, "reason": "no_supported_identifier" },
  "offers": []
}
```

## JAN優先 / EAN-13 fallback exact lookup

`canonicalIdentifiers()`が保持する`type/value/region/origins`を使用します。
`jan`型、regionが`jp`または`all`、ASCII数字8桁または13桁、チェックデジットが正しいものだけを採用。
全桁0は拒否します。trim以外の変形・数値化はせず、先頭0を保持します。
候補は次の優先順で列挙します（他regionは対象外）。

1. JAN / `jp` / local
2. JAN / `jp` / upstream
3. JAN / `all` / local
4. JAN / `all` / upstream
5. EAN-13 / `jp` / local
6. EAN-13 / `jp` / upstream
7. EAN-13 / `all` / local
8. EAN-13 / `all` / upstream

grouped identifierの`origins`にlocalを含む場合はlocalと判定します。
同順位だけvalueの文字列昇順（JANはtrim済み）で安定化し、同じlookup valueはtype／region／originをまたいでも
最上位のcandidateだけ残します。`MAX_YAHOO_LOOKUP_CANDIDATES = 3`でcache照合と外部試行を最大3候補に制限します。

local identifierは既存`addLocalIdentifier()`経由の、evidenceを持つcanonical追加を意味します。
`verified_at`はcanonical viewにはないため、検証日による優先順位は推定しません。
コードの有効性はSKU割当の正しさまで保証しないので、
local追加には製品と一致する根拠を付けてください。

JANの後に、`type=ean`、**13桁ASCII数字・正しいcheck digit・全桁0以外**を候補にします。
EAN-8、UPC-12、GTIN-14、数値型、全角、ハイフン、空白（前後も含む）、チェックデジット不正は拒否。
EAN文字列は修復・trim・数値化せず使用し、`0730143315289`の先頭0を削除／追加しません。
JAN-8およびJANの既存trim方針は維持します。check digit計算のみ共通化しています。

EANもregionは`jp`／`all`に限定し、優先順位はJANと同じくregion → local origin → lexical valueです。
2026-09-23にローカルD1のcanonical viewを調査したところ、EANはupstream由来の`all`が28,221行、
`us`が59行でした（snapshot `eec0df175504ebd15f0f3e3a8249a18a22f00940`）。region欠損/nullは存在しないため許可しません。
`us`等の他国regionは検索対象外。`jp`は既存local identifierの国内向けmetadata規則に合わせています。

`selectYahooLookupCandidates()`は内部で`{ strategy, identifier_type, value }`の優先順位付き配列を返します。
JANは`{ strategy: 'jan', identifier_type: 'jan', value }`、EANは
`{ strategy: 'ean13_as_jan', identifier_type: 'ean', value }`です。
**canonical DBのEANをJANへ変換・追加する処理ではなく、Yahoo Providerだけのlookup policy**です。
transportはcanonical typeを判断せず、どちらの値もそのままYahooの`jan_code`へ渡します。

**200応答をexact match／正規化して0件の場合だけfallback**します（正常結果のcache HIT `[]`も同様）。
timeout、network、429、4xx／5xx、200以外のstatus、JSON／response破損、内部保護失敗では即時errorです。
最初の非空candidateで終了し、別identifierのOfferをunionしません。すべて空なら最後のcandidateのstrategyを返します。

APIの`lookup`は従来形式のまま、EAN時だけ以下のstrategyになります。

```json
{ "status": "complete", "strategy": "ean13_as_jan", "reason": null }
```

代表例はAMD Ryzen 7 9800X3D（確認時のlocal product ID 372）。canonical JANなし、EANは
`0730143315289`ほか複数が`region=all / origin=upstream`で存在し、lexical順に上記コードを選択します。
MPN `100-100001084WOF`やUPC `730143315289`はfallbackに使用しません。
商品IDはDBごとに異なり得るため、実行前にDetailで製品名とidentifiersを確認してください。

A3-mATX White / Brown Wood **Mesh Side Panel**（local ID 22309、upstream ID
`a00aa6fd-61a1-41a7-a259-debd7cdb7cf4`）は、canonical EANが`0840353046559`と`4718466015815`で、
どちらも`all / upstream`です（2026-09-24にlocal D1のcanonical viewとupstreamレコードを照合）。
回帰fixtureは1番目が200／0件、2番目の`4718466015815`がexact Offerを返す条件です。
別製品のTempered Glass版や製品名・MPNによる検索は使いません。

## Yahoo request / normalization

[公式商品検索v3仕様](https://developer.yahoo.co.jp/webapi/shopping/v3/itemsearch.html)に従い、
`appid`, `jan_code`, `results=50`, `in_stock=true`, `condition=new`, `sort=+price`, `image_size=300`を
`URL` / `URLSearchParams`で構築します。タイムアウトは本文の読み取りを含め5秒。
redirect追従・自動retry・sellerごとの個別requestはありません。
workerd対応の`redirect: manual`を使用し、3xxはprovider errorとして拒否します。

- JAN／EANどちらのlookupでも、返却`janCode`がlookup valueと**文字列で完全一致**する商品だけ採用。
  欠落・空文字・数値型・先頭0欠落・別コード・前後空白付きの返却値は除外し、名前／MPNで救済しません。
  Offerの`jan_code`はYahooの返却fieldとして維持し、`ean_code`は追加しません。
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
2. Yahoo cacheは`/__catalog_cache/offers/yahoo/v2`＋origin＋catalog epoch＋TTL＋strategy＋identifier value。
   **App ID・製品名・upstream URLをkeyに含めません**。Offer配列のみ保存するため、
   同じstrategyと値を持つ別product IDでも共有でき、product wrapperは現在のDetailから組み立てます。
   v2は商品／seller画像メタデータを含みます。画像なしの旧v1 cacheは再利用しません。
   `strategy=jan`と`strategy=ean13_as_jan`は同じ13桁の値でも別keyです。
   EAN追加ではcache世代を上げません。保存する正規化Offer配列の形式は同じで、既存JAN keyを維持し、
   新policyは独立strategy keyになるため衝突しません。unsupported responseはそもそもcacheされません。
3. `YAHOO_OFFERS_CACHE_TTL_SECONDS`は既定1800秒、許可範囲60〜3600の整数秒。
   runtimeで不正設定は503、release validationでも拒否。epoch不正／未設定やCache APIなしはBYPASS。
4. 200の正規化済み結果（0件も含む）だけ保存。エラー・unsupported・request metadataは保存しません。
   期限切れは再取得し、stale fallbackやHITによるTTL延長はありません。
   各candidateのcacheを順に確認するため、`HIT [] → HIT offers`なら外部アクセスなしで解決します。
   product単位のlookup-resolution cacheは追加しません。
5. cache match/put障害でもYahoo専用保護を必ず通します。取得成功なら200＋BYPASS。

catalog releaseのepoch更新でDetailとOfferの両方を切り替え、DB再構築時のID再割当やidentifier変更と分離します。
out-of-bandなidentifier／active変更にはepoch更新が必要です。更新しない場合、
Detailの最大600秒の鮮度期間中は旧identifier／active状態が見える点は既存Detailと同じです。
新しいidentifier／strategyを選択した後は別Offer keyになるので旧lookupの価格を混ぜません。

各外部MISSに`YAHOO_OFFER_MISS_LIMITER`を適用します。3候補がすべてMISSなら3 tokenです。
production `29599007` / local `29599107`、共通キー`yahoo-offer-miss`、**30回/60秒**。
HIT・unsupported・missing App IDではYahoo tokenを消費しません。
同一isolate・同一cache keyの同時MISSはPromiseを共有し、外部requestとtokenを1つに集約します。
in-flight mapは最大32 keys、完了・失敗時に除去。Detail自体がcoldの場合は既存refill guardも作用します。
さらに同一isolateでは外部開始間隔を最低1秒とし、短時間のuncached burstは503＋Retry-After: 1で拒否します。
外部取得を開始した処理だけが、その処理のfallbackのために不足する間隔を待機できます。
limiter／fetch／cache write／fallback待機中はその処理が外部admissionを保持し、別MISSの待機queueは作りません。
候補単位のHITと同一keyのcoalescingは引き続き使用できます。成功・失敗いずれでもadmissionを解放します。

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
`lookup_strategy`は`jan`／`ean13_as_jan`／nullのみで、利用率を区別できます。
`lookup_candidate_count`は上限適用後の候補数（0〜3）、`lookup_attempts`は評価した候補数
（cache HIT／coalesced／失敗した候補も含む0〜3）、`lookup_hit_index`は最初に非空Offerを得た候補の
1-based位置（1〜3、未取得・unsupported・errorは0）です。strategyは最後に評価した候補を示します。
公開`lookup` contractにfieldsは追加しません。
JAN・EAN値・product名・seller URL・App ID・完全upstream URLはログに記録しません。

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
# <verified-JAN>を実在する検証済みコードに置換（EAN-13も可。CLI名 --jan は維持）
npm run smoke:yahoo -- --live --jan <verified-JAN>

# local endpointの手動確認。canonical JANまたは対応EAN-13を持つactive IDを選ぶ
npm run worker:dev
curl http://127.0.0.1:8787/v1/products/<product-id>/offers

# A3メッシュ版＋9800X3Dの実local Worker検証（実Yahoo呼出し）
# 隔離port／cache epochで起動し、検証後にそのWorkerだけ停止
node scripts/verify-yahoo-fallback-local.js --live --a3-id 22309 --ryzen-id 372
```

smokeは`.dev.vars.local`または環境変数を読み、App ID欠落／`--live`なしでは外部アクセスしません。
1回の検索の結果件数とstatus class／時間だけ表示し、0件も正常です。
transport smokeはWorkerのcache／limiterを通さないため、短時間に連続実行しないでください。
endpoint確認は2回呼び、2回目のHITと`fetched_at`の保持を確認できます。

9800X3Dの回帰確認（実Yahoo呼出し、通常CIでは実行しない）:

```sh
npm run smoke:yahoo -- --live --jan 0730143315289
npm run worker:dev
# 別ターミナル。local ID 372が9800X3Dの場合
curl http://127.0.0.1:8787/v1/products/372
curl -i http://127.0.0.1:8787/v1/products/372/offers
curl -i http://127.0.0.1:8787/v1/products/372/offers
```

期待値は`lookup.strategy=ean13_as_jan`、全Offerの`jan_code=0730143315289`、2回目HIT。
live実動作確認は1件以上を確認し、件数（以前の手動確認では28件）は固定assertしません。

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
- `offers/identifiers.js`: canonical JAN優先・EAN-13 fallbackの安全なlookup選択。
- `offers/service.js` / `cache.js`: Offer取得のcache・coalescing・外部MISS保護。
- `offers/yahoo-shopping.js`: Yahoo固有transportと共通Offerへの変換。
- `offers/model.js`: Provider非依存の画像メタデータ型（JSDoc）。
- `offers/errors.js`: 公開可能なprovider error。

MPN/manufacturer/name fallbackは未実装です。追加する場合はidentifier選択で明示的なstrategyを返し、
別の照合・確信度ルールを通してから正規化します。strategy／入力ごとにcache keyを分け、
JAN exactの契約を保ってcache世代を更新してください。他Providerは独立transportと正規化関数を追加できます。
plugin framework、価格履歴、アフィリエイト、推定送料、ポイント実質価格、購入処理はありません。

## ローカル検証結果

複数canonical identifier fallback追加時（2026-09-24、production deployなし）:

- `npm test`: 全299 tests成功、skip 0（13 tests追加、既存error testsも複数候補で拡張）。
- `npm run check`: schema check＋全299 tests成功。
- `npm run verify:protection`: 29 tests成功。`git diff --check`成功。
- 候補の全8順位／grouped origins／重複排除、最大3候補、各位置のhit／全空、1番目と2番目のprovider error、
  exact mismatch排除、各実requestのtoken、candidate cache、1秒pacing、同時chainのcoalescing、
  fallback待機中の別MISS burst拒否とHIT許可をfixtureで検証。
- `node scripts/verify-yahoo-fallback-local.js --live`成功。既存local D1と実App IDを使う実workerdで、
  A3-mATXメッシュ版は1番目0件→**2番目hit、2 Offer**、9800X3Dは**1番目hit、1 request、27 Offer**。
  件数は実行時の観測値です。live検証では1件以上と正しいcandidateをassertします。
- 両製品とも2回目はcandidate cache HIT、`rate_limit_status=not_checked`、本文／画像／seller／`fetched_at`維持。
  canonical identifiers保持と、telemetryにコード・商品名・URLがないことも検証。
  bounded結果レポートは`.cache/offer-fallback-live-report.json`。

EAN-13 fallback追加時（2026-09-23、production deployなし）:

- `npm test`: 全286 tests成功、skip 0。既存JAN／画像／sellerの回帰に加え、EAN検証・JAN優先・
  provenance順序・9800X3D fixture・不一致除外・strategy別cache・HIT保護を確認。
- `npm run check`: schema check＋全286 tests成功。
- `npm run verify:protection`: 29 tests成功。通常テストは実App ID／外部ネットワーク不要。
- `npm run smoke:yahoo -- --live --jan 0730143315289`: Yahoo 2xx、28 Offer取得。
- 実ローカルworkerd（隔離port 8792、既存local D1、実App ID）でproduct 372のDetailと
  `/v1/products/372/offers`を検証。200、`ean13_as_jan`、28 Offer、全コード完全一致、価格順・画像／sellerを確認。
  2回目HIT、本文／`fetched_at`維持、`rate_limit_status=not_checked`、EAN／商品名をtelemetryに含めないことを確認。
  件数は実行時の観測値であり、live検証の条件は1件以上のみ。結果は`.cache/offer-ean-live-report.json`。
- この実Worker検証で、既存の`redirect: error`がworkerd未対応で送信前に失敗する問題を発見。
  `manual`＋3xx拒否へ修正し、redirect非追従のテストと実取得に成功。request parameter／CLI引数は維持。

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
