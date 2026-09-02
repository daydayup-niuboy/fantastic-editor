import { describe, expect, it } from "vitest";
import { buildClipboardPayload } from "@fantastic-editor/document-core";
import { resolveClipboardPaste } from "./clipboard-paste";

describe("clipboard paste resolver", () => {
  it("prefers a verified fantastic-editor payload over HTML", () => {
    const payload = buildClipboardPayload("# 标题\n\n**正文**");
    const resolved = resolveClipboardPaste({ plainText: payload.plain, ...(payload.html ? { htmlText: payload.html } : {}) });
    expect(resolved.source).toBe("internal");
    expect(resolved.markdown).toBe(payload.plain);
  });

  it("supports literal paste without interpreting Markdown", () => {
    const resolved = resolveClipboardPaste({ plainText: "# 标题\n- 项目", intent: "literal" });
    expect(resolved.source).toBe("literal");
    expect(resolved.markdown).toContain("\\# 标题");
    expect(resolved.markdown).toContain("\\- 项目");
  });

  it("falls back safely when an internal marker is incomplete", () => {
    const resolved = resolveClipboardPaste({ plainText: "普通文本", htmlText: '<div data-fantastic-clipboard="v1">普通文本</div>' });
    expect(resolved.markdown).toBe("普通文本");
    expect(resolved.source).toBe("plain");
  });

  it("preserves Markdown-shaped ChatGPT clipboard text instead of escaping it again", () => {
    const markdown = "# 金融基础\n\n**金融**，简单说就是管理钱。\n\n> 钱是工具。\n\n- 储蓄\n- 投资";
    const resolved = resolveClipboardPaste({
      plainText: markdown,
      htmlText: `<div>${markdown}</div>`,
    });
    expect(resolved.source).toBe("markdown");
    expect(resolved.markdown).toBe(markdown);
    expect(resolved.markdown).not.toContain("\\#");
    expect(resolved.markdown).not.toContain("\\*\\*");
  });

  it("repairs Markdown structure that a webpage clipboard escaped once", () => {
    const escaped = "\\# 金融基础\n\n\\*\\*金融\\*\\*，简单说就是管理钱。\n\n\\> 钱是工具。\n\n1\\. 储蓄\n2\\. 投资";
    const resolved = resolveClipboardPaste({ plainText: escaped, htmlText: `<div>${escaped}</div>` });
    expect(resolved.source).toBe("markdown");
    expect(resolved.markdown).toBe("# 金融基础\n\n**金融**，简单说就是管理钱。\n\n> 钱是工具。\n\n1. 储蓄\n2. 投资");
  });

  it("uses one plain copy when webpage HTML repeats the selected article", () => {
    const plainText = "这是一段足够长的正文，用于模拟网页可见内容。".repeat(8);
    const htmlText = `<div>${plainText}</div><div hidden>${plainText}</div><div aria-hidden="true">${plainText}</div>`;
    const resolved = resolveClipboardPaste({ plainText, htmlText });
    expect(resolved.source).toBe("plain");
    expect(resolved.markdown).toBe(plainText);
    expect(resolved.warnings).toContain("检测到网页富文本包含重复正文，已改用单份纯文本内容。");
  });

  it("removes non-breaking and whitespace-only blank lines from external text", () => {
    const resolved = resolveClipboardPaste({ plainText: "第一段\n\u00a0  \n\n\n第二段" });
    expect(resolved.markdown).toBe("第一段\n\n第二段");
  });

  it("prefers semantic rich HTML when an IMA-style plain copy only resembles Markdown", () => {
    const resolved = resolveClipboardPaste({
      plainText: "\\# IMA 标题\n\\- 一级\n  \\- 二级",
      htmlText: "<h1>IMA 标题</h1><ul><li><strong>一级</strong><ul><li>二级</li></ul></li></ul>",
    });
    expect(resolved.source).toBe("html");
    expect(resolved.markdown).not.toContain("\\# IMA 标题");
  });

  it("keeps the complete plain selection when IMA exposes only part of it as rich HTML", () => {
    const plainText = "# 完整标题\n\n" + "完整正文段落。".repeat(30) + "\n\n## 结尾";
    const resolved = resolveClipboardPaste({
      plainText,
      htmlText: "<h1>完整标题</h1><p>完整正文段落。</p>",
    });
    expect(resolved.source).toBe("plain");
    expect(resolved.markdown).toBe(plainText);
    expect(resolved.warnings).toContain("富文本剪贴板正文不完整，已优先保留较完整的纯文本内容。");
  });
});
