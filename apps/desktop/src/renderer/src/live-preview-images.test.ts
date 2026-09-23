import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { DEFAULT_LIVE_IMAGE_TRANSFORM, imageDecorations, liveImageTransformAfterControl, livePreviewImages, setImageSnapshot } from "./live-preview-images";

const source = "![图片](./assets/image.png)\n正文";
const snapshot = { source, images: [{ from: 0, to: source.indexOf("\n"), src: "fantastic-asset://asset/12345678-1234-4123-8123-123456789012", alt: "图片" }] };
const state = () => EditorState.create({ doc: source, selection: { anchor: source.length }, extensions: [livePreviewImages] });

describe("Live Preview image snapshot", () => {
  it("shows an inactive image and reveals source when selected", () => {
    expect(imageDecorations(state(), snapshot).size).toBe(1);
    expect(imageDecorations(state().update({ selection: { anchor: 1 } }).state, snapshot).size).toBe(0);
    expect(imageDecorations(state().update({ selection: { anchor: snapshot.images[0]!.to } }).state, snapshot).size).toBe(1);
  });
  it("remaps an unchanged image after an edit before it and clears only a changed image", () => {
    const initial = state().update({ effects: setImageSnapshot.of(snapshot) }).state;
    expect(initial.field(livePreviewImages).decorations.size).toBe(1);
    const shifted = initial.update({ changes: { from: 0, insert: "前文" } }).state;
    expect(shifted.field(livePreviewImages).decorations.size).toBe(1);
    const edited = initial.update({ changes: { from: 3, to: 4, insert: "新" } }).state;
    expect(edited.field(livePreviewImages).decorations.size).toBe(0);
    expect(imageDecorations(shifted, snapshot).size).toBe(0);
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

describe("Live Preview image transform controls", () => {
  it("moves the image in four directions and restores the default transform", () => {
    expect(liveImageTransformAfterControl(DEFAULT_LIVE_IMAGE_TRANSFORM, "up")).toEqual({ offsetX: 0, offsetY: -24, zoom: 1 });
    expect(liveImageTransformAfterControl(DEFAULT_LIVE_IMAGE_TRANSFORM, "down")).toEqual({ offsetX: 0, offsetY: 24, zoom: 1 });
    expect(liveImageTransformAfterControl(DEFAULT_LIVE_IMAGE_TRANSFORM, "left")).toEqual({ offsetX: -24, offsetY: 0, zoom: 1 });
    expect(liveImageTransformAfterControl(DEFAULT_LIVE_IMAGE_TRANSFORM, "right")).toEqual({ offsetX: 24, offsetY: 0, zoom: 1 });
    expect(liveImageTransformAfterControl({ offsetX: 24, offsetY: -24, zoom: 1.2 }, "reset")).toEqual(DEFAULT_LIVE_IMAGE_TRANSFORM);
  });

  it("zooms in and out with bounded, stable values", () => {
    expect(liveImageTransformAfterControl(DEFAULT_LIVE_IMAGE_TRANSFORM, "zoom-in").zoom).toBe(1.2);
    expect(liveImageTransformAfterControl(DEFAULT_LIVE_IMAGE_TRANSFORM, "zoom-out").zoom).toBe(0.833);
    expect(liveImageTransformAfterControl({ offsetX: 0, offsetY: 0, zoom: 4 }, "zoom-in").zoom).toBe(4);
    expect(liveImageTransformAfterControl({ offsetX: 0, offsetY: 0, zoom: 0.25 }, "zoom-out").zoom).toBe(0.25);
  });
});
