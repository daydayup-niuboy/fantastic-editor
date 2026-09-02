import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseDocument, type DocumentNode } from "@fantastic-editor/document-core";
import type { OutputContext, ResolutionRecord } from "@fantastic-editor/shared";
import { formulaReferenceKey, type OutputFormulaAsset } from "./docx-adapter.js";
import type { OutputResourceAsset } from "./offline-html-adapter.js";
import { generateWechatHtml } from "./wechat-adapter.js";
import { resolveWechatTheme } from "./wechat-themes.js";
import { collectMermaidNodes, mermaidReferenceKey, type OutputMermaidAsset } from "./mermaid-assets.js";

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

function collectFormulas(nodes: readonly DocumentNode[]): DocumentNode[] {
  const formulas: DocumentNode[] = [];
  const visit = (items: readonly DocumentNode[]) => {
    for (const node of items) {
      if (node.type === "formulaInline" || node.type === "formulaBlock") formulas.push(node);
      visit(node.children ?? []);
    }
  };
  visit(nodes);
  return formulas;
}

async function fixture(state: ResolutionRecord["state"] = "resolved") {
  const parsedDocument = await parseDocument({ documentId: "wechat-document", editorText: "# 标题\n\n## 小节\n\n正文 **加粗** 与 [链接](https://example.com)。\n\n> 引用内容\n\n- 列表项\n- [ ] 任务项\n\n| 项目 | 状态 |\n| --- | --- |\n| 主题 | 正常 |\n\n```ts\nconst theme = true;\n```\n\n![实验结果](image.png)\n\n公式：$x^2+1$\n" });
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
    theme: { id: "wechat-native-enhanced", tokens: {} },
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
    expect(html).toContain("【FE图片01｜整段替换】");
    expect(html).toContain("【FE公式02｜行内替换】");
    expect(html).not.toContain("border:2px dashed");
    expect(html).not.toContain("<h1");
    expect(result.suggestedTitle).toBe("标题");
    expect(html).not.toMatch(/(?:file:|blob:|localhost|fantastic-asset:|<script|\son\w+=)/i);
    expect(html).not.toContain("data:image");
    expect(html).not.toMatch(/data-source-|PreviewSyncMap|SelectionOverlay|preview-selection/i);
    expect(result.usedReferenceKeys).toEqual([value.referenceKey]);
    expect(result.replacementItems).toEqual([
      expect.objectContaining({ itemId: "wechat-item-01", sequence: 1, kind: "image", placement: "block", sourceKey: value.referenceKey, placeholderText: "【FE图片01｜整段替换】" }),
      expect.objectContaining({ itemId: "wechat-item-02", sequence: 2, kind: "formula", placement: "inline", mimeType: "image/png", placeholderText: "【FE公式02｜行内替换】" }),
    ]);
  });

  it("requires exact approval for an unavailable ordinary image and marks partial completion", async () => {
    const value = await fixture("missing");
    expect(generateWechatHtml(value.context, [], value.formulaAssets).status).toBe("failed");
    value.context.approvedOmittedReferenceKeys = [value.referenceKey];
    const approved = generateWechatHtml(value.context, [], value.formulaAssets);
    expect(approved.status).toBe("completed-with-omissions");
    expect(approved.omittedReferenceKeys).toEqual([value.referenceKey]);
    expect(approved.replacementItems).toEqual([
      expect.objectContaining({ itemId: "wechat-item-01", sequence: 1, kind: "formula", placement: "inline", placeholderText: "【FE公式01｜行内替换】" }),
    ]);
  });

  it("never allows a missing formula replacement asset to be omitted", async () => {
    const value = await fixture();
    const result = generateWechatHtml(value.context, value.assets, []);
    expect(result.status).toBe("failed");
    expect(result.diagnostics.some((item) => item.code === "FORMULA_DERIVED_ASSET_MISSING" && !item.referenceKey)).toBe(true);
  });

  it("changes only inline presentation when switching among the three controlled themes", async () => {
    const value = await fixture();
    const outputs = ["wechat-native-enhanced", "minimal-ink", "deep-blue-tech"].map((themeId) => {
      const result = generateWechatHtml({ ...value.context, theme: { id: themeId, tokens: {} } }, value.assets, value.formulaAssets);
      return { themeId, result, html: new TextDecoder().decode(result.bytes!) };
    });
    expect(outputs.map((item) => item.result.status)).toEqual(["completed", "completed", "completed"]);
    expect(new Set(outputs.map((item) => item.html)).size).toBe(3);
    for (const output of outputs) {
      expect(output.result.suggestedTitle).toBe("标题");
      expect(output.result.usedReferenceKeys).toEqual([value.referenceKey]);
      expect(output.result.omittedReferenceKeys).toEqual([]);
      expect(output.result.replacementItems).toEqual(outputs[0]!.result.replacementItems);
      expect(output.html).not.toMatch(/<style|class=|data-fe-|(?:file|blob|data|fantastic-asset):|\son\w+=/i);
    }
    expect(outputs[0]!.html).toContain("line-height:1.8");
    expect(outputs[1]!.html).toContain("line-height:1.9");
    expect(outputs[2]!.html).toContain("line-height:1.82");
  });

  it("accepts the read-time legacy alias but rejects arbitrary theme ids", () => {
    expect(resolveWechatTheme("wechat-green").id).toBe("wechat-native-enhanced");
    expect(() => resolveWechatTheme("<style>body{display:none}</style>")).toThrowError(/未知公众号主题/);
  });

  it("does not treat forbidden-protocol words in article text as live resource addresses", async () => {
    const value = await fixture();
    value.context.parsedDocument = await parseDocument({
      documentId: value.context.documentId,
      editorText: "# 标题\n\n正文可以讨论 `file:`、`blob:`、`data:`、`app:`、`fantastic-asset:` 与 `http://localhost/`，但不会把它们作为资源地址输出。",
    });
    value.context.sourceHash = value.context.parsedDocument.sourceHash;
    value.context.resolutionSnapshot = { ...value.context.resolutionSnapshot, sourceHash: value.context.sourceHash, records: {} };
    value.context.derivedAssetManifest = { ...value.context.derivedAssetManifest, sourceHash: value.context.sourceHash };

    const result = generateWechatHtml(value.context, [], []);

    expect(result.status).toBe("completed");
    expect(new TextDecoder().decode(result.bytes!)).toContain("file:");
  });

  it("still blocks a forbidden resource address injected into generated markup", async () => {
    const value = await fixture();
    const result = generateWechatHtml({
      ...value.context,
      theme: { id: "wechat-native-enhanced", tokens: { "typography.body.fontFamily": "data:image/png" } },
    }, value.assets, value.formulaAssets);

    expect(result.status).toBe("failed");
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "WECHAT_HTML_SECURITY_AUDIT_FAILED", message: expect.stringContaining("本地、临时或内嵌资源地址") }),
    ]));
  });

  it("passes the repository real-environment acceptance fixture through the final security audit", async () => {
    const editorText = await readFile(new URL("../../../../fixtures/wechat-acceptance/standard.md", import.meta.url), "utf8");
    const parsedDocument = await parseDocument({ documentId: "wechat-acceptance", editorText });
    const reference = parsedDocument.resourceReferences[0]!;
    const record: ResolutionRecord = {
      referenceKey: reference.referenceKey,
      workspaceRevision: 1,
      assetCacheKey: "a".repeat(64),
      fileFingerprint: null,
      originalRef: reference.originalRef,
      resolvedRef: reference.resolvedRef,
      workspaceRelativePath: "assets/wechat-acceptance-chart.svg",
      mimeType: "image/png",
      byteLength: PNG.byteLength,
      contentHash: HASH,
      width: 320,
      height: 200,
      state: "resolved",
      candidates: [],
      assetHandle: "00000000-0000-4000-8000-000000000001",
      securityFlags: [],
    };
    const context: OutputContext = {
      jobId: "wechat-acceptance-job",
      documentId: parsedDocument.documentId,
      target: "wechat-clipboard",
      sourceHash: parsedDocument.sourceHash,
      workspaceRevision: 1,
      preflightId: "wechat-acceptance-preflight",
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
      derivedAssetManifest: { schema: "fantastic-editor-derived-asset-manifest", jobId: "wechat-acceptance-job", sourceHash: parsedDocument.sourceHash, workspaceRevision: 1, entries: {} },
      theme: { id: "wechat-native-enhanced", tokens: {} },
      locale: "zh-CN",
      options: {},
      approvedOmittedReferenceKeys: [],
    };
    const assets: OutputResourceAsset[] = [{ referenceKey: reference.referenceKey, sourceContentHash: HASH, contentHash: HASH, mimeType: "image/png", width: 320, height: 200, bytes: PNG }];
    const formulaAssets: OutputFormulaAsset[] = collectFormulas(parsedDocument.children).map((node) => ({ formulaReferenceKey: formulaReferenceKey(node), contentHash: HASH, mimeType: "image/png", width: 64, height: 24, bytes: PNG }));
    const mermaidAssets: OutputMermaidAsset[] = collectMermaidNodes(parsedDocument.children).map((node) => ({ mermaidReferenceKey: mermaidReferenceKey(node), contentHash: HASH, mimeType: "image/png", width: 320, height: 160, bytes: PNG }));

    const result = generateWechatHtml(context, assets, formulaAssets, mermaidAssets);

    expect(result.status, result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n")).toBe("completed");
    expect(result.replacementItems?.map((item) => item.kind)).toEqual(["formula", "image", "formula", "diagram"]);
  });
});
