import { describe, expect, it } from "vitest";
import { parseDocument, renderPreviewHtml } from "./index.js";

describe("large document pressure baseline", () => {
  it("parses and renders a representative large article within the worker budget", async () => {
    const block = "# 性能标题\n\n这是一段包含 **加粗**、[链接](https://example.com) 和列表语义的正文。\n\n- 第一项\n- 第二项\n\n";
    const editorText = block.repeat(5_000);
    const startedAt = performance.now();
    const parsed = await parseDocument({ documentId: "large-pressure-document", editorText });
    const previewHtml = renderPreviewHtml(editorText, parsed.resourceReferences);
    const durationMs = performance.now() - startedAt;

    expect(editorText.length).toBeGreaterThan(300_000);
    expect(parsed.sourceLength).toBe(editorText.length);
    expect(parsed.statistics.headings).toBe(5_000);
    expect(parsed.children.length).toBeGreaterThan(10_000);
    expect(previewHtml.length).toBeGreaterThan(editorText.length);
    expect(durationMs).toBeLessThan(5_000);
  }, 15_000);

  it("handles thousands of image references without losing stable identities", async () => {
    const editorText = "![重复图片](assets/shared.png)\n\n".repeat(2_000);
    const parsed = await parseDocument({ documentId: "large-image-reference-document", editorText });

    expect(parsed.statistics.images).toBe(2_000);
    expect(parsed.resourceReferences).toHaveLength(2_000);
    expect(new Set(parsed.resourceReferences.map((reference) => reference.referenceKey)).size).toBe(2_000);
  }, 15_000);
});

