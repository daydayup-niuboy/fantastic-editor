import { describe, expect, it } from "vitest";
import { parseDocument } from "@fantastic-editor/document-core";
import type { PreviewDerivedUpdate, ResolveResult } from "@fantastic-editor/shared";
import { applyPreviewDerivedUpdate, createPreviewSession } from "./preview-session.js";
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
});
