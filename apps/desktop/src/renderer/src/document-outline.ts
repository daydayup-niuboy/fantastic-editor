import type { DocumentNode, ParsedDocument } from "@fantastic-editor/document-core";

export interface OutlineEntry {
  nodeId: string;
  level: number;
  label: string;
  from: number;
  to: number;
}

function inlineLabel(node: DocumentNode): string {
  const attributes = node.attributes ?? {};
  if (typeof attributes.value === "string") return attributes.value;
  if (typeof attributes.alt === "string") return attributes.alt;
  return (node.children ?? []).map(inlineLabel).join("");
}

export function extractDocumentOutline(document: ParsedDocument | null | undefined): OutlineEntry[] {
  if (!document) return [];
  const entries: OutlineEntry[] = [];
  const visit = (node: DocumentNode) => {
    if (node.type === "heading") {
      const levelValue = Number(node.attributes.level ?? 1);
      const label = inlineLabel(node).replace(/\s+/g, " ").trim() || "未命名标题";
      entries.push({
        nodeId: node.id,
        level: Math.min(6, Math.max(1, Number.isFinite(levelValue) ? levelValue : 1)),
        label,
        from: node.source.from,
        to: node.source.to,
      });
    }
    node.children?.forEach(visit);
  };
  document.children.forEach(visit);
  return entries;
}
