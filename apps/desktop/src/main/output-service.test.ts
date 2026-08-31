import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDocument } from "@fantastic-editor/document-core";
import { FANTASTIC_EDITOR_LIMITS } from "@fantastic-editor/shared";
import type {
  BeginOutputRequest,
  OutputContext,
  ResolutionRecord,
  ResolutionSnapshot,
} from "@fantastic-editor/shared";
import type { SingleFileResolutionContext } from "./file-sessions.js";
import { generateDocx } from "./docx-adapter.js";
import { generateOfflineHtml } from "./offline-html-adapter.js";
import { OutputService } from "./output-service.js";
import { generateWechatHtml } from "./wechat-adapter.js";
import { AssetHandleRegistry } from "./single-file-resource-resolver.js";

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture(editorText = "# 可导出文档\n\n正文。") {
  const parsedDocument = await parseDocument({ documentId: "document-1", editorText });
  const context: SingleFileResolutionContext = {
    sessionId: "session-1",
    documentId: parsedDocument.documentId,
    workspaceId: "workspace-1",
    workspaceRevision: 1,
  workspaceMode: "single-file",
    grantId: "grant-1",
    documentRealPath: "C:\\workspace\\article.md",
    authorizationRootRealPath: "C:\\workspace",
  };
  const records: Record<string, ResolutionRecord> = {};
  for (const reference of parsedDocument.resourceReferences) {
    records[reference.referenceKey] = {
      referenceKey: reference.referenceKey,
      workspaceRevision: 1,
      assetCacheKey: null,
      fileFingerprint: null,
      originalRef: reference.originalRef,
      resolvedRef: reference.normalizedResolvedRef,
      workspaceRelativePath: null,
      mimeType: null,
      byteLength: null,
      contentHash: null,
      width: null,
      height: null,
      state: "missing",
      candidates: [],
      assetHandle: null,
      securityFlags: [],
    };
  }
  const snapshot: ResolutionSnapshot = {
    schema: "fantastic-editor-resolution-snapshot",
    documentId: parsedDocument.documentId,
    sourceHash: parsedDocument.sourceHash,
    workspaceId: context.workspaceId,
    workspaceRevision: context.workspaceRevision,
    resolverProfile: "test",
    records,
    diagnostics: Object.values(records).map((record) => ({
      id: `missing-${record.referenceKey}`,
      code: "RESOURCE_MISSING",
      severity: "blocking" as const,
      category: "resource" as const,
      message: "图片不存在。",
      referenceKey: record.referenceKey,
    })),
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const request: BeginOutputRequest = {
    documentId: parsedDocument.documentId,
    target: "offline-html",
    sourceHash: parsedDocument.sourceHash,
    parserProfile: parsedDocument.parserProfile,
    taskSequence: 1,
    parseCommitId: "parse-commit-1",
    workspaceRevision: 1,
    parsedDocument,
  };
  return { context, snapshot, request };
}

function createService(saved: Uint8Array[], current: { value: boolean }) {
  return new OutputService(
    new AssetHandleRegistry(),
    { transformSvg: async () => ({ status: "failed", code: "UNEXPECTED_SVG_TRANSFORM", message: "unexpected SVG transform" } as const) },
    {
      generateOfflineHtml: async (context: OutputContext, assets) => generateOfflineHtml(context, assets),
      generateDocx: async (context: OutputContext, assets, formulaAssets) => generateDocx(context, assets, formulaAssets),
      generateWechatHtml: async (context: OutputContext, assets, formulaAssets) => generateWechatHtml(context, assets, formulaAssets),
      cancelJob: () => true,
    },
    async (_name, bytes) => {
      saved.push(bytes);
      return {
        status: "saved" as const,
        artifact: { kind: "file" as const, displayName: "article.html", mimeType: "text/html", byteLength: bytes.byteLength },
      };
    },
  );
}

function remember(service: OutputService, value: Fixture): void {
  service.rememberResolution(value.request.parseCommitId, value.snapshot);
}

describe("OutputService", () => {
  it("reports a clipboard-specific diagnostic when WeChat clipboard persistence fails", async () => {
    const value = await fixture("# 公众号标题\n\n正文可以讨论 `data:` 与 `http://localhost/`。\n");
    value.request = { ...value.request, target: "wechat-clipboard" };
    const service = new OutputService(
      new AssetHandleRegistry(),
      { transformSvg: async () => ({ status: "failed", code: "UNEXPECTED_SVG_TRANSFORM", message: "unexpected SVG transform" } as const) },
      {
        generateOfflineHtml: async (context: OutputContext, assets) => generateOfflineHtml(context, assets),
        generateDocx: async (context: OutputContext, assets, formulaAssets) => generateDocx(context, assets, formulaAssets),
        generateWechatHtml: async (context: OutputContext, assets, formulaAssets) => generateWechatHtml(context, assets, formulaAssets),
        cancelJob: () => true,
      },
      async () => ({ status: "failed" as const, error: "模拟剪贴板失败。" }),
    );
    remember(service, value);

    const result = await service.begin(value.request, value.context, () => true);

    expect(result.status).toBe("failed");
    expect(result.result?.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "OUTPUT_CLIPBOARD_WRITE_FAILED", message: "模拟剪贴板失败。" }),
    ]));
    expect(result.result?.diagnostics.some((item) => item.code === "OUTPUT_FILE_WRITE_FAILED")).toBe(false);
  });

  it("exports a current resource-free document as a complete result", async () => {
    const value = await fixture();
    const saved: Uint8Array[] = [];
    const current = { value: true };
    const service = createService(saved, current);
    remember(service, value);
    const result = await service.begin(value.request, value.context, () => current.value);
    expect(result.status).toBe("completed");
    expect(result.result?.status).toBe("completed");
    expect(result.result?.omittedReferenceKeys).toEqual([]);
    expect(saved).toHaveLength(1);
  });

  it("accepts only known WeChat theme ids and records the effective theme in the result", async () => {
    const value = await fixture("# 公众号标题\n\n## 小节\n\n正文。");
    value.request = { ...value.request, target: "wechat-clipboard", wechatThemeId: "deep-blue-tech" };
    const saved: Uint8Array[] = [];
    const service = createService(saved, { value: true });
    remember(service, value);
    const result = await service.begin(value.request, value.context, () => true);
    expect(result.status).toBe("completed");
    expect(result.result?.wechatThemeId).toBe("deep-blue-tech");
    expect(new TextDecoder().decode(saved[0])).toContain("#3478c7");

    const invalid = await fixture("# 公众号标题\n\n正文。");
    invalid.request = { ...invalid.request, target: "wechat-clipboard", wechatThemeId: "<style>" as never };
    const rejected = createService([], { value: true });
    remember(rejected, invalid);
    const rejectedResult = await rejected.begin(invalid.request, invalid.context, () => true);
    expect(rejectedResult.status).toBe("failed");
    expect(rejectedResult.error).toContain("请求无效");
  });

  it("requires exact one-job approval and reports approved omissions as partial completion", async () => {
    const value = await fixture("# 文档\n\n![缺图](missing.png)");
    const saved: Uint8Array[] = [];
    const current = { value: true };
    const service = createService(saved, current);
    remember(service, value);
    const begun = await service.begin(value.request, value.context, () => current.value);
    expect(begun.status).toBe("approval-required");
    const candidate = begun.preflight?.candidateOmittedReferenceKeys[0];
    if (!begun.job?.preflightId || !candidate) throw new Error("missing approval identity");
    const rejected = await service.approve({
      preflightId: begun.job.preflightId,
      jobId: begun.job.jobId,
      documentId: value.request.documentId,
      sourceHash: value.request.sourceHash,
      workspaceRevision: value.request.workspaceRevision,
      approvedOmittedReferenceKeys: [],
    });
    expect(rejected.status).toBe("failed");
    const approved = await service.approve({
      preflightId: begun.job.preflightId,
      jobId: begun.job.jobId,
      documentId: value.request.documentId,
      sourceHash: value.request.sourceHash,
      workspaceRevision: value.request.workspaceRevision,
      approvedOmittedReferenceKeys: [candidate],
    });
    expect(approved.status).toBe("completed-with-omissions");
    expect(approved.result?.approvedOmittedReferenceKeys).toEqual([candidate]);
    expect(approved.result?.omittedReferenceKeys).toEqual([candidate]);
    expect(saved).toHaveLength(1);
  });

  it("exports DOCX through the service and records Chromium formula assets", async () => {
    const value = await fixture("# Word 文档\n\n公式：$x^2$\n");
    value.request = { ...value.request, target: "docx" };
    const saved: Array<{ bytes: Uint8Array; target: string }> = [];
    const formulaPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    const service = new OutputService(
      new AssetHandleRegistry(),
      { transformSvg: async () => ({ status: "failed", code: "UNEXPECTED_SVG_TRANSFORM", message: "unexpected SVG transform" } as const) },
      {
        generateOfflineHtml: async (context: OutputContext, assets) => generateOfflineHtml(context, assets),
        generateDocx: async (context: OutputContext, assets, formulaAssets) => generateDocx(context, assets, formulaAssets),
        generateWechatHtml: async (context: OutputContext, assets, formulaAssets) => generateWechatHtml(context, assets, formulaAssets),
        cancelJob: () => true,
      },
      async (_name, bytes, target) => {
        saved.push({ bytes, target });
        return { status: "saved" as const, artifact: { kind: "file" as const, displayName: "article.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", byteLength: bytes.byteLength } };
      },
      { renderFormula: async () => ({ status: "completed", png: formulaPng, width: 64, height: 24 }) },
    );
    remember(service, value);
    const result = await service.begin(value.request, value.context, () => true);
    expect(result.status).toBe("completed");
    expect(saved).toHaveLength(1);
    expect(saved[0]?.target).toBe("docx");
    expect([...saved[0]!.bytes.slice(0, 2)]).toEqual([0x50, 0x4b]);
    expect(result.result?.usedFormulaReferences).toHaveLength(1);
    expect(Object.values(result.result?.derivedAssetManifest.entries ?? {})).toEqual([
      expect.objectContaining({ transformProfile: "katex-chromium-png-0.1", mimeType: "image/png", width: 64, height: 24 }),
    ]);
  });

  it("fails before rendering when formula image count exceeds the output limit", async () => {
    const formulas = Array.from(
      { length: FANTASTIC_EDITOR_LIMITS.maxFormulaRendersPerOutput + 1 },
      (_, index) => `$x_${index}$`,
    ).join("\n\n");
    const value = await fixture(formulas);
    value.request = { ...value.request, target: "docx" };
    let renderCalls = 0;
    const service = new OutputService(
      new AssetHandleRegistry(),
      { transformSvg: async () => ({ status: "failed", code: "UNEXPECTED_SVG_TRANSFORM", message: "unexpected SVG transform" } as const) },
      {
        generateOfflineHtml: async (context: OutputContext, assets) => generateOfflineHtml(context, assets),
        generateDocx: async (context: OutputContext, assets, formulaAssets) => generateDocx(context, assets, formulaAssets),
        generateWechatHtml: async (context: OutputContext, assets, formulaAssets) => generateWechatHtml(context, assets, formulaAssets),
        cancelJob: () => true,
      },
      async () => ({ status: "failed" as const, error: "should not save" }),
      {
        renderFormula: async () => {
          renderCalls += 1;
          return { status: "failed", code: "UNEXPECTED_RENDER", message: "should not render" };
        },
      },
    );
    remember(service, value);
    const result = await service.begin(value.request, value.context, () => true);
    expect(result.status).toBe("failed");
    expect(renderCalls).toBe(0);
    expect(result.preflight?.diagnostics.some((item) => item.code === "FORMULA_RENDER_LIMIT_EXCEEDED")).toBe(true);
  });
  it("blocks DOCX before generation when a formula cannot be rendered", async () => {
    const value = await fixture("# Word 文档\n\n$$\n\\notacommand{\n$$\n");
    value.request = { ...value.request, target: "docx" };
    const saved: Uint8Array[] = [];
    const service = new OutputService(
      new AssetHandleRegistry(),
      { transformSvg: async () => ({ status: "failed", code: "UNEXPECTED_SVG_TRANSFORM", message: "unexpected SVG transform" } as const) },
      {
        generateOfflineHtml: async (context: OutputContext, assets) => generateOfflineHtml(context, assets),
        generateDocx: async (context: OutputContext, assets, formulaAssets) => generateDocx(context, assets, formulaAssets),
        generateWechatHtml: async (context: OutputContext, assets, formulaAssets) => generateWechatHtml(context, assets, formulaAssets),
        cancelJob: () => true,
      },
      async (_name, bytes) => {
        saved.push(bytes);
        return { status: "saved" as const, artifact: { kind: "file" as const, displayName: "article.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", byteLength: bytes.byteLength } };
      },
      { renderFormula: async () => ({ status: "failed", code: "FORMULA_RENDER_FAILED", message: "公式无法渲染。" }) },
    );
    remember(service, value);
    const result = await service.begin(value.request, value.context, () => true);
    expect(result.status).toBe("failed");
    expect(result.preflight?.nonOverridableDiagnosticIds).toHaveLength(1);
    expect(result.preflight?.diagnostics.some((item) => item.code === "FORMULA_RENDER_FAILED")).toBe(true);
    expect(saved).toHaveLength(0);
  });
  it("routes PDF through its isolated renderer and saves a PDF artifact", async () => {
    const value = await fixture("# PDF 文档\n\n正文。\n");
    value.request = { ...value.request, target: "pdf" };
    const saved: Array<{ bytes: Uint8Array; target: string }> = [];
    const service = new OutputService(
      new AssetHandleRegistry(),
      { transformSvg: async () => ({ status: "failed", code: "UNEXPECTED_SVG_TRANSFORM", message: "unexpected SVG transform" } as const) },
      {
        generateOfflineHtml: async (context: OutputContext, assets) => generateOfflineHtml(context, assets),
        generateDocx: async (context: OutputContext, assets, formulaAssets) => generateDocx(context, assets, formulaAssets),
        generateWechatHtml: async (context: OutputContext, assets, formulaAssets) => generateWechatHtml(context, assets, formulaAssets),
        cancelJob: () => true,
      },
      async (_name, bytes, target) => {
        saved.push({ bytes, target });
        return { status: "saved" as const, artifact: { kind: "file" as const, displayName: "article.pdf", mimeType: "application/pdf", byteLength: bytes.byteLength } };
      },
      undefined,
      {
        generatePdf: async () => ({ status: "completed", bytes: new TextEncoder().encode("%PDF-1.7\nfixture"), diagnostics: [], usedReferenceKeys: [], omittedReferenceKeys: [] }),
        cancelJob: () => true,
      },
    );
    remember(service, value);
    const result = await service.begin(value.request, value.context, () => true);
    expect(result.status).toBe("completed");
    expect(saved[0]?.target).toBe("pdf");
    expect(new TextDecoder().decode(saved[0]?.bytes)).toContain("%PDF-");
  });
  it("keeps WeChat replacement bytes in the main service behind opaque job and item ids", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fantastic-output-service-"));
    try {
      const value = await fixture("# 公众号\n\n![实验图片](image.png)\n");
      value.request = { ...value.request, target: "wechat-clipboard" };
      value.context.authorizationRootRealPath = directory;
      value.context.documentRealPath = join(directory, "article.md");
      const imagePath = join(directory, "image.png");
      const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
      await writeFile(imagePath, imageBytes);
      const contentHash = createHash("sha256").update(imageBytes).digest("hex");
      const handles = new AssetHandleRegistry();
      const referenceKey = value.request.parsedDocument.resourceReferences[0]!.referenceKey;
      const record = value.snapshot.records[referenceKey]!;
      Object.assign(record, {
        assetCacheKey: "a".repeat(64),
        workspaceRelativePath: "image.png",
        mimeType: "image/png",
        byteLength: imageBytes.byteLength,
        contentHash,
        width: 1,
        height: 1,
        state: "resolved",
        assetHandle: handles.create(value.context, imagePath, contentHash, "image/png"),
      });
      value.snapshot.diagnostics = [];
      const service = new OutputService(
        handles,
        { transformSvg: async () => ({ status: "failed", code: "UNEXPECTED_SVG_TRANSFORM", message: "unexpected SVG transform" } as const) },
        {
          generateOfflineHtml: async (context: OutputContext, assets) => generateOfflineHtml(context, assets),
          generateDocx: async (context: OutputContext, assets, formulaAssets) => generateDocx(context, assets, formulaAssets),
          generateWechatHtml: async (context: OutputContext, assets, formulaAssets) => generateWechatHtml(context, assets, formulaAssets),
          cancelJob: () => true,
        },
        async (_name, bytes) => ({ status: "saved" as const, artifact: { kind: "clipboard" as const, displayName: "公众号正文（方案 B）", mimeType: "text/html", byteLength: bytes.byteLength } }),
      );
      remember(service, value);
      const result = await service.begin(value.request, value.context, () => true);
      expect(result.status).toBe("completed");
      const item = result.result?.wechatReplacementItems?.[0];
      expect(item).toEqual(expect.objectContaining({ itemId: "wechat-item-01", kind: "image", label: "实验图片" }));
      expect(service.getWechatAcceptanceSummary(result.result!.jobId)).toEqual(expect.objectContaining({
        jobId: result.result!.jobId,
        documentId: result.result!.documentId,
        sourceHash: result.result!.sourceHash,
        status: "completed",
        replacementItems: [expect.objectContaining({ itemId: "wechat-item-01", placement: "block", placeholderText: "【FE图片01｜整段替换】" })],
        omittedReferenceKeys: [],
      }));
      expect(service.getWechatAcceptanceSummary("invalid/job")).toBeUndefined();
      expect([...(service.getWechatReplacement(result.result!.jobId, item!.itemId)?.bytes ?? [])]).toEqual([...imageBytes]);
      expect(service.getWechatReplacement(result.result!.jobId, "wechat-item-99")).toBeUndefined();
      service.clear();
      expect(service.getWechatReplacement(result.result!.jobId, item!.itemId)).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("does not save output after the parse identity becomes stale", async () => {
    const value = await fixture();
    const saved: Uint8Array[] = [];
    const current = { value: false };
    const service = createService(saved, current);
    remember(service, value);
    const result = await service.begin(value.request, value.context, () => current.value);
    expect(result.status).toBe("failed");
    expect(saved).toHaveLength(0);
  });
});
