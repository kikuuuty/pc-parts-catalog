// Only authored messages and bounded reasons may cross the transport boundary.
export class OfferProviderError extends Error {
  constructor(reason, status = 502, code = 'OFFER_PROVIDER_ERROR', retryAfter = null) {
    super(code === 'OFFER_PROVIDER_RATE_LIMITED' ? 'Offer provider temporarily rate limited'
      : code === 'OFFER_PROVIDER_UNAVAILABLE' ? 'Offer provider temporarily unavailable' : 'Offer provider request failed');
    Object.assign(this, { reason, status, code, retryAfter });
  }
}

export const unavailable = reason => new OfferProviderError(reason, 503, 'OFFER_PROVIDER_UNAVAILABLE', 30);
export const rateLimited = (reason, retryAfter = 60) => new OfferProviderError(reason, 503, 'OFFER_PROVIDER_RATE_LIMITED', retryAfter);
