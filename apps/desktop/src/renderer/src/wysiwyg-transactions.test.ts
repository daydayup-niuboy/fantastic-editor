import { describe, expect, it } from "vitest";
import {
  applyWysiwygTextChange,
  escapeMarkdownText,
  isValidSourceRange,
  preserveTrailingLineBreaks,
} from "./wysiwyg-transactions";

describe("WYSIWYG text transactions", () => {
  it("applies only a validated source range against the expected snapshot", () => {
    const source = "# 标题\n\n正文\n";
    expect(applyWysiwygTextChange(source, {
      from: 6,
      to: 8,
      insert: "新正文",
      expectedText: source,
    })).toBe("# 标题\n\n新正文\n");
    expect(applyWysiwygTextChange(source + "迟到", {
      from: 6,
      to: 8,
      insert: "错误写入",
      expectedText: source,
    })).toBeNull();
  });

  it("rejects invalid and out-of-range offsets", () => {
    expect(isValidSourceRange({ from: -1, to: 2 }, 4)).toBe(false);
    expect(isValidSourceRange({ from: 3, to: 2 }, 4)).toBe(false);
    expect(isValidSourceRange({ from: 1, to: 5 }, 4)).toBe(false);
    expect(isValidSourceRange({ from: 1, to: 4 }, 4)).toBe(true);
  });

  it("preserves the original block trailing line breaks", () => {
    expect(preserveTrailingLineBreaks("原文\n\n", "新内容\n")).toBe("新内容\n\n");
    expect(preserveTrailingLineBreaks("原文", "新内容\n")).toBe("新内容");
  });

  it("escapes Markdown punctuation introduced as plain text", () => {
    expect(escapeMarkdownText("a * b [c] \\ d")).toBe("a \\* b \\[c\\] \\\\ d");
  });
});
