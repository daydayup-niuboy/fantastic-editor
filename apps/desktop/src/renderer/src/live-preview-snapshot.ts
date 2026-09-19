import type { Transaction } from "@codemirror/state";

export interface SnapshotSourceRange { from: number; to: number }

export function remapUnchangedSnapshotRange(transaction: Transaction, range: SnapshotSourceRange): SnapshotSourceRange | null {
  if (!transaction.docChanged) return range;
  const from = transaction.changes.mapPos(range.from, 1);
  const to = transaction.changes.mapPos(range.to, -1);
  if (to <= from) return null;
  return transaction.startState.sliceDoc(range.from, range.to) === transaction.state.sliceDoc(from, to)
    ? { from, to }
    : null;
}
