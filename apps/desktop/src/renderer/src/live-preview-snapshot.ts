import type { Transaction } from "@codemirror/state";

export function isTrailingSnapshotEdit(transaction: Transaction, boundary: number): boolean {
  if (!transaction.docChanged) return false;
  let trailing = true;
  transaction.changes.iterChangedRanges((fromA) => { if (fromA < boundary) trailing = false; });
  return trailing;
}
