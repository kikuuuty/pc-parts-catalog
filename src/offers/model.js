// Provider-neutral image metadata in the public Offer contract. IDs are opaque
// provider identifiers; URLs are references, never derived from those IDs.
/**
 * @typedef {Object} ImageVariant
 * @property {string} url
 * @property {number|null} width Positive integer pixels, or unknown.
 * @property {number|null} height Positive integer pixels, or unknown.
 */

/**
 * @typedef {Object} OfferImage
 * @property {string|null} id
 * @property {ImageVariant|null} small
 * @property {ImageVariant|null} medium
 * @property {ImageVariant|null} preferred Normal display variant, if provided.
 */

/**
 * @typedef {Object} SellerImage
 * @property {string|null} id
 * @property {string|null} url
 */

export {};
