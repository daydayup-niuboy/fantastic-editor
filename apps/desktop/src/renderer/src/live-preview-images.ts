import { StateEffect, StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import type { SourceRange } from "@fantastic-editor/document-core";
import { remapUnchangedSnapshotRange } from "./live-preview-snapshot";

interface ImageProjection { from: number; to: number; src: string; alt: string; referenceKey?: string; documentId?: string; kind?: "image" | "svg-content" }
export interface ImageSnapshot { source: string; images: ImageProjection[] }
export interface LiveImageLoadFailure {
  documentId: string;
  referenceKey: string;
  from: number;
  to: number;
  expectedSource: string;
}
const ASSET_URL = /^fantastic-asset:\/\/asset\/[a-f\d]{8}-[a-f\d]{4}-[1-5][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
export type LiveImageControl = "up" | "down" | "left" | "right" | "reset" | "zoom-in" | "zoom-out";
export interface LiveImageTransform { offsetX: number; offsetY: number; zoom: number }

export const DEFAULT_LIVE_IMAGE_TRANSFORM: LiveImageTransform = Object.freeze({ offsetX: 0, offsetY: 0, zoom: 1 });
const LIVE_IMAGE_MOVE_STEP = 24;
const LIVE_IMAGE_OFFSET_LIMIT = 640;
const LIVE_IMAGE_ZOOM_MIN = 0.25;
const LIVE_IMAGE_ZOOM_MAX = 4;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function liveImageTransformAfterControl(current: LiveImageTransform, control: LiveImageControl): LiveImageTransform {
  if (control === "reset") return { ...DEFAULT_LIVE_IMAGE_TRANSFORM };
  if (control === "zoom-in") return { ...current, zoom: clamp(Number((current.zoom * 1.2).toFixed(3)), LIVE_IMAGE_ZOOM_MIN, LIVE_IMAGE_ZOOM_MAX) };
  if (control === "zoom-out") return { ...current, zoom: clamp(Number((current.zoom / 1.2).toFixed(3)), LIVE_IMAGE_ZOOM_MIN, LIVE_IMAGE_ZOOM_MAX) };
  const offsetX = control === "left"
    ? clamp(current.offsetX - LIVE_IMAGE_MOVE_STEP, -LIVE_IMAGE_OFFSET_LIMIT, LIVE_IMAGE_OFFSET_LIMIT)
    : control === "right"
      ? clamp(current.offsetX + LIVE_IMAGE_MOVE_STEP, -LIVE_IMAGE_OFFSET_LIMIT, LIVE_IMAGE_OFFSET_LIMIT)
      : current.offsetX;
  const offsetY = control === "up"
    ? clamp(current.offsetY - LIVE_IMAGE_MOVE_STEP, -LIVE_IMAGE_OFFSET_LIMIT, LIVE_IMAGE_OFFSET_LIMIT)
    : control === "down"
      ? clamp(current.offsetY + LIVE_IMAGE_MOVE_STEP, -LIVE_IMAGE_OFFSET_LIMIT, LIVE_IMAGE_OFFSET_LIMIT)
      : current.offsetY;
  return { offsetX, offsetY, zoom: current.zoom };
}


// Read only the existing trusted preview projection, never the editable DOM.
export function imageSnapshotFromHtml(source: string, html: string, documentId?: string): ImageSnapshot {
  const template = document.createElement("template");
  template.innerHTML = html;
  const images = [...template.content.querySelectorAll('[data-source-kind="image"], [data-source-kind="svg-content"]')].map((element) => ({
    from: Number(element.getAttribute("data-source-from")),
    to: Number(element.getAttribute("data-source-to")),
    src: element.getAttribute("src") ?? "",
    alt: element.getAttribute("alt") ?? element.getAttribute("data-alt") ?? "图片",
    ...(element.getAttribute("data-reference-key") ? { referenceKey: element.getAttribute("data-reference-key")! } : {}),
    ...(documentId ? { documentId } : {}),
    kind: element.getAttribute("data-source-kind") === "svg-content" ? "svg-content" as const : "image" as const,
  }));
  return { source, images };
}

export function liveImageLoadFailureDetail(state: EditorState, image: ImageProjection, expectedSource: string): LiveImageLoadFailure | null {
  if (!image.documentId || !image.referenceKey || !/^[a-f\d]{64}$/i.test(image.referenceKey)) return null;
  if (!Number.isInteger(image.from) || !Number.isInteger(image.to) || image.from < 0 || image.to <= image.from || state.sliceDoc(image.from, image.to) !== expectedSource) return null;
  return { documentId: image.documentId, referenceKey: image.referenceKey, from: image.from, to: image.to, expectedSource };
}

export function liveImageLoadFailureRange(text: string, detail: LiveImageLoadFailure): SourceRange | null {
  if (!Number.isInteger(detail.from) || !Number.isInteger(detail.to) || detail.from < 0 || detail.to <= detail.from || text.slice(detail.from, detail.to) !== detail.expectedSource) return null;
  const positionAt = (offset: number) => {
    const prefix = text.slice(0, offset);
    const lastBreak = Math.max(prefix.lastIndexOf("\n"), prefix.lastIndexOf("\r"));
    return { line: prefix.split(/\r\n|\r|\n/).length, column: offset - lastBreak };
  };
  const start = positionAt(detail.from);
  const end = positionAt(detail.to);
  return { from: detail.from, to: detail.to, startLine: start.line, startColumn: start.column, endLine: end.line, endColumn: end.column, precision: "exact" };
}

export const setImageSnapshot = StateEffect.define<ImageSnapshot | null>();

function addPadButton(parent: HTMLElement, className: string, title: string, path: string, onClick: () => void): void {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `cm-live-image-control ${className}`;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.innerHTML = `<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
  button.onmousedown = (event) => event.preventDefault();
  button.onclick = onClick;
  parent.append(button);
}

let activePinnedPreview: HTMLElement | null = null;
let activePinnedPointerListener: ((event: PointerEvent) => void) | null = null;
const pinnedPreviewHoverHandlers = new WeakMap<HTMLElement, () => void>();
function clearPinned(root: HTMLElement): void {
  root.classList.remove("is-active");
  const controls = root.querySelector<HTMLElement>(".cm-live-image-controls");
  if (controls) { controls.style.left = ""; controls.style.top = ""; controls.style.right = ""; }
}
function deactivatePinnedPreview(root: HTMLElement): void {
  if (activePinnedPreview !== root) return;
  clearPinned(root);
  if (activePinnedPointerListener) document.removeEventListener("pointerdown", activePinnedPointerListener, true);
  activePinnedPointerListener = null;
  activePinnedPreview = null;
}
// 指向图片即“钉住”弹出并显示控件；只有在图片以外区域按下鼠标才恢复。
// 退出钉住（或切换到另一张图）时，用户拖动到的功能块位置一并复位为默认。
export function attachPinnedHoverPreview(root: HTMLElement, onActivate?: () => void): void {
  const onMouseEnter = () => {
    if (activePinnedPreview && activePinnedPreview !== root) deactivatePinnedPreview(activePinnedPreview);
    activePinnedPreview = root;
    root.classList.add("is-active");
    if (!activePinnedPointerListener) {
      activePinnedPointerListener = (event) => {
        if (!root.contains(event.target as Node | null)) deactivatePinnedPreview(root);
      };
      document.addEventListener("pointerdown", activePinnedPointerListener, true);
    }
    onActivate?.();
  };
  root.addEventListener("mouseenter", onMouseEnter);
  pinnedPreviewHoverHandlers.set(root, onMouseEnter);
}

export function detachPinnedHoverPreview(root: HTMLElement): void {
  const onMouseEnter = pinnedPreviewHoverHandlers.get(root);
  if (onMouseEnter) root.removeEventListener("mouseenter", onMouseEnter);
  pinnedPreviewHoverHandlers.delete(root);
  deactivatePinnedPreview(root);
}

export function createLiveTransformControls(onControl: (control: LiveImageControl) => void, extras?: { onEdit?: () => void; onSave?: () => void; onDelete?: () => void }): HTMLSpanElement {
  const controls = document.createElement("span");
  controls.className = "cm-live-image-controls";
  if (extras?.onEdit) addPadButton(controls, "cm-live-image-control-edit", "编辑源码", '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>', extras.onEdit);
  if (extras?.onSave) addPadButton(controls, "cm-live-image-control-save", "下载/保存为图片", '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>', extras.onSave);
  addPadButton(controls, "cm-live-image-control-up", "向上移动", '<path d="m6 14 6-6 6 6"/>', () => onControl("up"));
  addPadButton(controls, "cm-live-image-control-down", "向下移动", '<path d="m6 10 6 6 6-6"/>', () => onControl("down"));
  addPadButton(controls, "cm-live-image-control-left", "向左移动", '<path d="m14 6-6 6 6 6"/>', () => onControl("left"));
  addPadButton(controls, "cm-live-image-control-right", "向右移动", '<path d="m10 6 6 6-6 6"/>', () => onControl("right"));
  addPadButton(controls, "cm-live-image-control-reset", "恢复默认位置和大小", '<path d="M20 12a8 8 0 1 1-2.34-5.66L20 8"/><path d="M20 3v5h-5"/>', () => onControl("reset"));
  addPadButton(controls, "cm-live-image-control-zoom-in", "放大", '<circle cx="11" cy="11" r="6.5"/><path d="M11 8v6M8 11h6M16 16l4.5 4.5"/>', () => onControl("zoom-in"));
  addPadButton(controls, "cm-live-image-control-zoom-out", "缩小", '<circle cx="11" cy="11" r="6.5"/><path d="M8 11h6M16 16l4.5 4.5"/>', () => onControl("zoom-out"));
  if (extras?.onDelete) addPadButton(controls, "cm-live-image-control-delete", "删除图片", '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/>', extras.onDelete);
  controls.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement | null)?.closest("button")) return;
    const root = controls.parentElement;
    if (!root) return;
    const rootRect = root.getBoundingClientRect();
    const scale = rootRect.width > 0 && root.offsetWidth ? rootRect.width / root.offsetWidth : 1;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const startLeft = controls.offsetLeft;
    const startTop = controls.offsetTop;
    controls.style.cursor = "grabbing";
    const onMove = (moveEvent: PointerEvent) => {
      controls.style.left = `${Math.round(startLeft + (moveEvent.clientX - startX) / scale)}px`;
      controls.style.top = `${Math.round(startTop + (moveEvent.clientY - startY) / scale)}px`;
      controls.style.right = "auto";
    };
    const onUp = () => {
      controls.style.cursor = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
  return controls;
}

class ImageWidget extends WidgetType {
  constructor(readonly image: ImageProjection, readonly expectedSource: string) { super(); }
  eq(other: ImageWidget): boolean {
    return this.expectedSource === other.expectedSource && JSON.stringify(this.image) === JSON.stringify(other.image);
  }
  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement("span");
    root.className = "cm-live-image";
    root.contentEditable = "false";
    let transform: LiveImageTransform = { ...DEFAULT_LIVE_IMAGE_TRANSFORM };
    const applyTransform = (next: LiveImageTransform) => {
      transform = next;
      root.style.setProperty("--live-image-offset-x", `${transform.offsetX}px`);
      root.style.setProperty("--live-image-offset-y", `${transform.offsetY}px`);
      root.style.setProperty("--live-image-zoom", String(transform.zoom));
      view.requestMeasure();
    };
    applyTransform(transform);
    if (ASSET_URL.test(this.image.src)) {
      const img = document.createElement("img");
      img.src = this.image.src;
      img.alt = this.image.alt;
      img.onload = () => { view.requestMeasure(); };
      img.onerror = () => {
        img.hidden = true;
        status.textContent = "图片加载失败，请查看文档诊断或重新解析。";
        const detail = liveImageLoadFailureDetail(view.state, this.image, this.expectedSource);
        if (detail) window.dispatchEvent(new CustomEvent<LiveImageLoadFailure>("fantastic-editor:live-image-load-error", { detail }));
        view.requestMeasure();
      };
      root.append(img);
    }
    const status = document.createElement("span");
    status.className = "cm-live-image-caption";
    status.textContent = ASSET_URL.test(this.image.src)
      ? this.image.alt
      : this.image.kind === "svg-content" ? "SVG 正在安全转换，请稍候或查看诊断。" : "图片尚未加载，请查看文档诊断（路径授权、文件不存在或正在解析）。";
    root.append(status);
    const actions = document.createElement("span");
    actions.className = "cm-live-image-actions";
    const isAsset = ASSET_URL.test(this.image.src);
    const editSource = () => {
      if (view.state.sliceDoc(this.image.from, this.image.to) !== this.expectedSource) return;
      view.dispatch({ selection: { anchor: this.image.from, head: this.image.to }, scrollIntoView: true });
      view.focus();
    };
    const deleteImage = () => {
      if (view.state.sliceDoc(this.image.from, this.image.to) !== this.expectedSource) return;
      view.dispatch({ changes: { from: this.image.from, to: this.image.to, insert: "" }, selection: { anchor: this.image.from }, userEvent: "delete.selection" });
      view.focus();
    };
    if (isAsset) {
      const controls = createLiveTransformControls((control) => applyTransform(liveImageTransformAfterControl(transform, control)), {
        onEdit: editSource,
        onSave: () => { void window.fantasticEditor.savePreviewAsset({ url: this.image.src, suggestedName: this.image.alt }); },
        onDelete: deleteImage,
      });
      root.append(controls);
    } else {
      const edit = document.createElement("button");
      edit.type = "button";
      edit.title = "编辑图片";
      edit.setAttribute("aria-label", "编辑图片");
      edit.innerHTML = '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
      edit.onmousedown = (event) => event.preventDefault();
      edit.onclick = editSource;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.title = "删除图片";
      remove.setAttribute("aria-label", "删除图片");
      remove.innerHTML = '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/></svg>';
      remove.onmousedown = (event) => event.preventDefault();
      remove.onclick = deleteImage;
      actions.append(edit, remove);
    }
    root.append(actions);
    attachPinnedHoverPreview(root);
    return root;
  }
  destroy(dom: HTMLElement): void { detachPinnedHoverPreview(dom); }
  ignoreEvent(): boolean { return true; }
}

export function imageDecorations(state: EditorState, snapshot: ImageSnapshot | null): DecorationSet {
  if (!snapshot || state.doc.toString() !== snapshot.source) return Decoration.none;
  let previousEnd = -1;
  const ranges = snapshot.images.flatMap((image) => {
    if (!Number.isInteger(image.from) || !Number.isInteger(image.to) || image.from < 0 || image.to <= image.from || image.to > state.doc.length || image.from < previousEnd) return [];
    previousEnd = image.to;
    if (state.selection.ranges.some((range) => range.empty ? range.head >= image.from && range.head < image.to : range.from < image.to && range.to > image.from)) return [];
    return [Decoration.replace({ widget: new ImageWidget(image, snapshot.source.slice(image.from, image.to)) }).range(image.from, image.to)];
  });
  return Decoration.set(ranges, true);
}

export const livePreviewImages = StateField.define<{ snapshot: ImageSnapshot | null; decorations: DecorationSet }>({
  create: () => ({ snapshot: null, decorations: Decoration.none }),
  update(value, transaction) {
    let snapshot = transaction.docChanged
      ? value.snapshot ? {
          source: transaction.state.doc.toString(),
          images: value.snapshot.images.flatMap((image) => {
            const mapped = remapUnchangedSnapshotRange(transaction, image);
            return mapped ? [{ ...image, ...mapped }] : [];
          }),
        } : null
      : value.snapshot;
    for (const effect of transaction.effects) if (effect.is(setImageSnapshot)) snapshot = effect.value;
    return { snapshot, decorations: imageDecorations(transaction.state, snapshot) };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});
