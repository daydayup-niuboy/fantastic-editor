import { describe, expect, it } from "vitest";
import { DEFAULT_SIDEBAR_WIDTH, DEFAULT_WECHAT_INSPECTOR_WIDTH, MAX_SIDEBAR_WIDTH, MAX_SPLIT_RATIO, MAX_WECHAT_INSPECTOR_WIDTH, MIN_SIDEBAR_WIDTH, MIN_SPLIT_RATIO, MIN_WECHAT_INSPECTOR_WIDTH, clampSidebarWidth, clampSplitRatio, clampWechatInspectorWidth, sidebarWidthForKey, splitRatioForKey, wechatInspectorWidthForKey } from "./accessibility";

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

  it("clamps and keyboard-resizes the right WeChat inspector from its left edge", () => {
    expect(clampWechatInspectorWidth(Number.NaN)).toBe(DEFAULT_WECHAT_INSPECTOR_WIDTH);
    expect(clampWechatInspectorWidth(100)).toBe(MIN_WECHAT_INSPECTOR_WIDTH);
    expect(clampWechatInspectorWidth(900)).toBe(MAX_WECHAT_INSPECTOR_WIDTH);
    expect(wechatInspectorWidthForKey(360, "ArrowLeft")).toBe(370);
    expect(wechatInspectorWidthForKey(360, "ArrowRight", true)).toBe(320);
    expect(wechatInspectorWidthForKey(360, "Home")).toBe(MIN_WECHAT_INSPECTOR_WIDTH);
    expect(wechatInspectorWidthForKey(360, "End")).toBe(MAX_WECHAT_INSPECTOR_WIDTH);
  });
});
