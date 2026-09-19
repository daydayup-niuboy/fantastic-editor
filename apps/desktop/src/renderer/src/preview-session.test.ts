import { describe, expect, it } from "vitest";
import { parseDocument, type Diagnostic } from "@fantastic-editor/document-core";
import type { PreviewDerivedUpdate, ResolveResult } from "@fantastic-editor/shared";
import { applyPreviewDerivedUpdate, createPreviewSession, formatDiagnosticItems, formatDiagnostics } from "./preview-session.js";
import type { ParseWorkerSuccess } from "./workers/parse-worker-protocol";

const SOURCE_HASH = "unused";
const SOURCE_CONTENT_HASH = "b".repeat(64);
const SOURCE_HANDLE = "00000000-0000-4000-8000-000000000001";
const PREVIEW_HANDLE = "00000000-0000-4000-8000-000000000002";

async function fixture(): Promise<{ parse: ParseWorkerSuccess; resolved: ResolveResult; referenceKey: string }> {
  const parsedDocument = await parseDocument({ documentId: "document-1", editorText: "![svg](image.svg)" });
  const reference = parsedDocument.resourceReferences[0]!;
  const parse: ParseWorkerSuccess = {
    type: "parsed",
    parseDurationMs: 1,
    documentId: parsedDocument.documentId,
    sourceHash: parsedDocument.sourceHash,
    parserProfile: parsedDocument.parserProfile,
    taskSequence: 7,
    parsedDocument,
    diagnostics: parsedDocument.diagnostics,
    previewHtml: "<p>preview</p>",
  };
  const resolved: ResolveResult = {
    status: "resolved",
    documentId: parse.documentId,
    sourceHash: parse.sourceHash,
    parserProfile: parse.parserProfile,
    taskSequence: parse.taskSequence,
    parseCommitId: "commit-1",
    workspaceRevision: 3,
    resolutionSnapshot: {
      schema: "fantastic-editor-resolution-snapshot",
      documentId: parse.documentId,
      sourceHash: parse.sourceHash,
      workspaceId: "workspace-1",
      workspaceRevision: 3,
      resolverProfile: "test",
      records: {
        [reference.referenceKey]: {
          referenceKey: reference.referenceKey,
          workspaceRevision: 3,
          assetCacheKey: "a".repeat(64),
          fileFingerprint: null,
          originalRef: "image.svg",
          resolvedRef: "image.svg",
          workspaceRelativePath: "image.svg",
          mimeType: "image/svg+xml",
          byteLength: 20,
          contentHash: SOURCE_CONTENT_HASH,
          width: null,
          height: null,
          state: "resolved",
          candidates: [],
          assetHandle: SOURCE_HANDLE,
          securityFlags: [],
        },
      },
      diagnostics: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    previewDerivedManifest: {
      schema: "fantastic-editor-preview-derived-manifest",
      documentId: parse.documentId,
      sourceHash: parse.sourceHash,
      parserProfile: parse.parserProfile,
      taskSequence: parse.taskSequence,
      parseCommitId: "commit-1",
      workspaceRevision: 3,
      manifestRevision: 0,
      entries: {},
    },
    diagnostics: [],
  };
  return { parse, resolved, referenceKey: reference.referenceKey };
}

describe("PreviewSession", () => {
  it("formats resource reasons and suggested actions for users", () => {
    const diagnostics = [{
      id: "diagnostic-1",
      code: "RESOURCE_MISSING",
      severity: "blocking",
      category: "resource",
      message: "找不到图片文件。",
      source: { from: 10, to: 30, startLine: 3, startColumn: 1, endLine: 3, endColumn: 21, precision: "exact" },
      details: { resourceReference: "assets/缺失图片.png" },
      suggestedActions: ["请检查路径。"],
    }, {
      id: "diagnostic-2",
      code: "RESOURCE_MISSING",
      severity: "blocking",
      category: "resource",
      message: "找不到图片文件。",
      source: { from: 40, to: 60, startLine: 8, startColumn: 1, endLine: 8, endColumn: 21, precision: "exact" },
      details: { resourceReference: "assets/缺失图片.png" },
      suggestedActions: ["请检查路径。"],
    }] satisfies Diagnostic[];
    expect(formatDiagnostics(diagnostics)).toEqual(["第 3、8 行，共 2 处 · 图片：assets/缺失图片.png · 找不到图片文件。 建议：请检查路径。（错误代码：RESOURCE_MISSING）"]);
    expect(formatDiagnosticItems(diagnostics)[0]).toMatchObject({ severity: "blocking", source: { startLine: 3 } });
  });

  it("collapses blocked raw HTML images into one compatibility notice", () => {
    const diagnostics = [3, 7].map((line, index) => ({
      id: `raw-${index}`,
      code: "RAW_HTML_IMAGE_BLOCKED",
      severity: "blocking",
      category: "security",
      message: "P0 不支持原始 HTML 图片，请改用 Markdown 图片语法。",
      source: { from: index * 10, to: index * 10 + 5, startLine: line, startColumn: 1, endLine: line, endColumn: 6, precision: "exact" },
    })) satisfies Diagnostic[];
    expect(formatDiagnosticItems(diagnostics)).toEqual([expect.objectContaining({
      severity: "warning",
      text: "第 3、7 行，共 2 处 · 已安全忽略 2 个原始 HTML 内嵌图片。为避免 SVG 脚本或外部资源执行，请改用本地图片、Markdown 图片语法或受支持的 svg 围栏。",
    })]);
  });

  it("combines only fully matching parse, resolution and manifest identities", async () => {
    const value = await fixture();
    const accepted = createPreviewSession(value.parse, value.resolved);
    expect(accepted.status).toBe("accepted");
    expect(createPreviewSession(value.parse, { ...value.resolved, sourceHash: SOURCE_HASH }).status).toBe("rejected");
    expect(createPreviewSession(value.parse, {
      ...value.resolved,
      previewDerivedManifest: { ...value.resolved.previewDerivedManifest!, workspaceRevision: 4 },
    }).status).toBe("rejected");
  });

  it("accepts only strictly newer, matching and source-bound derived updates", async () => {
    const value = await fixture();
    const initial = createPreviewSession(value.parse, value.resolved);
    if (initial.status !== "accepted") throw new Error(initial.error);
    const update: PreviewDerivedUpdate = {
      documentId: value.parse.documentId,
      sourceHash: value.parse.sourceHash,
      parserProfile: value.parse.parserProfile,
      taskSequence: value.parse.taskSequence,
      parseCommitId: "commit-1",
      workspaceRevision: 3,
      manifestRevision: 1,
      entries: {
        [value.referenceKey]: {
          referenceKey: value.referenceKey,
          sourceContentHash: SOURCE_CONTENT_HASH,
          transformProfile: "svg-safe-png-0.1",
          previewAssetHandle: PREVIEW_HANDLE,
          mimeType: "image/png",
          width: 120,
          height: 80,
        },
      },
      diagnostics: [],
    };
    const accepted = applyPreviewDerivedUpdate(initial.session, update);
    expect(accepted.status).toBe("accepted");
    if (accepted.status !== "accepted") throw new Error(accepted.error);
    expect(accepted.session.previewDerivedManifest.entries[value.referenceKey]?.previewAssetHandle).toBe(PREVIEW_HANDLE);
    expect(applyPreviewDerivedUpdate(accepted.session, update).status).toBe("rejected");
    expect(applyPreviewDerivedUpdate(initial.session, {
      ...update,
      entries: {
        [value.referenceKey]: { ...update.entries[value.referenceKey]!, sourceContentHash: "c".repeat(64) },
      },
    }).status).toBe("rejected");
  });

  it("accepts a derived PNG bound to parsed fenced SVG content", async () => {
    const parsedDocument = await parseDocument({ documentId: "document-svg-content", editorText: "```svg\n<svg width=\"10\" height=\"10\"/>\n```\n" });
    const reference = parsedDocument.svgContents![0]!;
    const parse: ParseWorkerSuccess = {
      type: "parsed",
      parseDurationMs: 1,
      documentId: parsedDocument.documentId,
      sourceHash: parsedDocument.sourceHash,
      parserProfile: parsedDocument.parserProfile,
      taskSequence: 8,
      parsedDocument,
      diagnostics: [],
      previewHtml: "<span>svg</span>",
    };
    const resolved: ResolveResult = {
      status: "resolved",
      documentId: parse.documentId,
      sourceHash: parse.sourceHash,
      parserProfile: parse.parserProfile,
      taskSequence: parse.taskSequence,
      parseCommitId: "commit-svg",
      workspaceRevision: 1,
      resolutionSnapshot: { schema: "fantastic-editor-resolution-snapshot", documentId: parse.documentId, sourceHash: parse.sourceHash, workspaceId: "workspace-1", workspaceRevision: 1, resolverProfile: "test", records: {}, diagnostics: [], createdAt: "2026-01-01T00:00:00.000Z" },
      previewDerivedManifest: { schema: "fantastic-editor-preview-derived-manifest", documentId: parse.documentId, sourceHash: parse.sourceHash, parserProfile: parse.parserProfile, taskSequence: parse.taskSequence, parseCommitId: "commit-svg", workspaceRevision: 1, manifestRevision: 0, entries: {} },
      diagnostics: [],
    };
    const initial = createPreviewSession(parse, resolved);
    if (initial.status !== "accepted") throw new Error(initial.error);
    const update: PreviewDerivedUpdate = {
      documentId: parse.documentId,
      sourceHash: parse.sourceHash,
      parserProfile: parse.parserProfile,
      taskSequence: parse.taskSequence,
      parseCommitId: "commit-svg",
      workspaceRevision: 1,
      manifestRevision: 1,
      entries: { [reference.referenceKey]: { referenceKey: reference.referenceKey, sourceContentHash: reference.sourceContentHash, transformProfile: "svg-safe-png-0.1", previewAssetHandle: PREVIEW_HANDLE, mimeType: "image/png", width: 10, height: 10 } },
      diagnostics: [],
    };
    expect(applyPreviewDerivedUpdate(initial.session, update).status).toBe("accepted");
    update.entries[reference.referenceKey] = { ...update.entries[reference.referenceKey]!, sourceContentHash: "f".repeat(64) };
    expect(applyPreviewDerivedUpdate(initial.session, update).status).toBe("rejected");
  });
});
