import { parseArgs } from 'node:util';
import { validJan } from '../src/offers/identifiers.js';
import { fetchYahooOffers } from '../src/offers/yahoo-shopping.js';
import { OfferProviderError } from '../src/offers/errors.js';

// Explicit manual transport smoke only; never imported by CI/unit/release validation.
try {
  const { values } = parseArgs({ options: { live: { type: 'boolean', default: false }, jan: { type: 'string' } } });
  if (!values.live || !validJan(values.jan)) throw Error('Use --live --jan <verified JAN string>');
  if (!process.env.YAHOO_SHOPPING_APP_ID?.trim()) throw Error('Set YAHOO_SHOPPING_APP_ID in .dev.vars.local or the environment');
  const event = {};
  const offers = await fetchYahooOffers({ appId: process.env.YAHOO_SHOPPING_APP_ID, jan: values.jan.trim(), event });
  // Deliberately omit URL, JAN, product names, response body and credentials even in this CLI.
  console.log(JSON.stringify({ ok: true, provider: 'yahoo', offer_count: offers.length, ...event }));
} catch (error) {
  console.error(error instanceof OfferProviderError ? `${error.code}: ${error.reason}`
    : 'Smoke not run: use --live --jan <verified JAN string> and set YAHOO_SHOPPING_APP_ID in .dev.vars.local or the environment.');
  process.exitCode = 1;
}
