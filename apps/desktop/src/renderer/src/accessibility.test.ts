import { describe, expect, it } from "vitest";
import { MAX_SPLIT_RATIO, MIN_SPLIT_RATIO, clampSplitRatio, splitRatioForKey } from "./accessibility";

describe("accessibility interaction helpers", () => {
  it("clamps split ratios to the supported visual range", () => {
    expect(clampSplitRatio(10)).toBe(MIN_SPLIT_RATIO);
    expect(clampSplitRatio(50)).toBe(50);
    expect(clampSplitRatio(90)).toBe(MAX_SPLIT_RATIO);
  });

  it("supports precise and accelerated keyboard resizing", () => {
    expect(splitRatioForKey(50, "ArrowLeft")).toBe(48);
    expect(splitRatioForKey(50, "ArrowRight", true)).toBe(58);
    expect(splitRatioForKey(50, "Home")).toBe(MIN_SPLIT_RATIO);
    expect(splitRatioForKey(50, "End")).toBe(MAX_SPLIT_RATIO);
    expect(splitRatioForKey(50, "Enter")).toBeNull();
  });
});
