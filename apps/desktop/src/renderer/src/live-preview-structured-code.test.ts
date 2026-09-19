import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { livePreviewStructuredCode, setStructuredCodeSnapshot, structuredCodeDecorations } from "./live-preview-structured-code";

const source = '```json\n{"name":"fantastic-editor"}\n```\n';
const snapshot = { source, blocks: [{ from: 0, to: source.length, language: "json", code: '{"name":"fantastic-editor"}\n' }] };

describe("live preview structured code", () => {
  it("shows inactive structured data and reveals source when selected", () => {
    const state = EditorState.create({ doc: source, selection: { anchor: source.length }, extensions: [livePreviewStructuredCode] });
    expect(structuredCodeDecorations(state, snapshot).size).toBe(1);
    expect(structuredCodeDecorations(state.update({ selection: { anchor: 5 } }).state, snapshot).size).toBe(0);
    expect(state.update({ effects: setStructuredCodeSnapshot.of(snapshot) }).state.field(livePreviewStructuredCode).decorations.size).toBe(1);
  });
});
