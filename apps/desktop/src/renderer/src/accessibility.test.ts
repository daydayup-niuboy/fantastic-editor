import { describe, expect, it } from "vitest";
import { DEFAULT_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, MAX_SPLIT_RATIO, MIN_SIDEBAR_WIDTH, MIN_SPLIT_RATIO, clampSidebarWidth, clampSplitRatio, sidebarWidthForKey, splitRatioForKey } from "./accessibility";

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

  it("clamps and keyboard-resizes the resource explorer", () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(DEFAULT_SIDEBAR_WIDTH);
    expect(clampSidebarWidth(100)).toBe(MIN_SIDEBAR_WIDTH);
    expect(clampSidebarWidth(800)).toBe(MAX_SIDEBAR_WIDTH);
    expect(sidebarWidthForKey(222, "ArrowLeft")).toBe(212);
    expect(sidebarWidthForKey(222, "ArrowRight", true)).toBe(262);
    expect(sidebarWidthForKey(222, "Home")).toBe(MIN_SIDEBAR_WIDTH);
    expect(sidebarWidthForKey(222, "End")).toBe(MAX_SIDEBAR_WIDTH);
    expect(sidebarWidthForKey(222, "Enter")).toBeNull();
  });
});
