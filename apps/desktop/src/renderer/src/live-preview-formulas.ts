import { StateEffect, StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { remapUnchangedSnapshotRange } from "./live-preview-snapshot";

interface Formula { from: number; to: number; html: string; block: boolean }
export interface FormulaSnapshot { source: string; formulas: Formula[] }

// Only accepts the existing parser-generated preview, never clipboard or editable HTML.
export function formulaSnapshotFromHtml(source: string, html: string): FormulaSnapshot {
  const template = document.createElement("template");
  template.innerHTML = html;
  const formulas = [...template.content.querySelectorAll('.preview-formula-inline, .preview-formula-block')]
    .filter(element => !element.closest("table"))
    .map(element => ({ from: Number(element.getAttribute("data-source-from") ?? NaN), to: Number(element.getAttribute("data-source-to") ?? NaN), html: element.innerHTML, block: element.classList.contains("preview-formula-block") }))
    .sort((left, right) => left.from - right.from || left.to - right.to);
  return { source, formulas };
}
export const setFormulaSnapshot = StateEffect.define<FormulaSnapshot | null>();

class FormulaWidget extends WidgetType {
  constructor(readonly formula: Formula, readonly expectedSource: string) { super(); }
  eq(other: FormulaWidget): boolean { return this.expectedSource === other.expectedSource && JSON.stringify(this.formula) === JSON.stringify(other.formula); }
  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement(this.formula.block ? "div" : "span");
    root.className = this.formula.block ? "cm-live-formula cm-live-formula-block" : "cm-live-formula";
    root.innerHTML = this.formula.html;
    root.contentEditable = "false";
    root.tabIndex = 0;
    root.setAttribute("role", "button");
    root.setAttribute("aria-label", "编辑公式源码");
    root.title = "点击编辑公式源码";
    const edit = () => {
      if (view.state.sliceDoc(this.formula.from, this.formula.to) !== this.expectedSource) return;
      view.dispatch({ selection: { anchor: this.formula.from, head: this.formula.to }, scrollIntoView: true });
      view.focus();
    };
    root.onclick = edit;
    root.onkeydown = event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); edit(); } };
    return root;
  }
  ignoreEvent(): boolean { return true; }
}

export function formulaDecorations(state: EditorState, snapshot: FormulaSnapshot | null): DecorationSet {
  if (!snapshot || snapshot.source !== state.doc.toString()) return Decoration.none;
  let previousEnd = -1;
  return Decoration.set([...snapshot.formulas].sort((left, right) => left.from - right.from || left.to - right.to).flatMap(formula => {
    const { from, to } = formula;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || to > state.doc.length || from < previousEnd) return [];
    previousEnd = to;
    if (state.selection.ranges.some(range => range.empty ? range.head >= from && range.head < to : range.from < to && range.to > from)) return [];
    return [Decoration.replace({ widget: new FormulaWidget(formula, snapshot.source.slice(from, to)), block: formula.block }).range(from, to)];
  }), true);
}
export const livePreviewFormulas = StateField.define<{ snapshot: FormulaSnapshot | null; decorations: DecorationSet }>({
  create: () => ({ snapshot: null, decorations: Decoration.none }),
  update(value, transaction) {
    let snapshot = transaction.docChanged
      ? value.snapshot ? {
          source: transaction.state.doc.toString(),
          formulas: value.snapshot.formulas.flatMap((formula) => {
            const mapped = remapUnchangedSnapshotRange(transaction, formula);
            return mapped ? [{ ...formula, ...mapped }] : [];
          }),
        } : null
      : value.snapshot;
    for (const effect of transaction.effects) if (effect.is(setFormulaSnapshot)) snapshot = effect.value;
    return { snapshot, decorations: formulaDecorations(transaction.state, snapshot) };
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations),
});
