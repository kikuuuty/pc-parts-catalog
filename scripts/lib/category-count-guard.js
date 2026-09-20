export const CATEGORY_MIN_RATIO = 0.8;
export const CATEGORY_MAX_RATIO = 1.5;
export const CATEGORY_ABSOLUTE_GROWTH_ALLOWANCE = 10;

export function categoryCountBounds(previousCount) {
  return {
    min: previousCount * CATEGORY_MIN_RATIO,
    max: Math.max(previousCount * CATEGORY_MAX_RATIO, previousCount + CATEGORY_ABSOLUTE_GROWTH_ALLOWANCE),
  };
}

export function categoryCountDeltaError(category, previousCount, newCount) {
  const { min, max } = categoryCountBounds(previousCount);
  return newCount >= min && newCount <= max
    ? null
    : `Unexpected category count delta: ${category} ${previousCount} -> ${newCount} (allowed ${min}..${max})`;
}
