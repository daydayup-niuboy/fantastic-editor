import { describe, expect, it } from "vitest";
import { parseDocument, renderParsedDocumentHtml } from "./index.js";

describe("renderParsedDocumentHtml", () => {
  it("renders shared semantic HTML without reinterpreting Markdown", async () => {
    const parsed = await parseDocument({
      documentId: "html-document",
      editorText: "# 标题\n\n正文 **加粗** 与 $E=mc^2$。\n\n![[assets/image.png]]\n",
    });
    const referenceKey = parsed.resourceReferences[0]!.referenceKey;
    const html = renderParsedDocumentHtml(parsed, {
      imageSources: { [referenceKey]: "data:image/png;base64,AA==" },
    });
    expect(html).toContain("<h1>标题</h1>");
    expect(html).toContain("<strong>加粗</strong>");
    expect(html).toContain("katex");
    expect(html).toContain('src="data:image/png;base64,AA=="');
    expect(html).not.toContain("![[");
  });

  it("never emits source raw HTML", async () => {
    const parsed = await parseDocument({
      documentId: "html-security",
      editorText: '<img src="x" onerror="alert(1)">',
    });
    const html = renderParsedDocumentHtml(parsed);
    expect(html).toContain("原始 HTML 已阻止");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("<img src=\"x\"");
  });

  it("uses a visible placeholder when an image source is not supplied", async () => {
    const parsed = await parseDocument({ documentId: "html-placeholder", editorText: "![a](a.png)" });
    const html = renderParsedDocumentHtml(parsed);
    expect(html).toContain("resource-placeholder");
    expect(html).toContain(parsed.resourceReferences[0]!.referenceKey);
  });
});