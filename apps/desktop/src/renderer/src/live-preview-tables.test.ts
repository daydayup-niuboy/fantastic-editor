import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { tableDecorations, livePreviewTables, setTableSnapshot } from "./live-preview-tables";

const source = "| A | B |\n| --- | --- |\n| C | D |\n\n正文";
const cell = (text: string) => ({ from: source.indexOf(text), to: source.indexOf(text) + 1, text });
const snapshot = { source, tables: [{ from: 0, to: source.indexOf("\n\n") + 1, rows: [[cell("A"), cell("B")], [cell("C"), cell("D")]] }] };
const state = () => EditorState.create({ doc: source, selection: { anchor: source.length }, extensions: [livePreviewTables] });

describe("Live Preview tables", () => {
  it("projects inactive tables and reveals canonical source for editing", () => {
    expect(tableDecorations(state(), snapshot).size).toBe(1);
    expect(tableDecorations(state().update({ selection: { anchor: 2 } }).state, snapshot).size).toBe(0);
  });
  it("clears stale ranges on every document edit", () => {
    const initial = state().update({ effects: setTableSnapshot.of(snapshot) }).state;
    expect(initial.field(livePreviewTables).decorations.size).toBe(1);
    const edited = initial.update({ changes: { from: 0, insert: "x" } }).state;
    expect(edited.field(livePreviewTables).decorations.size).toBe(0);
    expect(tableDecorations(edited, snapshot).size).toBe(0);
  });
  it("rejects malformed and overlapping projections", () => {
    expect(tableDecorations(state(), { source, tables: [{ ...snapshot.tables[0]!, from: -1 }] }).size).toBe(0);
    expect(tableDecorations(state(), { source, tables: [...snapshot.tables, ...snapshot.tables] }).size).toBe(1);
    expect(tableDecorations(state(), { source, tables: [{ ...snapshot.tables[0]!, rows: [[{ from: NaN, to: 3, text: "A" }]] }] }).size).toBe(0);
  });
});
