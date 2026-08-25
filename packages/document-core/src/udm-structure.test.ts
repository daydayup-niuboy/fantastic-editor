import { describe, expect, it } from "vitest";
import type { DocumentNode, NodeType } from "./model.js";
import { parseDocument } from "./parser.js";
import { createSourceLocator } from "./text.js";

function findAll(nodes: DocumentNode[], type: NodeType): DocumentNode[] {
  return nodes.flatMap((node) => [
    ...(node.type === type ? [node] : []),
    ...findAll(node.children ?? [], type),
  ]);
}

describe("UDM 0.5 structure", () => {
  it("uses UTF-16 offsets and one-based line/column positions", () => {
    const locate = createSourceLocator("😀a\n中文");
    expect(locate(0, 2)).toEqual({
      from: 0, to: 2,
      startLine: 1, startColumn: 1,
      endLine: 1, endColumn: 3,
      precision: "exact",
    });
    expect(locate(4, 6)).toMatchObject({ startLine: 2, startColumn: 1, endLine: 2, endColumn: 3 });
  });

  it("keeps inline images and formulas inside block containers", async () => {
    const parsed = await parseDocument({
      documentId: "structure-inline",
      editorText: "# 标题 $x$\n\n正文 ![图](asset.png)\n",
    });
    expect(parsed.children.every((node) => node.type !== "image" && node.type !== "formulaInline")).toBe(true);
    expect(findAll(parsed.children, "image")).toHaveLength(1);
    expect(findAll(parsed.children, "formulaInline")).toHaveLength(1);
    for (const node of [...findAll(parsed.children, "image"), ...findAll(parsed.children, "formulaInline")]) {
      expect(parsed.sourceLength).toBeGreaterThanOrEqual(node.source.to);
    }
  });

  it("keeps task item order and table alignment in one source", async () => {
    const parsed = await parseDocument({
      documentId: "structure-list-table",
      editorText: "- ordinary\n- [x] done\n- [ ] todo\n\n| L | C | R |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |\n",
    });
    const bullet = findAll(parsed.children, "bulletList")[0]!;
    expect(bullet.children?.map((node) => node.type)).toEqual(["listItem", "taskItem", "taskItem"]);
    expect(bullet.children?.map((node) => node.attributes.checked ?? null)).toEqual([null, true, false]);
    expect(findAll(parsed.children, "table")[0]?.attributes.alignments).toEqual(["left", "center", "right"]);
  });

  it("preserves fenced code content and metadata", async () => {
    const source = "```TypeScript linenos\nconst emoji = '😀';  \n```\n";
    const parsed = await parseDocument({ documentId: "structure-code", editorText: source });
    const code = findAll(parsed.children, "codeBlock")[0]!;
    expect(code.attributes).toMatchObject({
      language: "typescript",
      originalLanguage: "TypeScript",
      meta: "linenos",
      value: "const emoji = '😀';  \n",
      fence: "```",
    });
    expect(source.slice(code.source.from, code.source.to)).toBe(source);
  });
});