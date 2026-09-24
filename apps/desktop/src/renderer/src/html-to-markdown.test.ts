import { describe, expect, it } from "vitest";
import { MAX_EXTERNAL_HTML_INPUT_CODE_UNITS, htmlToMarkdown, normalizeExternalMarkdown } from "./html-to-markdown";

describe("external HTML converter guardrails", () => {
  it("rejects oversized clipboard HTML before parsing", () => {
    const result = htmlToMarkdown("x".repeat(MAX_EXTERNAL_HTML_INPUT_CODE_UNITS + 1));
    expect(result.truncated).toBe(true);
    expect(result.markdown).toBe("");
    expect(result.warnings[0]).toContain("输入限制");
  });

  it("drops application-only theme decoration when converting pasted HTML", () => {
    const result = htmlToMarkdown('<h2><span data-fantastic-theme-decoration="true" aria-hidden="true">✦</span>章节标题</h2>');
    expect(result.markdown).not.toContain("✦");
    expect(result.markdown).toContain("章节标题");
  });

  it("removes mixed Word body font sizes instead of persisting them", () => {
    const result = htmlToMarkdown([
      '<h2><span style="font-family:Calibri;font-size:20pt">章节标题</span></h2>',
      '<p class="MsoNormal"><span style="font-family:Calibri;font-size:10pt">较小正文</span></p>',
      '<p class="MsoNormal"><font face="宋体" size="5">较大正文</font></p>',
    ].join(""));

    expect(result.markdown).toContain("章节标题");
    expect(result.markdown).toContain("较小正文");
    expect(result.markdown).toContain("较大正文");
    expect(result.markdown).not.toMatch(/font|size|style/i);
    expect(result.warnings).toContain("已统一粘贴内容的正文字体与字号；标题层级保持不变。");
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
