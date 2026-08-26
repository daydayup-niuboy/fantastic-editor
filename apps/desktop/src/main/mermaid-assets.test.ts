import { describe, expect, it } from "vitest";
import { parseDocument } from "@fantastic-editor/document-core";
import { collectMermaidNodes, isMermaidNode, mermaidReferenceKey } from "./mermaid-assets";

describe("Mermaid derived asset identity", () => {
  it("recognizes case-insensitive Mermaid fences and creates deterministic keys", async () => {
    const parsed = await parseDocument({
      documentId: "mermaid-test",
      editorText: "```Mermaid\ngraph TD\n  A --> B\n```\n\n```ts\nconst x = 1\n```\n",
    });
    const nodes = collectMermaidNodes(parsed.children);
    expect(nodes).toHaveLength(1);
    expect(isMermaidNode(nodes[0]!)).toBe(true);
    expect(mermaidReferenceKey(nodes[0]!)).toMatch(/^[a-f\d]{64}$/);
    expect(mermaidReferenceKey(nodes[0]!)).toBe(mermaidReferenceKey(nodes[0]!));
  });
});
