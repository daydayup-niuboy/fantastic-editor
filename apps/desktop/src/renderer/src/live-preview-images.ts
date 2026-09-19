import { StateEffect, StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { remapUnchangedSnapshotRange } from "./live-preview-snapshot";

interface ImageProjection { from: number; to: number; src: string; alt: string; kind?: "image" | "svg-content" }
export interface ImageSnapshot { source: string; images: ImageProjection[] }
const ASSET_URL = /^fantastic-asset:\/\/asset\/[a-f\d]{8}-[a-f\d]{4}-[1-5][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;

// Read only the existing trusted preview projection, never the editable DOM.
export function imageSnapshotFromHtml(source: string, html: string): ImageSnapshot {
  const template = document.createElement("template");
  template.innerHTML = html;
  const images = [...template.content.querySelectorAll('[data-source-kind="image"], [data-source-kind="svg-content"]')].map((element) => ({
    from: Number(element.getAttribute("data-source-from")),
    to: Number(element.getAttribute("data-source-to")),
    src: element.getAttribute("src") ?? "",
    alt: element.getAttribute("alt") ?? element.getAttribute("data-alt") ?? "图片",
    kind: element.getAttribute("data-source-kind") === "svg-content" ? "svg-content" as const : "image" as const,
  }));
  return { source, images };
}

export const setImageSnapshot = StateEffect.define<ImageSnapshot | null>();

class ImageWidget extends WidgetType {
  constructor(readonly image: ImageProjection, readonly expectedSource: string) { super(); }
  eq(other: ImageWidget): boolean {
    return this.expectedSource === other.expectedSource && JSON.stringify(this.image) === JSON.stringify(other.image);
  }
  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement("span");
    root.className = "cm-live-image";
    root.contentEditable = "false";
    if (ASSET_URL.test(this.image.src)) {
      const img = document.createElement("img");
      img.src = this.image.src;
      img.alt = this.image.alt;
      img.onload = () => view.requestMeasure();
      img.onerror = () => {
        img.hidden = true;
        status.textContent = "图片加载失败，请查看文档诊断或重新解析。";
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
    for (const remove of [false, true]) {
      const button = document.createElement("button");
      button.type = "button";
      const label = this.image.kind === "svg-content" ? "SVG 内容" : "图片引用";
      button.textContent = remove ? `删除${label}` : `编辑${label}`;
      button.onmousedown = (event) => event.preventDefault();
      button.onclick = () => {
        if (view.state.sliceDoc(this.image.from, this.image.to) !== this.expectedSource) return;
        if (remove) view.dispatch({ changes: { from: this.image.from, to: this.image.to, insert: "" }, selection: { anchor: this.image.from }, userEvent: "delete.selection" });
        else view.dispatch({ selection: { anchor: this.image.from, head: this.image.to }, scrollIntoView: true });
        view.focus();
      };
      root.append(button);
    }
    return root;
  }
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
