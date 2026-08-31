import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseDocument } from "@fantastic-editor/document-core";
import type { OutputContext } from "@fantastic-editor/shared";
import { generateDocx } from "./docx-adapter";
import { collectMermaidNodes, mermaidReferenceKey, type OutputMermaidAsset } from "./mermaid-assets";
import { generateOfflineHtml } from "./offline-html-adapter";
import { generateWechatHtml } from "./wechat-adapter";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

async function fixture(): Promise<{ context: OutputContext; asset: OutputMermaidAsset }> {
  const parsedDocument = await parseDocument({
    documentId: "mermaid-output",
    editorText: "# Diagram\n\n```mermaid\ngraph TD\n  A --> B\n```\n",
  });
  const node = collectMermaidNodes(parsedDocument.children)[0]!;
  const context: OutputContext = {
    jobId: "mermaid-job",
    documentId: parsedDocument.documentId,
    target: "offline-html",
    sourceHash: parsedDocument.sourceHash,
    workspaceRevision: 1,
    preflightId: "mermaid-preflight",
    parsedDocument,
    resolutionSnapshot: {
      schema: "fantastic-editor-resolution-snapshot",
      documentId: parsedDocument.documentId,
      sourceHash: parsedDocument.sourceHash,
      workspaceId: "workspace-1",
      workspaceRevision: 1,
      resolverProfile: "test",
      records: {},
      diagnostics: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    derivedAssetManifest: {
      schema: "fantastic-editor-derived-asset-manifest",
      jobId: "mermaid-job",
      sourceHash: parsedDocument.sourceHash,
      workspaceRevision: 1,
      entries: {},
    },
    theme: { id: "user-preview", tokens: { "typography.body.fontFamily": "KaiTi" } },
    locale: "zh-CN",
    approvedOmittedReferenceKeys: [],
    options: {},
  };
  return {
    context,
    asset: {
      mermaidReferenceKey: mermaidReferenceKey(node),
      contentHash: createHash("sha256").update(PNG).digest("hex"),
      mimeType: "image/png",
      width: 640,
      height: 360,
      bytes: PNG,
    },
  };
}

describe("Mermaid exports", () => {
  it("embeds a script-free PNG in offline HTML and applies the selected font", async () => {
    const value = await fixture();
    const result = generateOfflineHtml(value.context, [], [value.asset]);
    expect(result.status, JSON.stringify(result.diagnostics)).toBe("completed");
    const html = new TextDecoder().decode(result.bytes!);
    expect(html).toContain('class="mermaid-export"');
    expect(html).toContain("data:image/png;base64,");
    expect(html).toContain('font-family:"KaiTi"');
    expect(html).not.toContain("language-mermaid");
    expect(html).not.toContain("<script");
  });

  it("uses Mermaid PNG assets in DOCX and the WeChat replacement manifest", async () => {
    const value = await fixture();
    const docx = await generateDocx({ ...value.context, target: "docx" }, [], [], [value.asset]);
    expect(docx.status, JSON.stringify(docx.diagnostics)).toBe("completed");
    expect(docx.bytes?.subarray(0, 2)).toEqual(Uint8Array.from([0x50, 0x4b]));

    const wechat = generateWechatHtml({ ...value.context, target: "wechat-clipboard" }, [], [], [value.asset]);
    expect(wechat.status, JSON.stringify(wechat.diagnostics)).toBe("completed");
    expect(wechat.replacementItems).toHaveLength(1);
    expect(wechat.replacementItems?.[0]?.kind).toBe("diagram");
    expect(wechat.replacementItems?.[0]?.placement).toBe("block");
  });

  it("fails closed when the derived Mermaid asset is missing", async () => {
    const value = await fixture();
    expect(generateOfflineHtml(value.context, [], []).status).toBe("failed");
    expect((await generateDocx({ ...value.context, target: "docx" }, [], [], [])).status).toBe("failed");
  });
});
