import { describe, expect, it } from "vitest";
import { MAX_EXTERNAL_HTML_INPUT_CODE_UNITS, htmlToMarkdown, normalizeExternalMarkdown } from "./html-to-markdown";

describe("external HTML converter guardrails", () => {
  it("rejects oversized clipboard HTML before parsing", () => {
    const result = htmlToMarkdown("x".repeat(MAX_EXTERNAL_HTML_INPUT_CODE_UNITS + 1));
    expect(result.truncated).toBe(true);
    expect(result.markdown).toBe("");
    expect(result.warnings[0]).toContain("输入限制");
  });

  it("never returns executable markup in the non-DOM fallback", () => {
    const result = htmlToMarkdown("<script>alert(1)</script><p>正文</p>");
    expect(result.markdown).not.toContain("<script>");
    expect(result.markdown).toContain("alert(1)正文");
  });

  it("normalizes external whitespace without changing inline spaces", () => {
    expect(normalizeExternalMarkdown("第一段\u00a0正文\n \u00a0 \n\n\n第二段  "))
      .toBe("第一段 正文\n\n第二段");
  });
});
