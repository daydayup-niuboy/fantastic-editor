import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseDocument } from "@fantastic-editor/document-core";
import type { PreviewDerivedUpdate, ResolveRequest, ResolveResult } from "@fantastic-editor/shared";
import { FileSessionManager, type SingleFileResolutionContext } from "./file-sessions.js";
import { ParseCommitRegistry } from "./parse-commit-registry.js";
import { PreviewDerivedAssetCache } from "./preview-derived-cache.js";
import { AssetHandleRegistry, SingleFileResourceResolver } from "./single-file-resource-resolver.js";
import type { SvgTransformResult } from "./svg-transform.js";
import { SvgPreviewCoordinator } from "./svg-preview-coordinator.js";

const temporaryDirectories: string[] = [];
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);

async function environment(): Promise<{
  handles: AssetHandleRegistry;
  cache: PreviewDerivedAssetCache;
  context: SingleFileResolutionContext;
  request: ResolveRequest;
  result: ResolveResult;
}> {
  const root = resolve(await mkdtemp(join(tmpdir(), "fantastic-editor-svg-preview-")));
  if (!root.startsWith(resolve(tmpdir()))) throw new Error("Unsafe temporary test path.");
  temporaryDirectories.push(root);
  const articlePath = join(root, "article.md");
  await writeFile(articlePath, "![svg](image.svg)\n", "utf8");
  await writeFile(join(root, "image.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>', "utf8");
  const sessions = new FileSessionManager();
  const opened = await sessions.openPath(articlePath);
  if (opened.status !== "opened" || !opened.session) throw new Error(opened.error ?? "open failed");
  const parsed = await parseDocument({ documentId: opened.session.documentId, editorText: opened.session.editorText });
  const context = sessions.getResolutionContext(opened.session.documentId)!;
  const commits = new ParseCommitRegistry();
  const commit = commits.commit({
    documentId: parsed.documentId,
    sourceHash: parsed.sourceHash,
    parserProfile: parsed.parserProfile,
    taskSequence: 1,
  }, context);
  if (commit.status !== "committed" || !commit.parseCommitId || commit.workspaceRevision === undefined) throw new Error("commit failed");
  const request: ResolveRequest = {
    documentId: parsed.documentId,
    sourceHash: parsed.sourceHash,
    parserProfile: parsed.parserProfile,
    taskSequence: 1,
    parseCommitId: commit.parseCommitId,
    workspaceRevision: commit.workspaceRevision,
    resourceReferences: parsed.resourceReferences,
  };
  const handles = new AssetHandleRegistry();
  const resolver = new SingleFileResourceResolver(commits, handles);
  const result = await resolver.resolve(request, context);
  return { handles, cache: new PreviewDerivedAssetCache(), context, request, result };
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("SvgPreviewCoordinator", () => {
  it("emits a source-bound derived update and reuses the derived cache", async () => {
    const value = await environment();
    let calls = 0;
    const transformer = {
      transformSvg: async (): Promise<SvgTransformResult> => {
        calls += 1;
        return { status: "completed", png, width: 10, height: 10 };
      },
    };
    const coordinator = new SvgPreviewCoordinator(value.handles, value.cache, transformer);
    const updates: PreviewDerivedUpdate[] = [];
    await coordinator.schedule(value.request, value.result, value.context, () => true, (update) => updates.push(update));
    await coordinator.schedule(value.request, value.result, value.context, () => true, (update) => updates.push(update));
    expect(calls).toBe(1);
    expect(updates).toHaveLength(2);
    const entry = Object.values(updates[0]!.entries)[0]!;
    expect(entry).toMatchObject({ mimeType: "image/png", width: 10, height: 10 });
    expect(value.cache.read(entry.previewAssetHandle, value.context).status).toBe("ok");
  });

  it("turns transform failures into source-linked diagnostics", async () => {
    const value = await environment();
    const coordinator = new SvgPreviewCoordinator(value.handles, value.cache, {
      transformSvg: async () => ({ status: "failed", code: "SVG_ACTIVE_CONTENT_BLOCKED", message: "SVG 包含活动内容。" }),
    });
    const updates: PreviewDerivedUpdate[] = [];
    await coordinator.schedule(value.request, value.result, value.context, () => true, (update) => updates.push(update));
    expect(updates[0]?.diagnostics[0]).toMatchObject({
      code: "SVG_ACTIVE_CONTENT_BLOCKED",
      category: "security",
      referenceKey: value.request.resourceReferences[0]?.referenceKey,
    });
    expect(updates[0]?.entries).toEqual({});
  });

  it("revokes and drops a transform result when the parse identity becomes stale", async () => {
    const value = await environment();
    let release: ((result: SvgTransformResult) => void) | undefined;
    let started: (() => void) | undefined;
    const startedPromise = new Promise<void>((resolveStarted) => { started = resolveStarted; });
    const coordinator = new SvgPreviewCoordinator(value.handles, value.cache, {
      transformSvg: () => new Promise<SvgTransformResult>((resolveTransform) => {
        release = resolveTransform;
        started?.();
      }),
    });
    let current = true;
    const updates: PreviewDerivedUpdate[] = [];
    const pending = coordinator.schedule(value.request, value.result, value.context, () => current, (update) => updates.push(update));
    await startedPromise;
    current = false;
    release?.({ status: "completed", png, width: 10, height: 10 });
    await pending;
    expect(updates).toEqual([]);
  });
});