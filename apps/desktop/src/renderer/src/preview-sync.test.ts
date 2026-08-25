import { describe, expect, it } from "vitest";
import {
  mapSourceOffsetToPreviewY,
  selectionIsInsideAnchor,
  sourceRangesIntersect,
  type PreviewSourceAnchor,
} from "./preview-sync";

function anchor(sourceFrom: number, sourceTo: number, top: number, height: number, kind = "paragraph"): PreviewSourceAnchor {
  return { sourceFrom, sourceTo, top, height, kind };
}

describe("preview source mapping", () => {
  it("maps inside a semantic block instead of using whole-document scroll percentage", () => {
    const anchors = [
      anchor(0, 100, 20, 200),
      anchor(100, 120, 420, 40, "heading"),
      anchor(120, 220, 500, 600),
    ];
    expect(mapSourceOffsetToPreviewY(anchors, 50)).toBe(120);
    expect(mapSourceOffsetToPreviewY(anchors, 170)).toBe(800);
  });

  it("treats SourceRange as half-open at adjacent block boundaries", () => {
    const anchors = [anchor(0, 10, 0, 100), anchor(10, 20, 200, 40, "heading")];
    expect(mapSourceOffsetToPreviewY(anchors, 10)).toBe(200);
  });

  it("interpolates source gaps between adjacent preview anchors", () => {
    const anchors = [anchor(0, 10, 0, 40), anchor(20, 30, 140, 60)];
    expect(mapSourceOffsetToPreviewY(anchors, 15)).toBe(90);
  });

  it("prefers an exact image anchor over its containing paragraph", () => {
    const anchors = [anchor(0, 60, 20, 160), anchor(20, 40, 70, 80, "image")];
    expect(mapSourceOffsetToPreviewY(anchors, 30)).toBe(110);
  });

  it("uses half-open intersection rules and exact containment for selections", () => {
    const block = anchor(10, 20, 0, 10);
    expect(sourceRangesIntersect(block, { from: 0, to: 10 })).toBe(false);
    expect(sourceRangesIntersect(block, { from: 19, to: 25 })).toBe(true);
    expect(selectionIsInsideAnchor(block, { from: 12, to: 18 })).toBe(true);
    expect(selectionIsInsideAnchor(block, { from: 8, to: 18 })).toBe(false);
  });

  it("returns null for an empty or invalid map", () => {
    expect(mapSourceOffsetToPreviewY([], 12)).toBeNull();
    expect(mapSourceOffsetToPreviewY([anchor(3, 3, 0, 20)], 3)).toBeNull();
  });
});