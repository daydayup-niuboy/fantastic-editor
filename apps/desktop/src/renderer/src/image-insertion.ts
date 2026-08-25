import type { ImportedAssetReceipt } from "@fantastic-editor/shared";
import type { ChangeDesc } from "@codemirror/state";

export interface ImageInsertionAnchor { from: number; to: number; }

export function mapImageInsertionAnchor(anchor: ImageInsertionAnchor, changes: ChangeDesc): ImageInsertionAnchor {
  const pointAnchor = anchor.from === anchor.to;
  return {
    from: changes.mapPos(anchor.from, pointAnchor ? 1 : -1),
    to: changes.mapPos(anchor.to, 1),
  };
}

export function imageAltText(displayName: string): string {
  const dot = displayName.lastIndexOf(".");
  const stem = (dot > 0 ? displayName.slice(0, dot) : displayName).replace(/[\r\n]+/g, " ").trim() || "图片";
  return stem.replace(/([\\\[\]])/g, "\\$1");
}

export function createImageMarkdown(receipts: readonly ImportedAssetReceipt[]): string {
  return receipts
    .map((receipt) => `![${imageAltText(receipt.displayName)}](${receipt.relativeRef})`)
    .join("\n\n");
}

