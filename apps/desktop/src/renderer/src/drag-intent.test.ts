import { describe, expect, it } from "vitest";
import { isFileDrag } from "./drag-intent";

describe("isFileDrag", () => {
  it("accepts external files but ignores text and internal tab drags", () => {
    expect(isFileDrag(["Files", "text/plain"])).toBe(true);
    expect(isFileDrag(["text/plain"])).toBe(false);
    expect(isFileDrag([])).toBe(false);
  });
});
