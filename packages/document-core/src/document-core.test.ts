import { describe, expect, it } from "vitest";
import {
  canonicalizeEditorText,
  classifyReference,
  detectLineSeparator,
  parseDocument,
  renderPreviewHtml,
} from "./index.js";

describe("canonical editor text", () => {
  it("normalizes CRLF and bare CR to LF", () => {
    expect(canonicalizeEditorText("a\r\nb\rc\n")).toBe("a\nb\nc\n");
  });

  it("detects mixed line separators", () => {
    expect(detectLineSeparator("a\r\nb\n")).toBe("mixed");
    expect(detectLineSeparator("a\r\nb\r\n")).toBe("crlf");
  });
});

describe("resource classification", () => {
  it("does not mistake Windows paths for URI schemes", async () => {
    await expect(classifyReference("C:\\docs\\image.png")).resolves.toMatchObject({
      kind: "local-path",
      normalizedResolvedRef: "C:/docs/image.png",
    });
    await expect(classifyReference("C:docs\\image.png")).resolves.toMatchObject({
      kind: "local-path",
      blockedCode: "DRIVE_RELATIVE_PATH_BLOCKED",
    });
    await expect(classifyReference("\\\\server\\share\\image.png")).resolves.toMatchObject({
      kind: "local-path",
      normalizedResolvedRef: "//server/share/image.png",
    });
  });
});

describe("ParsedDocument", () => {
  it("parses a completely blank Markdown document", async () => {
    const parsed = await parseDocument({ documentId: "blank-document", editorText: "" });

    expect(parsed.sourceLength).toBe(0);
    expect(parsed.children).toEqual([]);
    expect(parsed.resourceReferences).toEqual([]);
    expect(parsed.statistics).toMatchObject({ headings: 0, images: 0, formulas: 0, characters: 0 });
  });

  it("is deterministic for the same source and documentId", async () => {
    const input = { documentId: "doc-1", editorText: "# 标题\r\n\r\n正文" };
    expect(await parseDocument(input)).toEqual(await parseDocument(input));
  });

  it("redacts and blocks source data URIs outside editorText", async () => {
    const payload = "data:image/png;base64,TOP_SECRET_PAYLOAD";
    const parsed = await parseDocument({
      documentId: "doc-data",
      editorText: `![secret](${payload})`,
    });
    const serialized = JSON.stringify(parsed);
    expect(parsed.resourceReferences[0]).toMatchObject({
      kind: "data-uri",
      originalRef: "data:[blocked]",
      resolvedRef: "data:[blocked]",
    });
    expect(parsed.diagnostics[0]?.code).toBe("DATA_URI_SOURCE_BLOCKED");
    expect(serialized).not.toContain("TOP_SECRET_PAYLOAD");
  });

  it("binds preview placeholders to reference keys without exposing image URLs", async () => {
    const source = "![remote](https://example.com/tracker.png)";
    const parsed = await parseDocument({ documentId: "doc-preview", editorText: source });
    const html = renderPreviewHtml(source, parsed.resourceReferences);
    expect(html).toContain("resource-placeholder");
    expect(html).toContain(`data-reference-key="${parsed.resourceReferences[0]?.referenceKey}"`);
    expect(html).toContain(`data-source-from="0" data-source-to="${source.length}" data-source-kind="image"`);
    expect(html).not.toContain("https://example.com");
    expect(html).not.toContain("<img");
  });

  it("adds internal source anchors to visible preview blocks and protected inline content", async () => {
    const inlineLink = "[链接](https://example.com)";
    const inlineCode = "`code`";
    const source = `# 标题\n\n正文含 ${inlineLink}、${inlineCode} 与 $a+b$ 公式\n\n$$\nx + y\n$$\n`;
    const html = renderPreviewHtml(source);
    const inlineFormulaFrom = source.indexOf("$a+b$");
    const inlineLinkFrom = source.indexOf(inlineLink);
    const inlineCodeFrom = source.indexOf(inlineCode);
    const blockFormulaFrom = source.indexOf("$$");
    expect(html).toMatch(/<h1[^>]*data-source-from="0"[^>]*data-source-kind="heading"/);
    expect(html).toMatch(/<p[^>]*data-source-kind="paragraph"/);
    expect(html).toContain(`data-source-from="${inlineFormulaFrom}" data-source-to="${inlineFormulaFrom + 5}" data-source-kind="formula-inline"`);
    expect(html).toContain(`data-source-from="${inlineLinkFrom}" data-source-to="${inlineLinkFrom + inlineLink.length}" data-source-kind="inline-link"`);
    expect(html).toContain(`data-source-from="${inlineCodeFrom}" data-source-to="${inlineCodeFrom + inlineCode.length}" data-source-kind="inline-code"`);
    expect(html).toMatch(new RegExp(`data-source-from="${blockFormulaFrom}"[^>]*data-source-kind="formula-block"`));
    const fenced = renderPreviewHtml("```mermaid\ngraph TD\n  A --> B\n```\n");
    expect(fenced).toMatch(/<pre[^>]*data-source-from="0"[^>]*data-source-kind="code-block"/);
  });

  it("adds precise source anchors to table cells without including delimiters", () => {
    const source = "| 名称 | `a\\|b` |\n| :--- | ---: |\n| A\\|B | **1** |\n";
    const html = renderPreviewHtml(source);
    const headerFrom = source.indexOf("名称");
    const codeFrom = source.indexOf("`a\\|b`");
    const escapedFrom = source.indexOf("A\\|B");
    const strongFrom = source.indexOf("**1**");
    expect(html).toContain(`data-source-from="${headerFrom}" data-source-to="${headerFrom + 2}" data-source-kind="table-cell"`);
    expect(html).toContain(`data-source-from="${codeFrom}" data-source-to="${codeFrom + 6}" data-source-kind="table-cell"`);
    expect(html).toContain(`data-source-from="${escapedFrom}" data-source-to="${escapedFrom + 4}" data-source-kind="table-cell"`);
    expect(html).toContain(`data-source-from="${strongFrom}" data-source-to="${strongFrom + 5}" data-source-kind="table-cell"`);
  });

  it("renders wiki images as keyed placeholders and never leaks data URI payloads", async () => {
    const payload = "TOP_SECRET_PREVIEW_PAYLOAD";
    const source = `![[assets/wiki.png]]\n\n![secret](data:image/png;base64,${payload})`;
    const parsed = await parseDocument({ documentId: "doc-preview-security", editorText: source });
    const html = renderPreviewHtml(source, parsed.resourceReferences);
    expect(html.match(/data-reference-key=/g)).toHaveLength(2);
    expect(html).not.toContain("![[");
    expect(html).not.toContain(payload);
    expect(html).not.toContain("<img");
  });

  it("ignores image-looking text in code and escaped Markdown", async () => {
    const parsed = await parseDocument({
      documentId: "doc-code",
      editorText: "```md\n![not-image](secret.png)\n```\n\\![escaped](also-secret.png)\n",
    });
    expect(parsed.resourceReferences).toHaveLength(0);
  });

  it("replaces wiki image source text with one correctly ordered image node", async () => {
    const parsed = await parseDocument({
      documentId: "doc-wiki-inline",
      editorText: "before ![[assets/image.png]] after",
    });
    const paragraph = parsed.children.find((node) => node.type === "paragraph");
    expect(paragraph?.children?.map((node) => node.type)).toEqual(["text", "image", "text"]);
    expect(paragraph?.children?.map((node) => node.attributes.value ?? node.attributes.resolvedRef))
      .toEqual(["before ", "assets/image.png", " after"]);
    expect(JSON.stringify(parsed.children)).not.toContain("![[assets/image.png]]");
  });

  it("keeps a wiki image inside its inline formatting container", async () => {
    const parsed = await parseDocument({
      documentId: "doc-wiki-emphasis",
      editorText: "*before ![[assets/image.png]] after*",
    });
    const paragraph = parsed.children.find((node) => node.type === "paragraph");
    const emphasis = paragraph?.children?.find((node) => node.type === "emphasis");
    expect(emphasis?.children?.map((node) => node.type)).toEqual(["text", "image", "text"]);
  });

  it("keeps an extensionless wiki embed as an explicit resource reference", async () => {
    const parsed = await parseDocument({ documentId: "doc-wiki-no-extension", editorText: "![[image]]" });
    expect(parsed.resourceReferences).toHaveLength(1);
    expect(parsed.resourceReferences[0]).toMatchObject({ syntax: "wiki-image", resolvedRef: "image" });
    expect(JSON.stringify(parsed.children)).toContain('"type":"image"');
  });

  it("keeps every resource nodeId connected to a document node", async () => {
    const parsed = await parseDocument({ documentId: "doc-node", editorText: "![a](image.png)" });
    const collectIds = (nodes: typeof parsed.children): string[] => nodes.flatMap((node) => [node.id, ...collectIds(node.children ?? [])]);
    const nodeIds = new Set(collectIds(parsed.children));
    expect(nodeIds.has(parsed.resourceReferences[0]!.nodeId)).toBe(true);
  });

  it("creates reference keys bound to document and source range", async () => {
    const first = await parseDocument({ documentId: "doc-a", editorText: "![a](image.png)" });
    const second = await parseDocument({ documentId: "doc-b", editorText: "![a](image.png)" });
    expect(first.resourceReferences[0]?.referenceKey).not.toBe(
      second.resourceReferences[0]?.referenceKey,
    );
  });
});
