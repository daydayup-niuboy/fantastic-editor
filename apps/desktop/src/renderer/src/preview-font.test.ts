import { describe, expect, it } from "vitest";
import { DEFAULT_PREVIEW_FONT, DEFAULT_PREVIEW_FONT_SIZE, DEFAULT_READING_WIDTH, PREVIEW_FONT_PRESETS, commitPreviewFontDraft, normalizePreviewFontName, normalizePreviewFontSize, normalizeReadingWidth, normalizeReadingWidthPx, previewFontStack, readingWidthMaxWidth, readingWidthPxFromPreset } from "./preview-font";

describe("preview font preference", () => {
  it("accepts a local font name and builds a safe fallback stack", () => {
    expect(normalizePreviewFontName("  Microsoft   YaHei UI  ")).toBe("Microsoft YaHei UI");
    expect(PREVIEW_FONT_PRESETS).toContain("Arial");
    expect(previewFontStack("Arial")).toBe('"Arial", "Segoe UI", sans-serif');
    expect(previewFontStack("KaiTi")).toBe('"KaiTi", "Segoe UI", sans-serif');
  });

  it("rejects CSS injection and invalid stored values", () => {
    expect(normalizePreviewFontName("Arial; color:red")).toBe(DEFAULT_PREVIEW_FONT);
    expect(normalizePreviewFontName("\u0000Bad")).toBe(DEFAULT_PREVIEW_FONT);
    expect(normalizePreviewFontName(null)).toBe(DEFAULT_PREVIEW_FONT);
  });

  it("commits typed custom fonts while an empty draft keeps the current font", () => {
    expect(commitPreviewFontDraft("  Noto Sans CJK SC  ", "Arial")).toBe("Noto Sans CJK SC");
    expect(commitPreviewFontDraft("", "KaiTi")).toBe("KaiTi");
  });

  it("normalizes bounded reading preferences", () => {
    expect(normalizeReadingWidth("wide")).toBe("wide");
    expect(normalizeReadingWidth("invalid")).toBe(DEFAULT_READING_WIDTH);
    expect(readingWidthMaxWidth("full")).toBe("none");
    expect(normalizeReadingWidthPx(200)).toBe(360);
    expect(normalizeReadingWidthPx(720)).toBe(720);
    expect(normalizeReadingWidthPx(9999)).toBe(1400);
    expect(readingWidthPxFromPreset("narrow")).toBe(680);
    expect(readingWidthPxFromPreset("full", 1100)).toBe(1100);
    expect(normalizePreviewFontSize(9)).toBe(10);
    expect(normalizePreviewFontSize(10)).toBe(10);
    expect(normalizePreviewFontSize(48)).toBe(48);
    expect(normalizePreviewFontSize(99)).toBe(48);
    expect(normalizePreviewFontSize("bad")).toBe(DEFAULT_PREVIEW_FONT_SIZE);
  });
});
