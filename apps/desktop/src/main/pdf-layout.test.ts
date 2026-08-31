import { describe, expect, it } from "vitest";
import {
  estimatePdfPageCount,
  isPdfLayoutAudit,
  PDF_CONTENT_HEIGHT_PX,
  PDF_PREPARE_SCRIPT,
  PDF_PRINT_STYLE,
} from "./pdf-layout.js";

describe("PDF layout contract", () => {
  it("freezes A4 pagination and print-safe complex block rules", () => {
    expect(PDF_PRINT_STYLE).toContain("@page{size:A4 portrait");
    expect(PDF_PRINT_STYLE).toContain("break-after:avoid-page");
    expect(PDF_PRINT_STYLE).toContain("display:table-header-group");
    expect(PDF_PRINT_STYLE).toContain("max-height:245mm");
    expect(PDF_PRINT_STYLE).toContain("white-space:pre-wrap");
    expect(PDF_PRINT_STYLE).toContain("print-color-adjust:exact");
  });

  it("waits for fonts and images and audits wide printable elements", () => {
    expect(PDF_PREPARE_SCRIPT).toContain("document.fonts.ready");
    expect(PDF_PREPARE_SCRIPT).toContain("document.images");
    expect(PDF_PREPARE_SCRIPT).toContain("element.style.zoom");
    expect(PDF_PREPARE_SCRIPT).toContain("unresolvedOverflowElements");
    expect(PDF_PREPARE_SCRIPT).toContain("pageEstimate");
  });

  it("validates the isolated renderer audit payload", () => {
    expect(isPdfLayoutAudit({ scaledElements: 1, unresolvedOverflowElements: 0, imageCount: 2, pageEstimate: 3 })).toBe(true);
    expect(isPdfLayoutAudit({ scaledElements: 1, unresolvedOverflowElements: -1, imageCount: 2, pageEstimate: 3 })).toBe(false);
    expect(isPdfLayoutAudit({ scaledElements: 1, unresolvedOverflowElements: 0, imageCount: 2 })).toBe(false);
  });

  it("estimates pages using the printable A4 content height", () => {
    expect(estimatePdfPageCount(0)).toBe(1);
    expect(estimatePdfPageCount(PDF_CONTENT_HEIGHT_PX)).toBe(1);
    expect(estimatePdfPageCount(PDF_CONTENT_HEIGHT_PX + 1)).toBe(2);
    expect(estimatePdfPageCount(Number.NaN)).toBe(1);
  });
});