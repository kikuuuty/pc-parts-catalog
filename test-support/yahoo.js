// Synthetic test identifiers with valid check digits, not catalog assertions.
export const JAN = '0012345678905';
export const OTHER_JAN = '4901234567894';
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
