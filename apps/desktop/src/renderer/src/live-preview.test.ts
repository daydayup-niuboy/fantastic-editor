import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { Strikethrough } from "@lezer/markdown";
import { describe, expect, it } from "vitest";
import { collectLivePreviewTokens } from "./live-preview";

function createState(doc: string, anchor = doc.length): EditorState {
  return EditorState.create({
    doc,
    selection: { anchor },
    extensions: [markdown({ extensions: [Strikethrough] })],
  });
}

describe("CodeMirror live preview decorations", () => {
  it("styles fenced code without interpreting HTML or inline Markdown", () => {
    const tokens = collectLivePreviewTokens(createState('```html\n<path />\n**literal**\n```\n正文'));
    expect(tokens.filter(token => token.kind === "code-line")).toHaveLength(4);
    expect(tokens.some(token => token.kind === "strong")).toBe(false);
  });
  it("hides supported Markdown delimiters away from the caret", () => {
    const doc = "# 标题\n\n**粗体** *斜体* ~~删除~~ [链接](https://example.com)\n\n- 项目\n";
    const tokens = collectLivePreviewTokens(createState(doc));
    expect(tokens.some((token) => token.kind === "heading-1")).toBe(true);
    expect(tokens.some((token) => token.kind === "strong")).toBe(true);
    expect(tokens.some((token) => token.kind === "emphasis")).toBe(true);
    expect(tokens.some((token) => token.kind === "strike")).toBe(true);
    expect(tokens.some((token) => token.kind === "link")).toBe(true);
    expect(tokens.some((token) => token.kind === "list-marker" && token.text === "• ")).toBe(true);
  });

  it("reveals the complete inline construct while its text is active", () => {
    const doc = "前 **粗体** 后";
    const caret = doc.indexOf("粗体") + 1;
    const tokens = collectLivePreviewTokens(createState(doc, caret));
    expect(tokens.some((token) => token.kind === "strong")).toBe(true);
    expect(tokens.some((token) => token.kind === "hide")).toBe(false);
  });

  it("keeps an active empty list marker as real editable Markdown", () => {
    const doc = "正文\n\n- ";
    const activeTokens = collectLivePreviewTokens(createState(doc, doc.length));
    expect(activeTokens.some((token) => token.kind === "list-marker")).toBe(false);

    const inactiveTokens = collectLivePreviewTokens(createState(doc, 0));
    expect(inactiveTokens.some((token) => token.kind === "list-marker")).toBe(true);
  });
});
