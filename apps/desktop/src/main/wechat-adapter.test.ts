import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseDocument, type DocumentNode } from "@fantastic-editor/document-core";
import type { OutputContext, ResolutionRecord } from "@fantastic-editor/shared";
import { formulaReferenceKey, type OutputFormulaAsset } from "./docx-adapter.js";
import type { OutputResourceAsset } from "./offline-html-adapter.js";
import { generateWechatHtml } from "./wechat-adapter.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const HASH = createHash("sha256").update(PNG).digest("hex");

function findFormula(nodes: readonly DocumentNode[]): DocumentNode | undefined {
  for (const node of nodes) {
    if (node.type === "formulaInline" || node.type === "formulaBlock") return node;
    const nested = findFormula(node.children ?? []);
    if (nested) return nested;
  }
  return undefined;
}

async function fixture(state: ResolutionRecord["state"] = "resolved") {
  const parsedDocument = await parseDocument({ documentId: "wechat-document", editorText: "# 标题\n\n正文 **加粗**。\n\n![实验结果](image.png)\n\n公式：$x^2+1$\n" });
  const reference = parsedDocument.resourceReferences[0]!;
  const record: ResolutionRecord = {
    referenceKey: reference.referenceKey,
    workspaceRevision: 1,
    assetCacheKey: state === "resolved" ? "a".repeat(64) : null,
    fileFingerprint: null,
    originalRef: reference.originalRef,
    resolvedRef: reference.resolvedRef,
    workspaceRelativePath: state === "resolved" ? "image.png" : null,
    mimeType: state === "resolved" ? "image/png" : null,
    byteLength: state === "resolved" ? PNG.byteLength : null,
    contentHash: state === "resolved" ? HASH : null,
    width: state === "resolved" ? 320 : null,
    height: state === "resolved" ? 200 : null,
    state,
    candidates: [],
    assetHandle: state === "resolved" ? "00000000-0000-4000-8000-000000000001" : null,
    securityFlags: [],
  };
  const context: OutputContext = {
    jobId: "wechat-job",
    documentId: parsedDocument.documentId,
    target: "wechat-clipboard",
    sourceHash: parsedDocument.sourceHash,
    workspaceRevision: 1,
    preflightId: "wechat-preflight",
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
    derivedAssetManifest: { schema: "fantastic-editor-derived-asset-manifest", jobId: "wechat-job", sourceHash: parsedDocument.sourceHash, workspaceRevision: 1, entries: {} },
    theme: { id: "wechat-green", tokens: {} },
    locale: "zh-CN",
    options: {},
    approvedOmittedReferenceKeys: [],
  };
  const assets: OutputResourceAsset[] = state === "resolved" ? [{ referenceKey: reference.referenceKey, sourceContentHash: HASH, contentHash: HASH, mimeType: "image/png", width: 320, height: 200, bytes: PNG }] : [];
  const formula = findFormula(parsedDocument.children)!;
  const formulaAssets: OutputFormulaAsset[] = [{ formulaReferenceKey: formulaReferenceKey(formula), contentHash: HASH, mimeType: "image/png", width: 64, height: 24, bytes: PNG }];
  return { context, assets, formulaAssets, referenceKey: reference.referenceKey };
}

describe("generateWechatHtml", () => {
  it("generates inline-themed strategy-B HTML with ordered image and formula placeholders", async () => {
    const value = await fixture();
    const result = generateWechatHtml(value.context, value.assets, value.formulaAssets);
    expect(result.status).toBe("completed");
    const html = new TextDecoder().decode(result.bytes!);
    expect(html).toContain("fantastic-editor 图片 01：实验结果");
    expect(html).toContain("fantastic-editor 公式 02：x^2+1");
    expect(html).toContain("border-bottom:2px solid #2f8f63");
    expect(html).not.toMatch(/(?:file:|blob:|localhost|fantastic-asset:|<script|\son\w+=)/i);
    expect(html).not.toContain("data:image");
    expect(html).not.toMatch(/data-source-|PreviewSyncMap|SelectionOverlay|preview-selection/i);
    expect(result.usedReferenceKeys).toEqual([value.referenceKey]);
    expect(result.replacementItems).toEqual([
      expect.objectContaining({ itemId: "wechat-item-01", sequence: 1, kind: "image", sourceKey: value.referenceKey }),
      expect.objectContaining({ itemId: "wechat-item-02", sequence: 2, kind: "formula", mimeType: "image/png" }),
    ]);
  });

  it("requires exact approval for an unavailable ordinary image and marks partial completion", async () => {
    const value = await fixture("missing");
    expect(generateWechatHtml(value.context, [], value.formulaAssets).status).toBe("failed");
    value.context.approvedOmittedReferenceKeys = [value.referenceKey];
    const approved = generateWechatHtml(value.context, [], value.formulaAssets);
    expect(approved.status).toBe("completed-with-omissions");
    expect(approved.omittedReferenceKeys).toEqual([value.referenceKey]);
  });

  it("never allows a missing formula replacement asset to be omitted", async () => {
    const value = await fixture();
    const result = generateWechatHtml(value.context, value.assets, []);
    expect(result.status).toBe("failed");
    expect(result.diagnostics.some((item) => item.code === "FORMULA_DERIVED_ASSET_MISSING" && !item.referenceKey)).toBe(true);
  });
});