import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseDocument, type DocumentNode } from "@fantastic-editor/document-core";

function collect(nodes: readonly DocumentNode[]): DocumentNode[] {
  return nodes.flatMap((node) => [node, ...collect(node.children ?? [])]);
}

describe("WeChat acceptance fixture", () => {
  it("covers the fixed real-environment validation matrix without unsafe resources", async () => {
    const editorText = await readFile(new URL("../../../../fixtures/wechat-acceptance/standard.md", import.meta.url), "utf8");
    const parsed = await parseDocument({ documentId: "wechat-acceptance-fixture", editorText });
    const nodes = collect(parsed.children);
    expect(parsed.resourceReferences).toHaveLength(1);
    expect(parsed.resourceReferences[0]?.originalRef).toBe("assets/wechat-acceptance-chart.svg");
    expect(nodes.some((node) => node.type === "formulaInline")).toBe(true);
    expect(nodes.some((node) => node.type === "formulaBlock")).toBe(true);
    expect(nodes.some((node) => node.type === "table")).toBe(true);
    expect(nodes.some((node) => node.type === "taskItem")).toBe(true);
    expect(nodes.some((node) => node.type === "codeBlock" && node.attributes.language === "mermaid")).toBe(true);
    expect(parsed.diagnostics.filter((item) => item.severity === "blocking")).toEqual([]);
    const svg = await readFile(new URL("../../../../fixtures/wechat-acceptance/assets/wechat-acceptance-chart.svg", import.meta.url), "utf8");
    expect(svg).not.toMatch(/<script|javascript:/i);
    expect(svg).not.toMatch(/(?:href|src)\s*=\s*["']https?:\/\//i);
  });
});
