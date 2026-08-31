export const MIN_SPLIT_RATIO = 28;
export const MAX_SPLIT_RATIO = 72;

export function clampSplitRatio(value: number): number {
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, value));
}

export function splitRatioForKey(current: number, key: string, shiftKey = false): number | null {
  if (key === "Home") return MIN_SPLIT_RATIO;
  if (key === "End") return MAX_SPLIT_RATIO;
  const step = shiftKey ? 8 : 2;
  if (key === "ArrowLeft") return clampSplitRatio(current - step);
  if (key === "ArrowRight") return clampSplitRatio(current + step);
  return null;
}
