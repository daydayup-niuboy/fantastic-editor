import { describe, expect, it } from "vitest";
import { adjacentTabIndex, moveTabIndexForKey, moveTabItem, tabIndexForNavigationKey } from "./tab-navigation";

describe("document tab keyboard navigation", () => {
  it("cycles in both directions and wraps at the ends", () => {
    expect(adjacentTabIndex(3, 0, -1)).toBe(2);
    expect(adjacentTabIndex(3, 2, 1)).toBe(0);
    expect(adjacentTabIndex(3, 1, 1)).toBe(2);
    expect(adjacentTabIndex(0, 0, 1)).toBeNull();
  });

  it("maps arrow, Home and End keys without consuming unrelated keys", () => {
    expect(tabIndexForNavigationKey(4, 2, "ArrowLeft")).toBe(1);
    expect(tabIndexForNavigationKey(4, 2, "ArrowRight")).toBe(3);
    expect(tabIndexForNavigationKey(4, 2, "Home")).toBe(0);
    expect(tabIndexForNavigationKey(4, 2, "End")).toBe(3);
    expect(tabIndexForNavigationKey(4, 2, "Enter")).toBeNull();
  });

  it("moves tabs only for the explicit Alt+Shift keyboard gesture", () => {
    expect(moveTabIndexForKey(3, 1, "ArrowLeft", true, true)).toBe(0);
    expect(moveTabIndexForKey(3, 1, "ArrowRight", true, true)).toBe(2);
    expect(moveTabIndexForKey(3, 0, "ArrowLeft", true, true)).toBeNull();
    expect(moveTabIndexForKey(3, 1, "ArrowLeft", false, true)).toBeNull();
  });

  it("reorders without mutating the original tab list", () => {
    const original = ["a", "b", "c"];
    expect(moveTabItem(original, 0, 2)).toEqual(["b", "c", "a"]);
    expect(original).toEqual(["a", "b", "c"]);
    expect(moveTabItem(original, -1, 2)).toEqual(original);
  });
});
