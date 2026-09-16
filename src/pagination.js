// Keyword ranking is bounded; indexed filter/list views can traverse the entire
// reviewed catalog envelope. Cache admission remains the first six GET pages.
export const searchWindow = input => input.keyword === undefined ? 100000 : 1000;
