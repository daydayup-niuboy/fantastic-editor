import { StateEffect, StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { renderMermaidPreview } from "./mermaid-preview";
import { remapUnchangedSnapshotRange } from "./live-preview-snapshot";
import { attachPinnedHoverPreview, createLiveTransformControls, DEFAULT_LIVE_IMAGE_TRANSFORM, liveImageTransformAfterControl, type LiveImageTransform } from "./live-preview-images";

interface MermaidDiagram { from: number; to: number; source: string }
export interface MermaidSnapshot {
  source: string;
  diagrams: MermaidDiagram[];
  darkMode: boolean;
  fontFamily: string;
}

export function mermaidSnapshotFromHtml(source: string, html: string, darkMode: boolean, fontFamily: string): MermaidSnapshot {
  const template = document.createElement("template");
  template.innerHTML = html;
  const diagrams = [...template.content.querySelectorAll<HTMLElement>('pre[data-source-kind="code-block"] > code.language-mermaid')]
    .map((code) => ({
      from: Number(code.parentElement?.getAttribute("data-source-from") ?? NaN),
      to: Number(code.parentElement?.getAttribute("data-source-to") ?? NaN),
      source: code.textContent ?? "",
    }))
    .sort((left, right) => left.from - right.from || left.to - right.to);
  return { source, diagrams, darkMode, fontFamily };
}

export const setMermaidSnapshot = StateEffect.define<MermaidSnapshot | null>();

function downloadSvgAsImage(svg: SVGElement, name: string): void {
  const clone = svg.cloneNode(true) as SVGElement;
  if (!clone.getAttribute("xmlns")) clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const blob = new Blob([`<?xml version="1.0" encoding="UTF-8"?>${new XMLSerializer().serializeToString(clone)}`], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

class MermaidWidget extends WidgetType {
  constructor(readonly diagram: MermaidDiagram, readonly expectedSource: string, readonly snapshot: MermaidSnapshot) { super(); }
  eq(other: MermaidWidget): boolean {
    return JSON.stringify(this.diagram) === JSON.stringify(other.diagram)
      && this.expectedSource === other.expectedSource
      && this.snapshot.darkMode === other.snapshot.darkMode
      && this.snapshot.fontFamily === other.snapshot.fontFamily;
  }
  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement("div");
    root.className = "cm-live-mermaid";
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
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.className = "language-mermaid";
    code.textContent = this.diagram.source;
    pre.append(code);
    root.append(pre);
    const editSource = () => {
      if (view.state.sliceDoc(this.diagram.from, this.diagram.to) !== this.expectedSource) return;
      view.dispatch({ selection: { anchor: this.diagram.from, head: this.diagram.to }, scrollIntoView: true });
      view.focus();
    };
    const saveImage = () => {
      const svg = root.querySelector("svg");
      if (!(svg instanceof SVGElement)) return;
      downloadSvgAsImage(svg, "mermaid.svg");
    };
    const attachControls = () => {
      if (root.querySelector(".cm-live-image-controls")) return;
      root.append(createLiveTransformControls((control) => applyTransform(liveImageTransformAfterControl(transform, control)), { onEdit: editSource, onSave: saveImage }));
    };
    attachPinnedHoverPreview(root);
    void renderMermaidPreview(root, { darkMode: this.snapshot.darkMode, fontFamily: this.snapshot.fontFamily })
      .then((result) => {
        if (result.rendered === 0) return;
        attachControls();
        view.requestMeasure();
      });
    return root;
  }
  ignoreEvent(): boolean { return true; }
}

export function mermaidDecorations(state: EditorState, snapshot: MermaidSnapshot | null): DecorationSet {
  if (!snapshot || snapshot.source !== state.doc.toString()) return Decoration.none;
  let previousEnd = -1;
  const ranges = snapshot.diagrams.flatMap((diagram) => {
    const { from, to } = diagram;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || to > state.doc.length || from < previousEnd) return [];
    previousEnd = to;
    if (state.selection.ranges.some((range) => range.empty ? range.head >= from && range.head < to : range.from < to && range.to > from)) return [];
    return [Decoration.replace({ widget: new MermaidWidget(diagram, snapshot.source.slice(from, to), snapshot), block: true }).range(from, to)];
  });
  return Decoration.set(ranges, true);
}

export const livePreviewMermaid = StateField.define<{ snapshot: MermaidSnapshot | null; decorations: DecorationSet }>({
  create: () => ({ snapshot: null, decorations: Decoration.none }),
  update(value, transaction) {
    let snapshot = transaction.docChanged
      ? value.snapshot ? {
          ...value.snapshot,
          source: transaction.state.doc.toString(),
          diagrams: value.snapshot.diagrams.flatMap((diagram) => {
            const mapped = remapUnchangedSnapshotRange(transaction, diagram);
            return mapped ? [{ ...diagram, ...mapped }] : [];
          }),
        } : null
      : value.snapshot;
    for (const effect of transaction.effects) if (effect.is(setMermaidSnapshot)) snapshot = effect.value;
    return { snapshot, decorations: mermaidDecorations(transaction.state, snapshot) };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});
