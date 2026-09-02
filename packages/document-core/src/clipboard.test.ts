import { describe, expect, it } from "vitest";
import {
  auditGeneratedHtmlMarkup,
  buildClipboardPayload,
  clipboardPlainHash,
  renderMarkdownFragmentHtml,
  sanitizeClipboardMarkdown,
} from "./index.js";

describe("clipboard contract", () => {
  it("sanitizes private image targets while preserving code", () => {
    expect(sanitizeClipboardMarkdown("![x](file:///tmp/x) [bad](http://localhost:1234/x) `![keep](file:x)`"))
      .toBe("![x]（图片未包含） bad `![keep](file:x)`");
  });

  it("builds a verified internal dual-format payload", () => {
    const payload = buildClipboardPayload("# 标题\n\n**正文**与[链接](https://example.com)。");
    expect(payload.plain).toBe("# 标题\n\n**正文**与[链接](https://example.com)。");
    expect(payload.html).toContain('data-fantastic-clipboard="v1"');
    expect(payload.html).toContain("<h1>标题</h1>");
    expect(payload.html).toContain('<a href="https://example.com">链接</a>');
    expect(payload.html).toContain(`data-fantastic-plain-length="${payload.plain.length}"`);
    expect(payload.html).toContain(`data-fantastic-plain-hash="fnv1a32:${clipboardPlainHash(payload.plain)}"`);
    expect(auditGeneratedHtmlMarkup(payload.html ?? "")).toEqual([]);
  });

  it("keeps generated output free of unsafe resource URLs", () => {
    expect(auditGeneratedHtmlMarkup(renderMarkdownFragmentHtml("![图](file:///secret)"))).toEqual([]);
  });
});
