import { syntaxTree } from "@codemirror/language";
import { EditorSelection, type EditorState, type TransactionSpec } from "@codemirror/state";
import { sha256 } from "@fantastic-editor/document-core";

export interface EditorTextAnchor {
  documentId: string;
  sourceHash: string;
  from: number;
  to: number;
  expectedText: string;
}

interface EditorDispatchTarget {
  readonly state: EditorState;
  dispatch(spec: TransactionSpec): void;
  focus?(): void;
}

function currentBlockRange(state: EditorState): { from: number; to: number } | null {
  if (state.doc.length === 0) return null;
  const position = Math.min(state.selection.main.head, state.doc.length);
  let node = syntaxTree(state).resolveInner(position, -1);
  while (node.parent && node.parent.name !== "Document") node = node.parent;
  if (node.name === "Document" || node.to <= node.from) {
    const line = state.doc.lineAt(position);
    return { from: line.from, to: line.to };
  }
  return { from: node.from, to: node.to };
}

export async function captureEditorTextAnchor(documentId: string, state: EditorState, selectedRange?: { from: number; to: number }): Promise<EditorTextAnchor | null> {
  if (!documentId) return null;
  const selection = state.selection.main;
  const range = selectedRange ?? (selection.empty ? currentBlockRange(state) : { from: selection.from, to: selection.to });
  if (!range || !Number.isInteger(range.from) || !Number.isInteger(range.to) || range.from < 0 || range.to <= range.from || range.to > state.doc.length) return null;
  const text = state.doc.toString();
  return {
    documentId,
    sourceHash: await sha256(text),
    from: range.from,
    to: range.to,
    expectedText: text.slice(range.from, range.to),
  };
}

export async function applyEditorTextReplacement(
  target: EditorDispatchTarget,
  documentId: string,
  anchor: EditorTextAnchor,
  insert: string,
): Promise<boolean> {
  const state = target.state;
  const text = state.doc.toString();
  if (anchor.documentId !== documentId
    || anchor.from < 0
    || anchor.to < anchor.from
    || anchor.to > text.length
    || text.slice(anchor.from, anchor.to) !== anchor.expectedText
    || await sha256(text) !== anchor.sourceHash
    || target.state !== state) return false;
  target.dispatch({
    changes: { from: anchor.from, to: anchor.to, insert },
    selection: EditorSelection.range(anchor.from, anchor.from + insert.length),
    scrollIntoView: true,
    userEvent: "input.complete",
  });
  target.focus?.();
  return true;
}
