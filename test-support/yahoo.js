// Synthetic test identifiers with valid check digits, not catalog assertions.
export const JAN = '0012345678905';
export const OTHER_JAN = '4901234567894';
// Real regression: local catalog product 372, snapshot eec0df17 (no canonical JAN).
export const RYZEN_EAN = '0730143315289';
export const ryzen9800 = {
  metadata: { name: 'AMD Ryzen 7 9800X3D', manufacturer: 'AMD', part_numbers: ['100-100001084WOF'] },
  identifiers: { version: 1, identifiers: [
    ...[RYZEN_EAN, '4068688517315', '4988755070539', '7301433152896'].map(value => ({ type: 'ean', value, region: 'all' })),
    { type: 'mpn', value: '100-100001084WOF', region: 'all' },
    { type: 'upc', value: '730143315289', region: 'all' },
  ] },
};
// Canonical local D1 product 22309, upstream PCCase/a00aa6fd-61a1-41a7-a259-debd7cdb7cf4.
// White / Brown Wood Mesh (not the separate tempered-glass variant), checked 2026-09-24.
export const A3_FIRST_EAN = '0840353046559';
export const A3_YAHOO_EAN = '4718466015815';
export const a3WhiteWoodMesh = {
  opendb_id: 'a00aa6fd-61a1-41a7-a259-debd7cdb7cf4',
  metadata: { name: 'Lian Li A3-mATX Micro ATX Mini Tower White / Brown Wood Mesh Side Panel', manufacturer: 'Lian Li' },
  side_panel: 'Mesh',
  identifiers: { version: 1, identifiers: [
    ...[A3_FIRST_EAN, A3_YAHOO_EAN].map(value => ({ type: 'ean', value, region: 'all' })),
    ...['A3-MATX-WD WHITE', 'A3-mATX-WD White', 'A3W-WD', 'G99.A3W-WD.00', 'PC-A3W-WD']
      .map(value => ({ type: 'mpn', value, region: 'all' })),
    { type: 'upc', value: '840353046559', region: 'all' },
  ] },
};
export const yahooHit = (changes = {}) => ({
  name: 'Example PC part', code: 'tsukumo-y_item', janCode: JAN, price: 69800,
  imageId: 'example-product-image',
  image: { small: 'https://item-shopping.c.yimg.jp/i/c/example', medium: 'https://item-shopping.c.yimg.jp/i/g/example' },
  exImage: { url: 'https://item-shopping.c.yimg.jp/i/n/example?size=300', width: 300, height: 300 },
  seller: { sellerId: 'tsukumo-y', name: 'ツクモ パソコン Yahoo!店', url: 'https://store.shopping.yahoo.co.jp/tsukumo-y/', isBestSeller: true, imageId: 'example-seller-image' },
  shipping: { code: 2, name: '送料無料' }, inStock: true, condition: 'new',
  url: 'https://store.shopping.yahoo.co.jp/tsukumo-y/item.html', ...changes,
});
export const yahooBody = hits => ({ totalResultsAvailable: hits.length, totalResultsReturned: hits.length, firstResultsPosition: 1, hits });
