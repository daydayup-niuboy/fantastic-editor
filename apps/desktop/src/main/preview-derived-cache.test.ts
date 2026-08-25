import { describe, expect, it } from "vitest";
import type { SingleFileResolutionContext } from "./file-sessions.js";
import { PreviewDerivedAssetCache } from "./preview-derived-cache.js";

const context: SingleFileResolutionContext = {
  sessionId: "session-1",
  documentId: "document-1",
  workspaceId: "workspace-1",
  workspaceRevision: 2,
  workspaceMode: "single-file",
  grantId: "grant-1",
  documentRealPath: "C:\\workspace\\article.md",
  authorizationRootRealPath: "C:\\workspace",
};
const referenceKey = "a".repeat(64);
const sourceContentHash = "b".repeat(64);
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

describe("PreviewDerivedAssetCache", () => {
  it("creates a separate short-lived preview handle bound to current authorization", () => {
    const cache = new PreviewDerivedAssetCache();
    const entry = cache.put(context, referenceKey, sourceContentHash, "svg-safe-png-0.1", "resvg-js-2", png, 10, 10);
    expect(entry).toMatchObject({ referenceKey, sourceContentHash, mimeType: "image/png", width: 10, height: 10 });
    expect(entry.previewAssetHandle).toMatch(/^[a-f\d-]{36}$/i);
    const current = cache.read(entry.previewAssetHandle, context);
    expect(current.status).toBe("ok");
    expect(cache.read(entry.previewAssetHandle, { ...context, workspaceRevision: 3 })).toEqual({ status: "stale" });
  });

  it("does not expose mutable cache storage through returned bytes", () => {
    const cache = new PreviewDerivedAssetCache();
    const entry = cache.put(context, referenceKey, sourceContentHash, "svg-safe-png-0.1", "resvg-js-2", png, 10, 10);
    const first = cache.read(entry.previewAssetHandle, context);
    if (first.status !== "ok") throw new Error(first.status);
    first.bytes[0] = 0;
    const second = cache.read(entry.previewAssetHandle, context);
    if (second.status !== "ok") throw new Error(second.status);
    expect(second.bytes[0]).toBe(137);
  });

  it("revokes both derived handles and cached bytes", () => {
    const cache = new PreviewDerivedAssetCache();
    const entry = cache.put(context, referenceKey, sourceContentHash, "svg-safe-png-0.1", "resvg-js-2", png, 10, 10);
    cache.revokeAll();
    expect(cache.read(entry.previewAssetHandle, context)).toEqual({ status: "not-found" });
  });
});