import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseDocument } from "@fantastic-editor/document-core";
import type { OutputContext, ResolutionRecord } from "@fantastic-editor/shared";
import { generateOfflineHtml, type OutputResourceAsset } from "./offline-html-adapter.js";

async function fixture(state: ResolutionRecord["state"] = "resolved") {
  const parsedDocument = await parseDocument({ documentId: "document-1", editorText: "# 文档\n\n![图](image.png)" });
  const reference = parsedDocument.resourceReferences[0]!;
  const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const record: ResolutionRecord = {
    referenceKey: reference.referenceKey,
    workspaceRevision: 1,
    assetCacheKey: state === "resolved" ? "b".repeat(64) : null,
    fileFingerprint: null,
    originalRef: "image.png",
    resolvedRef: "image.png",
    workspaceRelativePath: state === "resolved" ? "image.png" : null,
    mimeType: state === "resolved" ? "image/png" : null,
    byteLength: state === "resolved" ? bytes.byteLength : null,
    contentHash: state === "resolved" ? hash : null,
    width: null,
    height: null,
    state,
    candidates: [],
    assetHandle: state === "resolved" ? "00000000-0000-4000-8000-000000000001" : null,
    securityFlags: [],
  };
  const context: OutputContext = {
    jobId: "job-1",
    documentId: parsedDocument.documentId,
    target: "offline-html",
    sourceHash: parsedDocument.sourceHash,
    workspaceRevision: 1,
    preflightId: "preflight-1",
    parsedDocument,
    resolutionSnapshot: {
      schema: "fantastic-editor-resolution-snapshot",
      documentId: parsedDocument.documentId,
      sourceHash: parsedDocument.sourceHash,
      workspaceId: "workspace-1",
      workspaceRevision: 1,
      resolverProfile: "test",
      records: { [reference.referenceKey]: record },
      diagnostics: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    derivedAssetManifest: {
      schema: "fantastic-editor-derived-asset-manifest",
      jobId: "job-1",
      sourceHash: parsedDocument.sourceHash,
      workspaceRevision: 1,
      entries: {},
    },
    theme: { id: "default", tokens: {} },
    locale: "zh-CN",
    approvedOmittedReferenceKeys: [],
    options: {},
  };
  const asset: OutputResourceAsset = {
    referenceKey: reference.referenceKey,
    sourceContentHash: hash,
    contentHash: hash,
    mimeType: "image/png",
    bytes,
  };
  return { context, asset, referenceKey: reference.referenceKey };
}

describe("generateOfflineHtml", () => {
  it("creates a script-free single HTML file with verified Data URI assets", async () => {
    const value = await fixture();
    const result = generateOfflineHtml(value.context, [value.asset]);
    expect(result.status).toBe("completed");
    if (!result.bytes) throw new Error("missing HTML bytes");
    const html = new TextDecoder().decode(result.bytes);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("data:image/png;base64,");
    expect(html).toContain("default-src 'none'");
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/data-source-|PreviewSyncMap|SelectionOverlay|preview-selection/i);
  });

  it("uses the first heading as title and preserves the selected dark theme", async () => {
    const value = await fixture();
    const parsedDocument = await parseDocument({ documentId: "document-1", editorText: "# 标题 <测试>\n\n正文与[链接](https://example.com)。" });
    const context: OutputContext = {
      ...value.context,
      sourceHash: parsedDocument.sourceHash,
      parsedDocument,
      resolutionSnapshot: { ...value.context.resolutionSnapshot, sourceHash: parsedDocument.sourceHash, records: {} },
      derivedAssetManifest: { ...value.context.derivedAssetManifest, sourceHash: parsedDocument.sourceHash },
      theme: { id: "dark", tokens: { colorScheme: "dark", "typography.body.fontFamily": "Arial" } },
    };
    const result = generateOfflineHtml(context, []);
    expect(result.status).toBe("completed");
    const html = new TextDecoder().decode(result.bytes!);
    expect(html).toContain("<title>标题 &lt;测试&gt;</title>");
    expect(html).toContain('<meta name="color-scheme" content="dark">');
    expect(html).toContain('color-scheme:dark');
    expect(html).toContain('<main class="document" role="document"');
    expect(html).toContain('font-family:"Arial"');
    expect(html).not.toMatch(/<script\b|\son[a-z]+\s*=|(?:file|blob|app|fantastic-asset):/i);
  });

  it("adds the frozen A4 pagination contract only for PDF", async () => {
    const value = await fixture();
    const offlineResult = generateOfflineHtml(value.context, [value.asset]);
    const pdfResult = generateOfflineHtml({ ...value.context, target: "pdf" }, [value.asset]);
    const offlineHtml = new TextDecoder().decode(offlineResult.bytes!);
    const pdfHtml = new TextDecoder().decode(pdfResult.bytes!);
    expect(offlineHtml).not.toContain("@page{size:A4 portrait");
    expect(pdfHtml).toContain("@page{size:A4 portrait");
    expect(pdfHtml).toContain("display:table-header-group");
    expect(pdfHtml).toContain("white-space:pre-wrap");
    expect(pdfHtml).toContain("max-height:245mm");
  });

  it("embeds KaTeX CSS and WOFF2 fonts without scripts or external font URLs", async () => {
    const value = await fixture();
    const parsedDocument = await parseDocument({ documentId: "document-1", editorText: "行内公式 $x^2$。\n\n$$\\sum_{i=1}^n i$$" });
    const context = {
      ...value.context,
      sourceHash: parsedDocument.sourceHash,
      parsedDocument,
      resolutionSnapshot: { ...value.context.resolutionSnapshot, sourceHash: parsedDocument.sourceHash, records: {} },
      derivedAssetManifest: { ...value.context.derivedAssetManifest, sourceHash: parsedDocument.sourceHash },
    };
    const result = generateOfflineHtml(context, []);
    expect(result.status).toBe("completed");
    const html = new TextDecoder().decode(result.bytes!);
    expect(html).toContain("data:font/woff2;base64,");
    expect(html).toContain("class=\"katex\"");
    expect(html).not.toContain("url(fonts/");
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/data-source-|PreviewSyncMap|SelectionOverlay|preview-selection/i);
  });

  it("fails invalid formulas instead of silently exporting error markup", async () => {
    const value = await fixture();
    const parsedDocument = await parseDocument({ documentId: "document-1", editorText: "$\\badcommand{x}$" });
    const context = {
      ...value.context,
      sourceHash: parsedDocument.sourceHash,
      parsedDocument,
      resolutionSnapshot: { ...value.context.resolutionSnapshot, sourceHash: parsedDocument.sourceHash, records: {} },
      derivedAssetManifest: { ...value.context.derivedAssetManifest, sourceHash: parsedDocument.sourceHash },
    };
    const result = generateOfflineHtml(context, []);
    expect(result.status).toBe("failed");
    expect(result.bytes).toBeNull();
    expect(result.diagnostics.some((item) => item.code === "FORMULA_RENDER_FAILED")).toBe(true);
  });

  it("requires exact task approval before omitting an unavailable resource", async () => {
    const value = await fixture("missing");
    expect(generateOfflineHtml(value.context, []).status).toBe("failed");
    const approved = {
      ...value.context,
      approvedOmittedReferenceKeys: [value.referenceKey],
    };
    const result = generateOfflineHtml(approved, []);
    expect(result.status).toBe("completed-with-omissions");
    expect(result.omittedReferenceKeys).toEqual([value.referenceKey]);
    expect(new TextDecoder().decode(result.bytes!)).toContain("resource-placeholder");
  });

  it("fails when packaged bytes no longer match their content hash", async () => {
    const value = await fixture();
    const result = generateOfflineHtml(value.context, [{ ...value.asset, bytes: Uint8Array.from([1, 2, 3]) }]);
    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]?.code).toBe("OUTPUT_RESOURCE_PACKAGE_INVALID");
  });
});