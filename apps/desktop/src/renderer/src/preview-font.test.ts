import { describe, expect, it } from "vitest";
import { DEFAULT_PREVIEW_FONT, normalizePreviewFontName, previewFontStack } from "./preview-font";

describe("preview font preference", () => {
  it("accepts a local font name and builds a safe fallback stack", () => {
    expect(normalizePreviewFontName("  Microsoft   YaHei UI  ")).toBe("Microsoft YaHei UI");
    expect(previewFontStack("KaiTi")).toBe('"KaiTi", "Segoe UI", sans-serif');
  });

  it("rejects CSS injection and invalid stored values", () => {
    expect(normalizePreviewFontName("Arial; color:red")).toBe(DEFAULT_PREVIEW_FONT);
    expect(normalizePreviewFontName("\u0000Bad")).toBe(DEFAULT_PREVIEW_FONT);
    expect(normalizePreviewFontName(null)).toBe(DEFAULT_PREVIEW_FONT);
  });
});
