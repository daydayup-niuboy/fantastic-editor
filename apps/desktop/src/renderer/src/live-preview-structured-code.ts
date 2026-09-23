import { StateEffect, StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { remapUnchangedSnapshotRange } from "./live-preview-snapshot";
import { buildStructuredCodeOutline, createStructuredCodeVisualization } from "./structured-code";
import { writeClipboardText } from "./clipboard-write";

interface StructuredCodeProjection { from: number; to: number; language: string; code: string }
export interface StructuredCodeSnapshot { source: string; blocks: StructuredCodeProjection[] }

export function structuredCodeSnapshotFromHtml(source: string, html: string): StructuredCodeSnapshot {
  const template = document.createElement("template");
  template.innerHTML = html;
  const blocks = [...template.content.querySelectorAll<HTMLElement>('pre[data-source-kind="code-block"]')].flatMap((pre) => {
    const code = pre.querySelector("code");
    const language = code?.className.match(/language-([\w-]+)/i)?.[1] ?? "";
    const value = code?.textContent ?? "";
    if (!buildStructuredCodeOutline(language, value)) return [];
    return [{ from: Number(pre.dataset.sourceFrom), to: Number(pre.dataset.sourceTo), language, code: value }];
  });
  return { source, blocks };
}

export const setStructuredCodeSnapshot = StateEffect.define<StructuredCodeSnapshot | null>();

class StructuredCodeWidget extends WidgetType {
  constructor(readonly block: StructuredCodeProjection, readonly expectedSource: string) { super(); }
  eq(other: StructuredCodeWidget): boolean { return this.expectedSource === other.expectedSource && JSON.stringify(this.block) === JSON.stringify(other.block); }
  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement("div");
    root.className = "cm-live-structured-code";
    root.contentEditable = "false";
    const visualization = createStructuredCodeVisualization(this.block.language, this.block.code);
    if (visualization) root.append(visualization);
    const tools = document.createElement("div");
    tools.className = "cm-live-structured-code-tools";
    const svgIcon = (path: string) => `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
    const copyIcon = svgIcon('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>');
    const doneIcon = svgIcon('<path d="M20 6 9 17l-5-5"/>');
    const button = (label: string, icon: string, action: () => void) => {
      const control = document.createElement("button");
      control.type = "button";
      control.title = label;
      control.setAttribute("aria-label", label);
      control.innerHTML = icon;
      control.onmousedown = (event) => event.preventDefault();
      control.onclick = action;
      tools.append(control);
      return control;
    };
    const copy = button("复制", copyIcon, () => void (async () => {
      const copied = await writeClipboardText(this.block.code.replace(/\r\n?/g, "\n"));
      copy.innerHTML = copied ? doneIcon : copyIcon;
      copy.title = copied ? "已复制" : "复制失败";
      copy.setAttribute("aria-label", copy.title);
      window.setTimeout(() => {
        if (!copy.isConnected) return;
        copy.innerHTML = copyIcon;
        copy.title = "复制";
        copy.setAttribute("aria-label", "复制");
      }, 1200);
    })());
    button("编辑源码", svgIcon('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'), () => {
      if (view.state.sliceDoc(this.block.from, this.block.to) !== this.expectedSource) return;
      view.dispatch({ selection: { anchor: this.block.from, head: this.block.to }, scrollIntoView: true });
      view.focus();
    });
    root.append(tools);
    return root;
  }
  ignoreEvent(): boolean { return true; }
}

export function structuredCodeDecorations(state: EditorState, snapshot: StructuredCodeSnapshot | null): DecorationSet {
  if (!snapshot || snapshot.source !== state.doc.toString()) return Decoration.none;
  let previousEnd = -1;
  return Decoration.set(snapshot.blocks.flatMap((block) => {
    if (!Number.isInteger(block.from) || !Number.isInteger(block.to) || block.from < 0 || block.to <= block.from || block.to > state.doc.length || block.from < previousEnd) return [];
    previousEnd = block.to;
    if (state.selection.ranges.some((range) => range.empty ? range.head >= block.from && range.head < block.to : range.from < block.to && range.to > block.from)) return [];
    return [Decoration.replace({ widget: new StructuredCodeWidget(block, snapshot.source.slice(block.from, block.to)), block: true }).range(block.from, block.to)];
  }), true);
}

export const livePreviewStructuredCode = StateField.define<{ snapshot: StructuredCodeSnapshot | null; decorations: DecorationSet }>({
  create: () => ({ snapshot: null, decorations: Decoration.none }),
  update(value, transaction) {
    let snapshot = transaction.docChanged
      ? value.snapshot ? {
          source: transaction.state.doc.toString(),
          blocks: value.snapshot.blocks.flatMap((block) => {
            const mapped = remapUnchangedSnapshotRange(transaction, block);
            return mapped ? [{ ...block, ...mapped }] : [];
          }),
        } : null
      : value.snapshot;
    for (const effect of transaction.effects) if (effect.is(setStructuredCodeSnapshot)) snapshot = effect.value;
    return { snapshot, decorations: structuredCodeDecorations(transaction.state, snapshot) };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});
