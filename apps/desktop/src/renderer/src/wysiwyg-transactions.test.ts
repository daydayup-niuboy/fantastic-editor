import { describe, expect, it } from "vitest";
import {
  applyWysiwygTextChange,
  markdownBlockDuplicateInsertion,
  markdownBlockPreset,
  createMarkdownBlockMove,
  swapMarkdownListSubtrees,
  replaceMarkdownListItemOwnContent,
  markdownListItemDetails,
  createMarkdownListSibling,
  exitMarkdownListItemLevel,
  createMarkdownBlockInsertion,
  createCrossBlockFormatChange,
  createCrossBlockReplacement,
  mergeMarkdownBlocks,
  normalizeCrossBlockPlainText,
  mergeListItems,
  markdownFenceDetails,
  markdownFormulaDetails,
  markdownImageAlt,
  markdownInlineCodeDetails,
  markdownInlineLinkDetails,
  markdownTableDetails,
  replaceMarkdownFence,
  replaceMarkdownFormulaLatex,
  replaceMarkdownImageAlt,
  replaceMarkdownInlineCode,
  replaceMarkdownInlineLink,
  transformMarkdownTable,
  replacePrefixedMarkdownContent,
  shiftMarkdownListItemIndent,
  escapeMarkdownTableCell,
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
    expect(isValidSourceRange({ from: 2, to: 2 }, 4)).toBe(true);
  });

  it("creates one safe transaction for cross-block replacement and formatting", () => {
    const text = "# 第一段\n\n第二段\n\n> 第三段\n";
    const first = { range: { from: 0, to: 6 }, source: "# 第一段\n\n", selectionFrom: 3, selectionTo: 5 };
    const last = { range: { from: 11, to: text.length }, source: "> 第三段\n", selectionFrom: 2, selectionTo: 4 };
    expect(createCrossBlockReplacement(text, first, last, "新内容")).toEqual({
      from: 0,
      to: text.length,
      insert: "# 第新内容段\n",
      expectedText: text,
    });
    expect(createCrossBlockFormatChange(text, [
      first,
      { range: { from: 6, to: 11 }, source: "第二段\n\n", selectionFrom: 0, selectionTo: 3 },
      last,
    ], "bold")?.insert).toBe("# 第**一段**\n\n**第二段**\n\n> **第三**段\n");
    expect(normalizeCrossBlockPlainText("# 标题\r\n2. 项目\n普通 *文字*"))
      .toBe("\\# 标题\n\n2\\. 项目\n\n普通 \\*文字\\*");
  });
  it("preserves the original block trailing line breaks", () => {
    expect(preserveTrailingLineBreaks("原文\n\n", "新内容\n")).toBe("新内容\n\n");
    expect(preserveTrailingLineBreaks("原文", "新内容\n")).toBe("新内容");
  });

  it("creates a blank-line-delimited block insertion", () => {
    expect(createMarkdownBlockInsertion("第一段\n", 4, "新段落")).toBe("\n新段落");
    expect(createMarkdownBlockInsertion("第一段\n\n第二段\n", 5, "新段落\n")).toBe("新段落\n\n");
    expect(createMarkdownBlockInsertion("", 0, "新段落")).toBe("新段落");
    expect(createMarkdownBlockInsertion("正文", -1, "错误")).toBe("");
  });

  it("merges adjacent Markdown blocks while preserving the right trailing newline", () => {
    expect(mergeMarkdownBlocks("第一段\n\n", "第二段\n")).toBe("第一段第二段\n");
    expect(mergeMarkdownBlocks("# 标题\n\n", "正文\n\n")).toBe("# 标题正文\n\n");
  });


  it("moves complete Markdown blocks across intervening blocks while preserving source gaps", () => {
    const text = "A\n\nB\n\nC\n";
    expect(applyWysiwygTextChange(text, createMarkdownBlockMove(text, { from: 0, to: 3 }, { from: 6, to: 8 }, "before")!))
      .toBe("B\n\nA\n\nC\n");
    expect(applyWysiwygTextChange(text, createMarkdownBlockMove(text, { from: 6, to: 8 }, { from: 0, to: 3 }, "after")!))
      .toBe("A\n\nC\nB\n\n");
    expect(createMarkdownBlockMove(text, { from: 0, to: 3 }, { from: 0, to: 3 }, "after")).toBeNull();
  });

  it("provides deterministic safe block insertion presets", () => {
    expect(markdownBlockPreset("heading")).toBe("## 新标题");
    expect(markdownBlockPreset("mermaid")).toContain("```mermaid\ngraph TD");
    expect(markdownBlockPreset("table")).toContain("| --- | --- |");
    expect(markdownBlockPreset("formula")).toBe("$$\n\n$$");
    expect(markdownBlockDuplicateInsertion("> 引用\n")).toBe("\n> 引用\n");
    expect(markdownBlockDuplicateInsertion("正文")).toBe("\n\n正文");
  });

  it("creates a bounded block move change for a large document without rewriting outside the range", () => {
    const blocks = Array.from({ length: 5000 }, (_, index) => `块${index}\n\n`);
    const text = blocks.join("");
    const first = { from: 0, to: blocks[0]!.length };
    const lastFrom = text.length - blocks.at(-1)!.length;
    const change = createMarkdownBlockMove(text, first, { from: lastFrom, to: text.length }, "after");
    expect(change).not.toBeNull();
    const moved = applyWysiwygTextChange(text, change!);
    expect(moved?.startsWith("块1\n\n")).toBe(true);
    expect(moved?.endsWith("块4999\n\n块0\n\n")).toBe(true);
  });
  it("preserves list, task and quote prefixes during direct editing", () => {
    expect(replacePrefixedMarkdownContent("- 原项目\n", "新项目", "list-item")).toBe("- 新项目\n");
    expect(replacePrefixedMarkdownContent("3. 原项目\n", "第一项\n\n第二项", "list-item")).toBe("3. 第一项\n4. 第二项\n");
    expect(replacePrefixedMarkdownContent("- [ ] 任务\n", "完成任务", "list-item", true)).toBe("- [x] 完成任务\n");
    expect(replacePrefixedMarkdownContent("> 引用\n", "更新引用", "blockquote")).toBe("> 更新引用\n");
    expect(replacePrefixedMarkdownContent("> 引用\n", "第一行\n第二行", "blockquote")).toBe("> 第一行  \n> 第二行\n");
  });

  it("merges list item contents without duplicating the next marker", () => {
    expect(mergeListItems("- 第一项\n", "- 第二项\n")).toBe("- 第一项第二项\n");
    expect(mergeListItems("1. 第一项\n", "2. 第二项\n")).toBe("1. 第一项第二项\n");
  });

  it("escapes table delimiters and flattens pasted line breaks", () => {
    expect(escapeMarkdownTableCell("A|B\nC")).toBe("A\\|B C");
    expect(escapeMarkdownTableCell("A\\|B")).toBe("A\\|B");
  });

  it("indents and outdents one Markdown list item without changing its marker or content", () => {
    const nested = "  - 子项\n    延续行\n";
    expect(shiftMarkdownListItemIndent("- 子项\n  延续行\n", "indent")).toBe(nested);
    expect(shiftMarkdownListItemIndent(nested, "outdent")).toBe("- 子项\n  延续行\n");
    expect(shiftMarkdownListItemIndent("\t1. 子项\n\t   延续行\n", "outdent")).toBe("1. 子项\n   延续行\n");
    expect(shiftMarkdownListItemIndent("- 顶层", "outdent")).toBeNull();
  });
  it("edits only a parent list item body while preserving its nested subtree", () => {
    const source = "- 父项\n  - 子项\n    - 孙项\n";
    expect(markdownListItemDetails(source)).toMatchObject({ indent: "", marker: "-", ordered: false, task: false, content: "父项" });
    expect(replaceMarkdownListItemOwnContent(source, "更新父项")).toBe("- 更新父项\n  - 子项\n    - 孙项\n");
    expect(replaceMarkdownListItemOwnContent("  - [x] 父任务\n    1. 子项\n", "更新任务", false))
      .toBe("  - [ ] 更新任务\n    1. 子项\n");
  });

  it("creates matching siblings and swaps complete list subtrees without rewriting them", () => {
    expect(createMarkdownListSibling("3. 有序项\n   - 子项\n")).toBe("4. ");
    expect(createMarkdownListSibling("  - [x] 任务\n")).toBe("  - [ ] ");
    expect(exitMarkdownListItemLevel("  - \n    - 子项\n")).toBe("- \n  - 子项\n");
    expect(exitMarkdownListItemLevel("- \n  - 子项\n")).toBe("\n- 子项\n");
    expect(exitMarkdownListItemLevel("- 非空\n")).toBeNull();
    const left = "- 左\n  - 左子\n";
    const right = "- 右\n  1. 右子\n";
    expect(swapMarkdownListSubtrees(left, right)).toBe(right + left);
    expect(shiftMarkdownListItemIndent(left, "indent")).toBe("  - 左\n    - 左子\n");
  });
  it("edits formula content without changing its delimiter or surrounding whitespace", () => {
    expect(markdownFormulaDetails("$$\n  x + y  \n$$\n")).toEqual({ latex: "x + y", displayMode: true, delimiter: "$$" });
    expect(replaceMarkdownFormulaLatex("$$\n  x + y  \n$$\n", "a^2 + b^2")).toBe("$$\n  a^2 + b^2  \n$$\n");
    expect(replaceMarkdownFormulaLatex("\\(x\\)", "y_1")).toBe("\\(y_1\\)");
    expect(replaceMarkdownFormulaLatex("$x$", "bad$delimiter")).toBeNull();
  });

  it("edits fenced code content and language while preserving metadata and growing colliding fences", () => {
    const source = "```ts title=demo\nconst value = 1;\n```\n";
    expect(markdownFenceDetails(source)).toEqual({ content: "const value = 1;", language: "ts", meta: "title=demo", fence: "```" });
    expect(replaceMarkdownFence(source, { content: "const value = 2;" })).toBe("```ts title=demo\nconst value = 2;\n```\n");
    expect(replaceMarkdownFence(source, { language: "javascript" })).toBe("``` javascript title=demo\nconst value = 1;\n```\n");
    expect(replaceMarkdownFence(source, { content: "```" })).toBe("````ts title=demo\n```\n````\n");
    expect(markdownFenceDetails("```ts\nconst value = 1;```")).toBeNull();
  });
  it("performs validated table row, column and alignment transformations", () => {
    const source = "| 名称 | 数值 |\n| :--- | ---: |\n| A\\|B | `x|y` |\n";
    expect(markdownTableDetails(source)).toEqual({
      rows: [["名称", "数值"], ["A\\|B", "`x|y`"]],
      alignments: ["left", "right"],
      columnCount: 2,
    });
    expect(transformMarkdownTable(source, { kind: "insert-row", rowIndex: 1, position: "after" }))
      .toBe("| 名称 | 数值 |\n| :--- | ---: |\n| A\\|B | `x|y` |\n|  |  |\n");
    expect(transformMarkdownTable(source, { kind: "insert-column", columnIndex: 0, position: "after" }))
      .toBe("| 名称 |  | 数值 |\n| :--- | --- | ---: |\n| A\\|B |  | `x|y` |\n");
    expect(transformMarkdownTable(source, { kind: "set-alignment", columnIndex: 0, alignment: "center" }))
      .toBe("| 名称 | 数值 |\n| :---: | ---: |\n| A\\|B | `x|y` |\n");
    expect(transformMarkdownTable(source, { kind: "delete-row", rowIndex: 0 })).toBeNull();
    expect(transformMarkdownTable("| A |\n| --- |\n", { kind: "delete-column", columnIndex: 0 })).toBeNull();
  });

  it("edits inline code while preserving or safely growing its backtick fence", () => {
    expect(markdownInlineCodeDetails("`value`")).toEqual({ content: "value", fence: "`" });
    expect(markdownInlineCodeDetails("`` `value` ``")).toEqual({ content: "`value`", fence: "``" });
    expect(replaceMarkdownInlineCode("`value`", "next")).toBe("`next`");
    expect(replaceMarkdownInlineCode("`value`", "has ` tick")).toBe("``has ` tick``");
    expect(replaceMarkdownInlineCode("`` `value` ``", "`next`")).toBe("`` `next` ``");
    expect(replaceMarkdownInlineCode("`value`", "two\nlines")).toBeNull();
  });

  it("edits inline link fields while preserving untouched destination and title syntax", () => {
    const source = "[旧\\]文字](<https://example.com/a b> '原标题')";
    expect(markdownInlineLinkDetails(source)).toEqual({ label: "旧]文字", destination: "https://example.com/a b", title: "原标题" });
    expect(replaceMarkdownInlineLink(source, { label: "新]文字" })).toBe("[新\\]文字](<https://example.com/a b> '原标题')");
    expect(replaceMarkdownInlineLink(source, { destination: "https://openai.com/docs" })).toBe("[旧\\]文字](<https://openai.com/docs> '原标题')");
    expect(replaceMarkdownInlineLink(source, { title: "新标题" })).toBe("[旧\\]文字](<https://example.com/a b> '新标题')");
    expect(replaceMarkdownInlineLink(source, { title: null })).toBe("[旧\\]文字](<https://example.com/a b>)");
    expect(markdownInlineLinkDetails("[引用][id]")).toBeNull();
  });

  it("reads and updates a Markdown image alt without changing its destination or title", () => {
    const source = "![旧\\]说明](assets/chart.png \"图表\")";
    expect(markdownImageAlt(source)).toBe("旧]说明");
    expect(replaceMarkdownImageAlt(source, "新]说明")).toBe("![新\\]说明](assets/chart.png \"图表\")");
    expect(replaceMarkdownImageAlt(source, "两行\r\n说明")).toBe("![两行 说明](assets/chart.png \"图表\")");
  });

  it("does not reinterpret wiki embeds as standard Markdown images", () => {
    expect(markdownImageAlt("![[chart.png]]")).toBeNull();
    expect(replaceMarkdownImageAlt("![[chart.png]]", "说明")).toBeNull();
  });
  it("escapes Markdown punctuation introduced as plain text", () => {
    expect(escapeMarkdownText("a * b [c] \\ d")).toBe("a \\* b \\[c\\] \\\\ d");
  });
});
