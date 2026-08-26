import { createHash } from "node:crypto";
import type { DocumentNode } from "@fantastic-editor/document-core";

export interface OutputMermaidAsset {
  mermaidReferenceKey: string;
  contentHash: string;
  mimeType: "image/png";
  width: number;
  height: number;
  bytes: Uint8Array;
}

export function isMermaidNode(node: DocumentNode): boolean {
  return node.type === "codeBlock"
    && typeof node.attributes.language === "string"
    && node.attributes.language.toLowerCase() === "mermaid";
}

export function collectMermaidNodes(nodes: readonly DocumentNode[]): DocumentNode[] {
  const result: DocumentNode[] = [];
  const visit = (items: readonly DocumentNode[]) => {
    for (const node of items) {
      if (isMermaidNode(node)) result.push(node);
      if (node.children) visit(node.children);
    }
  };
  visit(nodes);
  return result;
}

export function mermaidReferenceKey(node: DocumentNode): string {
  const source = typeof node.attributes.value === "string" ? node.attributes.value : "";
  return createHash("sha256")
    .update(`${node.source.from}:${node.source.to}:mermaid:${source}`)
    .digest("hex");
}
