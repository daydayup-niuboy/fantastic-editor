import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { imageDecorations, livePreviewImages, setImageSnapshot } from "./live-preview-images";

const source = "![图片](./assets/image.png)\n正文";
const snapshot = { source, images: [{ from: 0, to: source.indexOf("\n"), src: "fantastic-asset://asset/12345678-1234-4123-8123-123456789012", alt: "图片" }] };
const state = () => EditorState.create({ doc: source, selection: { anchor: source.length }, extensions: [livePreviewImages] });

describe("Live Preview image snapshot", () => {
  it("shows an inactive image and reveals source when selected", () => {
    expect(imageDecorations(state(), snapshot).size).toBe(1);
    expect(imageDecorations(state().update({ selection: { anchor: 1 } }).state, snapshot).size).toBe(0);
  });
  it("rejects stale snapshots and clears widgets immediately on edit", () => {
    const initial = state().update({ effects: setImageSnapshot.of(snapshot) }).state;
    expect(initial.field(livePreviewImages).decorations.size).toBe(1);
    const edited = initial.update({ changes: { from: 0, insert: "前文" } }).state;
    expect(edited.field(livePreviewImages).decorations.size).toBe(0);
    expect(imageDecorations(edited, snapshot).size).toBe(0);
  });
  it("keeps stable widgets when text is appended after every projected image", () => {
    const initial = state().update({ effects: setImageSnapshot.of(snapshot) }).state;
    const appended = initial.update({ changes: { from: initial.doc.length, insert: "\n新行" } }).state;
    expect(appended.field(livePreviewImages).decorations.size).toBe(1);
  });
  it("rejects invalid and overlapping ranges", () => {
    expect(imageDecorations(state(), { source, images: [{ ...snapshot.images[0]!, from: -1 }] }).size).toBe(0);
    expect(imageDecorations(state(), { source, images: [snapshot.images[0]!, snapshot.images[0]!] }).size).toBe(1);
  });
});
