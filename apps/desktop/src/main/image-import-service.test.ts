import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseDocument } from "@fantastic-editor/document-core";
import type { OutputContext } from "@fantastic-editor/shared";
import { FileSessionManager } from "./file-sessions.js";
import { ImageImportService } from "./image-import-service.js";
import { ParseCommitRegistry } from "./parse-commit-registry.js";
import { SingleFileResourceResolver } from "./single-file-resource-resolver.js";
import { generateWechatHtml } from "./wechat-adapter.js";

const PNG_1X1 = new Uint8Array(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
  "base64",
));
const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = resolve(await mkdtemp(join(tmpdir(), "fantastic-editor-image-import-test-")));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("ImageImportService", () => {
  it("writes a validated image into assets and advances the workspace revision", async () => {
    const directory = await createTemporaryDirectory();
    const markdownPath = join(directory, "article.md");
    await writeFile(markdownPath, "# Article\n", "utf8");
    const sessions = new FileSessionManager();
    const opened = await sessions.openPath(markdownPath);
    if (opened.status !== "opened" || !opened.session) throw new Error("Expected opened session.");
    const service = new ImageImportService(sessions);
    const result = await service.importDroppedFiles({
      importRequestId: "image-import-1",
      sessionId: opened.session.sessionId,
      documentId: opened.session.documentId,
      workspaceRevision: opened.session.workspaceRevision,
    }, [{ displayName: "实验 结果.png", declaredMimeType: "image/png", bytes: PNG_1X1 }]);
    expect(result.status).toBe("imported");
    if (result.status !== "imported") throw new Error("Expected imported result.");
    expect(result.workspaceRevision).toBe(2);
    expect(result.receipts[0]).toMatchObject({
      relativeRef: expect.stringMatching(/^\.\/assets\/实验-结果-[a-f0-9]{8}\.png$/),
      mimeType: "image/png",
      byteLength: PNG_1X1.byteLength,
      reusedExisting: false,
    });
    const importedPath = join(directory, ...result.receipts[0]!.relativeRef.replace(/^\.\//, "").split("/"));
    expect(new Uint8Array(await readFile(importedPath))).toEqual(PNG_1X1);
    expect(sessions.getResolutionContext(opened.session.documentId)?.workspaceRevision).toBe(2);
  });

  it("resolves an imported reference for preview and includes it in the WeChat strategy-B list", async () => {
    const directory = await createTemporaryDirectory();
    const markdownPath = join(directory, "article.md");
    await writeFile(markdownPath, "# Article\n", "utf8");
    const sessions = new FileSessionManager();
    const opened = await sessions.openPath(markdownPath);
    if (opened.status !== "opened" || !opened.session) throw new Error("Expected opened session.");
    const imported = await new ImageImportService(sessions).importDroppedFiles({
      importRequestId: "image-import-integration",
      sessionId: opened.session.sessionId,
      documentId: opened.session.documentId,
      workspaceRevision: 1,
    }, [{ displayName: "公众号实验图.png", declaredMimeType: "image/png", bytes: PNG_1X1 }]);
    if (imported.status !== "imported") throw new Error("Expected imported image.");
    const editorText = `# Article\n\n![公众号实验图](${imported.receipts[0]!.relativeRef})\n`;
    const parsed = await parseDocument({ documentId: opened.session.documentId, editorText });
    const commits = new ParseCommitRegistry();
    const context = sessions.getResolutionContext(opened.session.documentId)!;
    const commit = commits.commit({
      documentId: parsed.documentId,
      sourceHash: parsed.sourceHash,
      parserProfile: parsed.parserProfile,
      taskSequence: 1,
    }, context);
    if (commit.status !== "committed" || !commit.parseCommitId || commit.workspaceRevision === undefined) throw new Error("Expected parse commit.");
    const resolved = await new SingleFileResourceResolver(commits).resolve({
      documentId: parsed.documentId,
      sourceHash: parsed.sourceHash,
      parserProfile: parsed.parserProfile,
      taskSequence: 1,
      parseCommitId: commit.parseCommitId,
      workspaceRevision: commit.workspaceRevision,
      resourceReferences: parsed.resourceReferences,
    }, context, () => sessions.getResolutionContext(parsed.documentId));
    expect(resolved.status).toBe("resolved");
    const snapshot = resolved.resolutionSnapshot!;
    const reference = parsed.resourceReferences[0]!;
    const record = snapshot.records[reference.referenceKey]!;
    expect(record).toMatchObject({ state: "resolved", mimeType: "image/png", contentHash: imported.receipts[0]!.contentHash });
    const outputContext: OutputContext = {
      jobId: "wechat-import-job",
      documentId: parsed.documentId,
      target: "wechat-clipboard",
      sourceHash: parsed.sourceHash,
      workspaceRevision: snapshot.workspaceRevision,
      preflightId: "wechat-import-preflight",
      parsedDocument: parsed,
      resolutionSnapshot: snapshot,
      derivedAssetManifest: { schema: "fantastic-editor-derived-asset-manifest", jobId: "wechat-import-job", sourceHash: parsed.sourceHash, workspaceRevision: snapshot.workspaceRevision, entries: {} },
      theme: { id: "wechat-green", tokens: {} },
      locale: "zh-CN",
      options: {},
      approvedOmittedReferenceKeys: [],
    };
    const wechat = generateWechatHtml(outputContext, [{
      referenceKey: reference.referenceKey,
      sourceContentHash: record.contentHash!,
      contentHash: record.contentHash!,
      mimeType: "image/png",
      ...(record.width ? { width: record.width } : {}),
      ...(record.height ? { height: record.height } : {}),
      bytes: PNG_1X1,
    }], []);
    expect(wechat.status).toBe("completed");
    expect(wechat.replacementItems).toEqual([
      expect.objectContaining({ sequence: 1, kind: "image", label: "公众号实验图", sourceKey: reference.referenceKey }),
    ]);
  });
  it("reuses an existing content-addressed target instead of overwriting it", async () => {
    const directory = await createTemporaryDirectory();
    const markdownPath = join(directory, "article.md");
    await writeFile(markdownPath, "# Article\n", "utf8");
    const sessions = new FileSessionManager();
    const opened = await sessions.openPath(markdownPath);
    if (opened.status !== "opened" || !opened.session) throw new Error("Expected opened session.");
    const service = new ImageImportService(sessions);
    const first = await service.importDroppedFiles({
      importRequestId: "image-import-1",
      sessionId: opened.session.sessionId,
      documentId: opened.session.documentId,
      workspaceRevision: 1,
    }, [{ displayName: "same.png", declaredMimeType: "image/png", bytes: PNG_1X1 }]);
    if (first.status !== "imported") throw new Error("Expected first import.");
    const second = await service.importDroppedFiles({
      importRequestId: "image-import-2",
      sessionId: opened.session.sessionId,
      documentId: opened.session.documentId,
      workspaceRevision: first.workspaceRevision,
    }, [{ displayName: "same.png", declaredMimeType: "image/png", bytes: PNG_1X1 }]);
    expect(second.status).toBe("imported");
    if (second.status !== "imported") throw new Error("Expected second import.");
    expect(second.receipts[0]).toMatchObject({ relativeRef: first.receipts[0]!.relativeRef, reusedExisting: true });
  });

  it("rejects spoofed or damaged images before creating assets", async () => {
    const directory = await createTemporaryDirectory();
    const markdownPath = join(directory, "article.md");
    await writeFile(markdownPath, "# Article\n", "utf8");
    const sessions = new FileSessionManager();
    const opened = await sessions.openPath(markdownPath);
    if (opened.status !== "opened" || !opened.session) throw new Error("Expected opened session.");
    const result = await new ImageImportService(sessions).importDroppedFiles({
      importRequestId: "image-import-invalid",
      sessionId: opened.session.sessionId,
      documentId: opened.session.documentId,
      workspaceRevision: 1,
    }, [{ displayName: "not-an-image.png", declaredMimeType: "image/png", bytes: new TextEncoder().encode("not png") }]);
    expect(result).toMatchObject({ status: "failed" });
    await expect(access(join(directory, "assets"))).rejects.toBeDefined();
    expect(sessions.getResolutionContext(opened.session.documentId)?.workspaceRevision).toBe(1);
  });

  it("updates a folder workspace revision and resource filename index", async () => {
    const directory = await createTemporaryDirectory();
    const markdownPath = join(directory, "article.md");
    await writeFile(markdownPath, "# Workspace\n", "utf8");
    const sessions = new FileSessionManager();
    const folder = await sessions.openFolder(directory);
    if (folder.status !== "opened" || !folder.workspace) throw new Error("Expected folder workspace.");
    const file = folder.workspace.files.find((item) => item.displayName === "article.md")!;
    const opened = await sessions.openWorkspaceFile({
      workspaceId: folder.workspace.workspaceId,
      workspaceRevision: folder.workspace.workspaceRevision,
      fileId: file.fileId,
    });
    if (opened.status !== "opened" || !opened.session) throw new Error("Expected workspace file.");
    const imported = await new ImageImportService(sessions).importDroppedFiles({
      importRequestId: "image-import-workspace",
      sessionId: opened.session.sessionId,
      documentId: opened.session.documentId,
      workspaceRevision: opened.session.workspaceRevision,
    }, [{ displayName: "indexed.png", declaredMimeType: "image/png", bytes: PNG_1X1 }]);
    if (imported.status !== "imported") throw new Error("Expected workspace import.");
    const context = sessions.getResolutionContext(opened.session.documentId)!;
    expect(context.workspaceRevision).toBe(imported.workspaceRevision);
    const importedName = imported.receipts[0]!.relativeRef.split("/").at(-1)!.toLocaleLowerCase("en-US");
    expect(context.resourceNameIndex?.[importedName]).toContain(imported.receipts[0]!.relativeRef.replace(/^\.\//, ""));
  });
  it("refuses imports into an untitled or stale document session", async () => {
    const sessions = new FileSessionManager();
    const untitled = await sessions.createUntitled();
    if (untitled.status !== "opened" || !untitled.session) throw new Error("Expected untitled session.");
    const result = await new ImageImportService(sessions).importDroppedFiles({
      importRequestId: "image-import-untitled",
      sessionId: untitled.session.sessionId,
      documentId: untitled.session.documentId,
      workspaceRevision: untitled.session.workspaceRevision,
    }, [{ displayName: "image.png", declaredMimeType: "image/png", bytes: PNG_1X1 }]);
    expect(result).toMatchObject({ status: "failed" });
  });
});





