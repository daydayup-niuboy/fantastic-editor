import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { Strikethrough } from "@lezer/markdown";
import { describe, expect, it } from "vitest";
import { collectLivePreviewTokens, livePreviewMarkdownHighlight } from "./live-preview";

function createState(doc: string, anchor = doc.length): EditorState {
  return EditorState.create({
    doc,
    selection: { anchor },
    extensions: [markdown({ extensions: [Strikethrough, livePreviewMarkdownHighlight] })],
  });
}

describe("CodeMirror live preview decorations", () => {
  it("applies paragraph styling to every hard-broken line", () => {
    const doc = "1、提供样品。  \n2、确认型号。  \n3、发送资料。";
    const state = createState(doc);
    const tokens = collectLivePreviewTokens(state).filter((token) => token.kind === "paragraph-line");
    expect(tokens.map((token) => token.from)).toEqual([1, 2, 3].map((number) => state.doc.line(number).from));
    expect(collectLivePreviewTokens(state, state.doc.line(2).from, state.doc.line(2).to)
      .filter((token) => token.kind === "paragraph-line").map((token) => token.from))
      .toEqual([state.doc.line(2).from]);
  });

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

  it("keeps heading markers hidden while the heading text is active", () => {
    const doc = "# 正在编辑的标题";
    const tokens = collectLivePreviewTokens(createState(doc, doc.indexOf("标题")));
    expect(tokens).toContainEqual({ from: 0, to: 2, kind: "hide" });
    expect(tokens.some((token) => token.kind === "heading-1")).toBe(true);
  });

  it("replaces the list marker and its source whitespace with one visual marker", () => {
    const doc = "- 项目\n\n正文";
    expect(collectLivePreviewTokens(createState(doc)).find((token) => token.kind === "list-marker"))
      .toEqual({ from: 0, to: 2, kind: "list-marker", text: "• " });
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

  it("projects menu-inserted ==highlight== markup and hides its delimiters when inactive", () => {
    const doc = "==重点==\n\n尾";
    const inactive = collectLivePreviewTokens(createState(doc, doc.length));
    expect(inactive).toContainEqual({ from: 2, to: 4, kind: "highlight" });
    expect(inactive).toContainEqual({ from: 0, to: 2, kind: "hide" });
    expect(inactive).toContainEqual({ from: 4, to: 6, kind: "hide" });
    expect(collectLivePreviewTokens(createState(doc, 3)).some(token => token.kind === "hide")).toBe(false);
    expect(collectLivePreviewTokens(createState("===不匹配==")).some(token => token.kind === "highlight")).toBe(false);
  });

  it("projects an inactive thematic break and reveals its source while editing", () => {
    const doc = "上文\n\n---\n\n下文";
    expect(collectLivePreviewTokens(createState(doc, 0))).toContainEqual({ from: 4, to: 7, kind: "thematic-break" });
    expect(collectLivePreviewTokens(createState(doc, 5)).some((token) => token.kind === "thematic-break")).toBe(false);
  });

  it("keeps every decoration range valid for a multiline blockquote", () => {
    const doc = [
      "# Markdown 编辑器 SVG 支持测试",
      "",
      "> 用途：检测内联 SVG。",
      ">",
      "> 使用方法：在编辑器中打开预览。",
      "",
      "---",
      "",
      "## 预期对照",
      "",
      "| 区块 | 通过标准 |",
      "|---|---|",
      "| SVG | 显示图形 |",
    ].join("\n");
    const tokens = collectLivePreviewTokens(createState(doc));

    expect(tokens.every((token) => token.from <= token.to)).toBe(true);
    expect(tokens.filter((token) => token.kind === "hide" && doc.slice(token.from, token.to).trim() === ">"))
      .toHaveLength(3);
    expect(tokens.some((token) => token.kind === "thematic-break")).toBe(true);
  });

  it("projects inactive task items as toggleable checkboxes without changing ordinary lists", () => {
    const doc = "- [x] 已完成\n  - [ ] 待处理\n- 普通项目\n";
    const tokens = collectLivePreviewTokens(createState(doc));
    expect(tokens).toContainEqual({ from: 0, to: 6, kind: "task-marker", checked: true, toggleAt: 3 });
    expect(tokens).toContainEqual({ from: 12, to: 18, kind: "task-marker", checked: false, toggleAt: 15 });
    expect(tokens.some((token) => token.kind === "link")).toBe(false);
    expect(tokens.some((token) => token.kind === "list-marker" && token.text === "• ")).toBe(true);
  });

  it("reveals canonical task syntax while the task item is active", () => {
    const doc = "- [x] 已完成\n";
    const tokens = collectLivePreviewTokens(createState(doc, doc.indexOf("已完成")));
    expect(tokens.some((token) => token.kind === "task-marker")).toBe(false);
  });

  it("keeps a parent task projected while editing a nested task line", () => {
    const doc = "- [x] 父任务\n  - [ ] 子任务\n";
    const tokens = collectLivePreviewTokens(createState(doc, doc.indexOf("子任务")));
    expect(tokens).toContainEqual({ from: 0, to: 6, kind: "task-marker", checked: true, toggleAt: 3 });
    expect(tokens.some((token) => token.kind === "task-marker" && token.from === 12)).toBe(false);
  });

  it("can keep a just-toggled task projected while placing the caret in its content", () => {
    const doc = "- [ ] 待处理\n";
    const contentAt = doc.indexOf("待处理");
    const tokens = collectLivePreviewTokens(createState(doc, contentAt), 0, doc.length, 0);
    expect(tokens).toContainEqual({ from: 0, to: 6, kind: "task-marker", checked: false, toggleAt: 3 });
  });
});
