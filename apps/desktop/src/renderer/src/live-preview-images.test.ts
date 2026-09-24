import { EditorState } from "@codemirror/state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachPinnedHoverPreview, DEFAULT_LIVE_IMAGE_TRANSFORM, detachPinnedHoverPreview, imageDecorations, liveImageLoadFailureDetail, liveImageLoadFailureRange, liveImageTransformAfterControl, livePreviewImages, setImageSnapshot } from "./live-preview-images";

afterEach(() => vi.unstubAllGlobals());

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

describe("Live Preview image load failures", () => {
  it("reports the current document and exact image source range, but rejects stale widgets", () => {
    const image = {
      ...snapshot.images[0]!,
      referenceKey: "a".repeat(64),
      documentId: "document-1",
    };
    const expectedSource = source.slice(image.from, image.to);

    expect(liveImageLoadFailureDetail(state(), image, expectedSource)).toEqual({
      documentId: "document-1",
      referenceKey: "a".repeat(64),
      from: image.from,
      to: image.to,
      expectedSource,
    });
    expect(liveImageLoadFailureDetail(EditorState.create({ doc: "different source" }), image, expectedSource)).toBeNull();
  });

  it("maps a still-current failure to an exact Markdown source range", () => {
    const from = "前言\r\n".length;
    const imageSource = source.slice(0, source.indexOf("\n"));
    const detail = {
      documentId: "document-1",
      referenceKey: "a".repeat(64),
      from,
      to: from + imageSource.length,
      expectedSource: imageSource,
    };
    const text = `前言\r\n${imageSource}\r\n后续`;
    expect(liveImageLoadFailureRange(text, detail)).toEqual({
      from,
      to: from + imageSource.length,
      startLine: 2,
      startColumn: 1,
      endLine: 2,
      endColumn: imageSource.length + 1,
      precision: "exact",
    });
    expect(liveImageLoadFailureRange(text, { ...detail, expectedSource: "旧图片引用" })).toBeNull();
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

describe("pinned preview listeners", () => {
  it("keeps one outside-click listener and removes it when switching or destroying a widget", () => {
    const documentListeners = new Set<(event: PointerEvent) => void>();
    const documentStub = {
      addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === "pointerdown" && typeof listener === "function") documentListeners.add(listener as (event: PointerEvent) => void);
      }),
      removeEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === "pointerdown" && typeof listener === "function") documentListeners.delete(listener as (event: PointerEvent) => void);
      }),
    };
    vi.stubGlobal("document", documentStub);

    const makeRoot = () => {
      const events = new Map<string, EventListener>();
      const classes = new Set<string>();
      let root: HTMLElement;
      root = {
        classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) },
        querySelector: () => null,
        addEventListener: (type: string, listener: EventListener) => events.set(type, listener),
        removeEventListener: (type: string) => events.delete(type),
        contains: (target: Node | null) => target === root,
      } as unknown as HTMLElement;
      return { root, classes, enter: () => events.get("mouseenter")?.(new Event("mouseenter")) };
    };
    const first = makeRoot();
    const second = makeRoot();

    attachPinnedHoverPreview(first.root);
    first.enter();
    expect(documentListeners.size).toBe(1);
    attachPinnedHoverPreview(second.root);
    second.enter();
    expect(first.classes.has("is-active")).toBe(false);
    expect(documentListeners.size).toBe(1);
    expect(documentStub.removeEventListener).toHaveBeenCalledTimes(1);

    detachPinnedHoverPreview(second.root);
    expect(second.classes.has("is-active")).toBe(false);
    expect(documentListeners.size).toBe(0);
    expect(documentStub.removeEventListener).toHaveBeenCalledTimes(2);
  });
});
