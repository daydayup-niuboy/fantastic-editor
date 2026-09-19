import { EditorState } from "@codemirror/state";
import { expect, it } from "vitest";
import { livePreviewMermaid, mermaidDecorations } from "./live-preview-mermaid";

it("projects inactive Mermaid fences and reveals active source", () => {
  const source = "```mermaid\ngraph TD\n  A --> B\n```\n\n正文";
  const snapshot = { source, diagrams: [{ from: 0, to: source.indexOf("\n\n"), source: "graph TD\n  A --> B\n" }], darkMode: false, fontFamily: "sans-serif" };
  const state = EditorState.create({ doc: source, selection: { anchor: source.length }, extensions: [livePreviewMermaid] });
  expect(mermaidDecorations(state, snapshot).size).toBe(1);
  expect(mermaidDecorations(state.update({ selection: { anchor: 5 } }).state, snapshot).size).toBe(0);
});
