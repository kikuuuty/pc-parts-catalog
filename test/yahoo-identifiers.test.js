import test from 'node:test';
import assert from 'node:assert/strict';
import { validEan13, selectYahooLookup } from '../src/offers/identifiers.js';
import { canonicalIdentifiers } from '../src/product-detail.js';
import { offerCachePolicy } from '../src/offers/cache.js';
import { JAN, OTHER_JAN, RYZEN_EAN, ryzen9800 } from '../test-support/yahoo.js';

const ean = (value = RYZEN_EAN, region = 'all', origin = 'upstream') => ({ type: 'ean', value, region, origin, origin_field: 'identifiers' });

test('valid JAN wins before any EAN candidate is evaluated, including JAN-8 and trim-only JAN', () => {
  const inaccessibleEan = { type: 'ean', get region() { assert.fail('EAN must not be evaluated'); } };
  for (const value of [JAN, ` ${JAN} `, '00123457']) {
    const jan = { ...ean(value, 'jp'), type: 'jan' };
    for (const rows of [[jan], [ean(), jan], [jan, inaccessibleEan], [inaccessibleEan, jan]]) {
      assert.deepEqual(selectYahooLookup(rows), { strategy: 'jan', identifier_type: 'jan', value: value.trim() });
    }
  }
});

test('EAN-13 fallback preserves leading zero and never changes canonical metadata', () => {
  const identifiers = canonicalIdentifiers(ryzen9800.identifiers.identifiers.map(i => ({ ...i, origin: 'upstream', origin_field: 'identifiers' })));
  const original = structuredClone(identifiers);
  assert.deepEqual(selectYahooLookup(identifiers), { strategy: 'ean13_as_jan', identifier_type: 'ean', value: RYZEN_EAN });
  assert.deepEqual(identifiers, original);
  assert(validEan13(RYZEN_EAN));
  // Unsupported JAN rows do not block a supported EAN.
  for (const jan of [{ type: 'jan', value: 'bad', region: 'jp' }, { type: 'jan', value: JAN, region: 'us' }]) {
    assert.equal(selectYahooLookup([jan, ean()]).strategy, 'ean13_as_jan');
  }
});

test('EAN validation rejects non-EAN-13 formats without padding, coercion or whitespace repair', () => {
  for (const value of ['0730143315288', '00123457', '730143315289', '00730143315289', 730143315289,
    '０７３０１４３３１５２８９', '0730143-315289', '0730143 315289', ` ${RYZEN_EAN}`, `${RYZEN_EAN} `,
    `${RYZEN_EAN}\n`, '0000000000000', '', null, undefined]) {
    assert.equal(validEan13(value), false, String(value));
    assert.equal(selectYahooLookup([{ ...ean(), value }]), null, String(value));
  }
  for (const type of ['upc', 'gtin', 'mpn']) assert.equal(selectYahooLookup([{ ...ean(), type }]), null);
  assert.equal(selectYahooLookup([]), null);
});

test('EAN region must be jp or all; absent/null and other-country regions stay unsupported', () => {
  for (const region of ['jp', 'all']) assert.equal(selectYahooLookup([ean(RYZEN_EAN, region)]).strategy, 'ean13_as_jan');
  for (const region of ['us', 'eu', 'JP', '', null, undefined]) {
    assert.equal(selectYahooLookup([{ ...ean(), region }]), null);
  }
  const missing = ean(); delete missing.region;
  assert.equal(selectYahooLookup([missing]), null);
});

test('multiple EANs retain JAN region/local/lexical priority and canonical provenance grouping', () => {
  const rows = [ean(JAN, 'all', 'local'), ean(RYZEN_EAN, 'jp'), ean(OTHER_JAN, 'jp'), ean(OTHER_JAN, 'jp', 'local')];
  for (const order of [rows, [...rows].reverse(), [rows[2], rows[0], rows[3], rows[1]]]) {
    assert.equal(selectYahooLookup(canonicalIdentifiers(order)).value, OTHER_JAN);
  }
  assert.equal(selectYahooLookup([ean(OTHER_JAN), ean(JAN)]).value, JAN);
  assert.equal(selectYahooLookup([ean(OTHER_JAN, 'all', 'local'), ean(JAN, 'jp')]).value, JAN);
});

test('EAN strategy has an independent cache key; existing JAN v2 key and payload namespace remain stable', () => {
  const origin = new URL('https://catalog.example');
  const env = { CATALOG_CACHE_EPOCH: 'offers-test' };
  const jan = offerCachePolicy(origin, { strategy: 'jan', value: RYZEN_EAN }, env);
  const eanPolicy = offerCachePolicy(origin, selectYahooLookup([ean()]), env);
  assert.equal(jan.key.url, `https://catalog.example/__catalog_cache/offers/yahoo/v2?epoch=offers-test&ttl=1800&strategy=jan&identifier=${RYZEN_EAN}`);
  assert.equal(eanPolicy.key.url, jan.key.url.replace('strategy=jan&', 'strategy=ean13_as_jan&'));
  assert.notEqual(jan.key.url, eanPolicy.key.url);
});
