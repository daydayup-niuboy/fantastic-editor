import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { formatTableCellMarkdown, isEditableTableCell, isPlainTableCell, replaceTableSnapshotCell, tableDecorations, livePreviewTables, revealTableSource, setTableSnapshot } from "./live-preview-tables";

const source = "| A | B |\n| --- | --- |\n| C | D |\n\n正文";
const cell = (text: string) => ({ from: source.indexOf(text), to: source.indexOf(text) + 1, text, html: text, protected: false });
const snapshot = { source, tables: [{ from: 0, to: source.indexOf("\n\n") + 1, rows: [[cell("A"), cell("B")], [cell("C"), cell("D")]] }] };
const state = () => EditorState.create({ doc: source, selection: { anchor: source.length }, extensions: [livePreviewTables] });

describe("Live Preview tables", () => {
  it("keeps incidental selections projected and reveals source only explicitly", () => {
    expect(tableDecorations(state(), snapshot).size).toBe(1);
    expect(tableDecorations(state().update({ selection: { anchor: 2 } }).state, snapshot).size).toBe(1);
    const initial = state().update({ effects: setTableSnapshot.of(snapshot) }).state;
    const revealed = initial.update({ selection: { anchor: 2 }, effects: revealTableSource.of(snapshot.tables[0]!) }).state;
    expect(revealed.field(livePreviewTables).decorations.size).toBe(0);
    expect(revealed.update({ selection: { anchor: source.length } }).state.field(livePreviewTables).decorations.size).toBe(1);
  });
  it("remaps an unchanged table and clears a table whose source changed", () => {
    const initial = state().update({ effects: setTableSnapshot.of(snapshot) }).state;
    expect(initial.field(livePreviewTables).decorations.size).toBe(1);
    const shifted = initial.update({ changes: { from: 0, insert: "x" } }).state;
    expect(shifted.field(livePreviewTables).decorations.size).toBe(1);
    const edited = initial.update({ changes: { from: 2, to: 3, insert: "Z" } }).state;
    expect(edited.field(livePreviewTables).decorations.size).toBe(0);
    expect(tableDecorations(shifted, snapshot).size).toBe(0);
  });
  it("rejects malformed and overlapping projections", () => {
    expect(tableDecorations(state(), { source, tables: [{ ...snapshot.tables[0]!, from: -1 }] }).size).toBe(0);
    expect(tableDecorations(state(), { source, tables: [...snapshot.tables, ...snapshot.tables] }).size).toBe(1);
    expect(tableDecorations(state(), { source, tables: [{ ...snapshot.tables[0]!, rows: [[{ from: NaN, to: 3, text: "A", html: "A", protected: false }]] }] }).size).toBe(0);
  });
  it("replaces one plain cell while keeping snapshot ranges aligned", () => {
    expect(isPlainTableCell("普通文字")).toBe(true);
    expect(isPlainTableCell("**粗体**")).toBe(false);
    const next = replaceTableSnapshotCell(snapshot, 0, 1, 0, "甲|乙");
    expect(next?.source).toContain("| 甲\\|乙 | D |");
    expect(next?.tables[0]?.rows[1]?.[1]?.from).toBe(snapshot.tables[0]!.rows[1]![1]!.from + 3);
  });
  it("edits supported inline Markdown but rejects protected cell content", () => {
    const complexSource = "| **粗体** 与 [链接](https://example.com) | B |\n| --- | --- |\n| C | D |\n";
    const raw = "**粗体** 与 [链接](https://example.com)";
    const from = complexSource.indexOf(raw);
    const complex = { source: complexSource, tables: [{ from: 0, to: complexSource.length, rows: [[
      { from, to: from + raw.length, text: "粗体 与 链接", html: "<strong>粗体</strong> 与 <a>链接</a>", protected: false },
      { from: complexSource.indexOf("B"), to: complexSource.indexOf("B") + 1, text: "B", html: "B", protected: false },
    ]] }] };
    expect(isEditableTableCell(raw)).toBe(true);
    expect(isEditableTableCell("内联 `<svg>`")).toBe(true);
    expect(isEditableTableCell("内联 ``<svg>`内容``")).toBe(true);
    expect(isEditableTableCell("内联 <svg>")).toBe(false);
    expect(isEditableTableCell("内联 `<svg>")).toBe(false);
    expect(replaceTableSnapshotCell(complex, 0, 0, 0, "**更新** 与 `代码`")?.source).toContain("**更新** 与 `代码`");
    expect(replaceTableSnapshotCell({ ...complex, tables: [{ ...complex.tables[0]!, rows: [[{ ...complex.tables[0]!.rows[0]![0]!, protected: true }]] }] }, 0, 0, 0, "x")).toBeNull();
  });
  it("formats only the selected table-cell draft", () => {
    expect(formatTableCellMarkdown("甲乙丙", 1, 2, "bold")).toEqual({ value: "甲**乙**丙", from: 3, to: 4 });
    expect(formatTableCellMarkdown("", 0, 0, "italic")).toEqual({ value: "*斜体文字*", from: 1, to: 5 });
    expect(formatTableCellMarkdown("删除", 0, 2, "strike").value).toBe("~~删除~~");
    expect(formatTableCellMarkdown("代码", 0, 2, "code").value).toBe("`代码`");
    const link = formatTableCellMarkdown("前文字后", 1, 3, "link");
    expect(link.value).toBe("前[文字](https://)后");
    expect(link.value.slice(link.from, link.to)).toBe("https://");
  });
  it("toggles only an exact matching wrapper", () => {
    expect(formatTableCellMarkdown("前**粗体**后", 3, 5, "bold")).toEqual({ value: "前粗体后", from: 1, to: 3 });
    expect(formatTableCellMarkdown("*斜体*", 1, 3, "italic")).toEqual({ value: "斜体", from: 0, to: 2 });
    expect(formatTableCellMarkdown("~~删除~~", 2, 4, "strike").value).toBe("删除");
    expect(formatTableCellMarkdown("`代码`", 1, 3, "code").value).toBe("代码");
    expect(formatTableCellMarkdown("[文字](https://example.com)", 1, 3, "link")).toEqual({ value: "文字", from: 0, to: 2 });
    expect(formatTableCellMarkdown("**粗体**", 0, 6, "bold")).toEqual({ value: "粗体", from: 0, to: 2 });
    expect(formatTableCellMarkdown("[文字](https://example.com)", 0, 25, "link")).toEqual({ value: "文字", from: 0, to: 2 });
    const nestedLink = "[~~*乙*~~](https://www.baidu.com)";
    expect(formatTableCellMarkdown(nestedLink, 0, nestedLink.length, "link")).toEqual({ value: "~~*乙*~~", from: 0, to: 7 });
    expect(formatTableCellMarkdown("**粗体**", 2, 4, "italic").value).toBe("***粗体***");
  });
});
