import { EditorState } from "@codemirror/state";
import { expect, it } from "vitest";
import { formulaDecorations, livePreviewFormulas, setFormulaSnapshot } from "./live-preview-formulas";

it("renders inactive formulas, exposes selected source and rejects stale ranges", () => {
  const source = "$N = 2F + 1$\n正文";
  const snapshot = { source, formulas: [{ from: 0, to: 12, html: "<span>N = 2F + 1</span>", block: false }] };
  const state = EditorState.create({ doc: source, selection: { anchor: source.length }, extensions: [livePreviewFormulas] });
  expect(formulaDecorations(state, snapshot).size).toBe(1);
  expect(formulaDecorations(state.update({ selection: { anchor: 2 } }).state, snapshot).size).toBe(0);
  const projected = state.update({ effects: setFormulaSnapshot.of(snapshot) }).state;
  expect(projected.update({ changes: { from: 0, insert: "x" } }).state.field(livePreviewFormulas).decorations.size).toBe(0);
  expect(formulaDecorations(state, { ...snapshot, formulas: [{ ...snapshot.formulas[0]!, from: -1 }] }).size).toBe(0);
});
