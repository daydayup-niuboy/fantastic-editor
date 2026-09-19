import { StateEffect, StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { renderMermaidPreview } from "./mermaid-preview";
import { remapUnchangedSnapshotRange } from "./live-preview-snapshot";

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
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.className = "language-mermaid";
    code.textContent = this.diagram.source;
    pre.append(code);
    root.append(pre);
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "cm-live-mermaid-edit";
    edit.textContent = "编辑 Mermaid 源码";
    edit.onclick = () => {
      if (view.state.sliceDoc(this.diagram.from, this.diagram.to) !== this.expectedSource) return;
      view.dispatch({ selection: { anchor: this.diagram.from, head: this.diagram.to }, scrollIntoView: true });
      view.focus();
    };
    root.append(edit);
    void renderMermaidPreview(root, { darkMode: this.snapshot.darkMode, fontFamily: this.snapshot.fontFamily });
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
