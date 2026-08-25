import { access, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FANTASTIC_EDITOR_LIMITS } from "@fantastic-editor/shared";
import { FileSessionManager } from "./file-sessions.js";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = resolve(await mkdtemp(join(tmpdir(), "fantastic-editor-test-")));
  if (!directory.startsWith(resolve(tmpdir()))) throw new Error("Unsafe temporary test path.");
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("FileSessionManager", () => {
  it("round-trips UTF-8 BOM and CRLF while exposing canonical LF text", async () => {
    const directory = await createTemporaryDirectory();
    const path = join(directory, "article.md");
    await writeFile(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# 标题\r\n\r\n正文\r\n")]));
    const manager = new FileSessionManager();
    const opened = await manager.openPath(path);
    expect(opened.status).toBe("opened");
    expect(opened.session).toMatchObject({ encoding: "utf-8-bom", lineSeparator: "crlf", editorText: "# 标题\n\n正文\n" });
    const saved = await manager.save({ sessionId: opened.session!.sessionId, editorText: "# 新标题\n\n新正文\n" });
    expect(saved.status).toBe("saved");
    const bytes = await readFile(path);
    expect(Array.from(bytes.subarray(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.subarray(3).toString("utf8")).toBe("# 新标题\r\n\r\n新正文\r\n");
  });

  it("refuses to overwrite an externally changed file", async () => {
    const directory = await createTemporaryDirectory();
    const path = join(directory, "article.md");
    await writeFile(path, "original\n", "utf8");
    const manager = new FileSessionManager();
    const opened = await manager.openPath(path);
    expect(opened.status).toBe("opened");
    await writeFile(path, "changed by another program with a different length\n", "utf8");
    const saved = await manager.save({ sessionId: opened.session!.sessionId, editorText: "my edit\n" });
    expect(saved.status).toBe("conflict");
    expect(await readFile(path, "utf8")).toContain("another program");
  });

  it("keeps multiple single-file sessions and switches the active authorization context", async () => {
    const directory = await createTemporaryDirectory();
    const firstPath = join(directory, "first.md");
    const secondPath = join(directory, "second.md");
    await writeFile(firstPath, "# First\n", "utf8");
    await writeFile(secondPath, "# Second\n", "utf8");
    const manager = new FileSessionManager();
    const first = await manager.openPath(firstPath);
    const second = await manager.openPath(secondPath);
    expect(first.session?.sessionId).not.toBe(second.session?.sessionId);
    expect(manager.getResolutionContext(first.session!.documentId)).toBeDefined();
    expect(manager.getResolutionContext(second.session!.documentId)).toBeDefined();
    expect(manager.getActiveResolutionContext()?.documentId).toBe(second.session!.documentId);
    expect(manager.activateSession(first.session!.sessionId)).toEqual({ status: "activated" });
    expect(manager.getActiveResolutionContext()?.documentId).toBe(first.session!.documentId);
    expect(await manager.closeSession(first.session!.sessionId)).toEqual({ status: "closed" });
    expect(manager.getResolutionContext(first.session!.documentId)).toBeUndefined();
    expect(manager.getActiveResolutionContext()?.documentId).toBe(second.session!.documentId);
  });

  it("creates an untitled session, requires Save As, and removes its isolated temporary root", async () => {
    const directory = await createTemporaryDirectory();
    const manager = new FileSessionManager();
    const untitled = await manager.createUntitled();
    expect(untitled.status).toBe("opened");
    expect(untitled.session).toMatchObject({ displayName: "未命名", isUntitled: true, editorText: "# 未命名文档\n\n" });
    expect((await manager.save({ sessionId: untitled.session!.sessionId, editorText: "# 草稿\n" })).status).toBe("failed");
    const temporaryRoot = manager.getResolutionContext(untitled.session!.documentId)!.authorizationRootRealPath;
    const target = join(directory, "created.md");
    const saved = await manager.save({ sessionId: untitled.session!.sessionId, editorText: "# 已保存\n" }, target);
    expect(saved).toMatchObject({ status: "saved", displayName: "created.md" });
    expect(await readFile(target, "utf8")).toBe("# 已保存\n");
    await expect(access(temporaryRoot)).rejects.toBeDefined();
    expect(await manager.closeSession(untitled.session!.sessionId)).toEqual({ status: "closed" });
  });
  it("requires a line-ending choice and marks normalized mixed files dirty", async () => {
    const directory = await createTemporaryDirectory();
    const path = join(directory, "mixed.md");
    await writeFile(path, "a\r\nb\n", "utf8");
    const manager = new FileSessionManager();
    const inspected = await manager.openPath(path, {});
    expect(inspected.status).toBe("confirmation-required");
    if (inspected.status !== "confirmation-required") throw new Error("Expected confirmation.");
    expect(inspected.confirmation).toMatchObject({ hasMixedLineSeparators: true, crlfCount: 1, lfCount: 1, bareCrCount: 0 });
    const opened = await manager.openPath(path, {
      mixedLineSeparator: "crlf",
      expectedFingerprint: inspected.confirmation.fingerprint,
    });
    expect(opened.status).toBe("opened");
    if (opened.status !== "opened") throw new Error("Expected opened session.");
    expect(opened.session).toMatchObject({ editorText: "a\nb\n", lineSeparator: "crlf", requiresSave: true });
    expect((await manager.save({ sessionId: opened.session!.sessionId, editorText: opened.session!.editorText })).status).toBe("saved");
    expect(await readFile(path, "utf8")).toBe("a\r\nb\r\n");
  });

  it("requires explicit GB18030 conversion and saves confirmed text as UTF-8", async () => {
    const directory = await createTemporaryDirectory();
    const path = join(directory, "gbk.md");
    await writeFile(path, Buffer.from([0x23, 0x20, 0xb1, 0xea, 0xcc, 0xe2, 0x0a, 0x0a, 0xd5, 0xfd, 0xce, 0xc4, 0x0a]));
    const manager = new FileSessionManager();
    const inspected = await manager.openPath(path, {});
    expect(inspected.status).toBe("confirmation-required");
    if (inspected.status !== "confirmation-required") throw new Error("Expected confirmation.");
    expect(inspected.confirmation).toMatchObject({ requiresEncodingConversion: true, detectedEncoding: "gb18030" });
    expect(inspected.confirmation.preview).toContain("# 标题");
    const opened = await manager.openPath(path, {
      allowEncodingConversion: true,
      expectedFingerprint: inspected.confirmation.fingerprint,
    });
    expect(opened.status).toBe("opened");
    if (opened.status !== "opened") throw new Error("Expected opened session.");
    expect(opened.session).toMatchObject({ editorText: "# 标题\n\n正文\n", encoding: "utf-8", requiresSave: true });
    expect((await manager.save({ sessionId: opened.session!.sessionId, editorText: opened.session!.editorText })).status).toBe("saved");
    expect(await readFile(path, "utf8")).toBe("# 标题\n\n正文\n");
  });

  it("rejects a stale conversion preview when the file changes during confirmation", async () => {
    const directory = await createTemporaryDirectory();
    const path = join(directory, "changing.md");
    await writeFile(path, "a\r\nb\n", "utf8");
    const manager = new FileSessionManager();
    const inspected = await manager.openPath(path, {});
    if (inspected.status !== "confirmation-required") throw new Error("Expected confirmation.");
    await writeFile(path, "changed while the dialog was open\n", "utf8");
    const opened = await manager.openPath(path, {
      mixedLineSeparator: "lf",
      expectedFingerprint: inspected.confirmation.fingerprint,
    });
    expect(opened.status).toBe("failed");
    expect(opened.error).toContain("确认期间发生变化");
  });

  it("keeps the current workspace session intact when conversion is not confirmed", async () => {
    const directory = await createTemporaryDirectory();
    const currentPath = join(directory, "current.md");
    const mixedPath = join(directory, "mixed-cancel.md");
    await writeFile(currentPath, "# Current\n", "utf8");
    await writeFile(mixedPath, "a\r\nb\n", "utf8");
    const manager = new FileSessionManager();
    const folder = await manager.openFolder(directory);
    if (folder.status !== "opened" || !folder.workspace) throw new Error("Expected folder workspace.");
    const currentFile = folder.workspace.files.find((file) => file.displayName === "current.md")!;
    const current = await manager.openWorkspaceFile({
      workspaceId: folder.workspace.workspaceId,
      workspaceRevision: folder.workspace.workspaceRevision,
      fileId: currentFile.fileId,
    });
    if (current.status !== "opened" || !current.session) throw new Error("Expected current file.");
    const inspected = await manager.openPath(mixedPath, {});
    expect(inspected.status).toBe("confirmation-required");
    expect(manager.getActiveResolutionContext()?.documentId).toBe(current.session.documentId);
    expect(manager.getResolutionContext(current.session.documentId)).toBeDefined();
  });
  it("rejects oversized Markdown before reading it into memory", async () => {
    const directory = await createTemporaryDirectory();
    const path = join(directory, "oversized.md");
    await writeFile(path, "", "utf8");
    await truncate(path, FANTASTIC_EDITOR_LIMITS.maxMarkdownFileBytes + 1);
    const opened = await new FileSessionManager().openPath(path);
    expect(opened.status).toBe("failed");
    expect(opened.error).toContain("40 MiB");
  });

  it("refuses to save an editor buffer beyond the shared character limit", async () => {
    const directory = await createTemporaryDirectory();
    const path = join(directory, "save-limit.md");
    await writeFile(path, "original\n", "utf8");
    const manager = new FileSessionManager();
    const opened = await manager.openPath(path);
    if (opened.status !== "opened" || !opened.session) throw new Error("Expected opened session.");
    const saved = await manager.save({
      sessionId: opened.session.sessionId,
      editorText: "x".repeat(FANTASTIC_EDITOR_LIMITS.maxSourceCharacters + 1),
    });
    expect(saved.status).toBe("failed");
    expect(await readFile(path, "utf8")).toBe("original\n");
  });
  it("restores drafts while preserving external-change conflict detection", async () => {
    const directory = await createTemporaryDirectory();
    const path = join(directory, "recover.md");
    await writeFile(path, "disk before crash\n", "utf8");
    const original = new FileSessionManager();
    const opened = await original.openPath(path);
    const recovery = original.createRecoverySnapshot({
      activeSessionId: opened.session!.sessionId,
      tabs: [{ sessionId: opened.session!.sessionId, editorText: "unsaved draft\n" }],
    });
    await writeFile(path, "externally changed with a different length\n", "utf8");

    const restoredManager = new FileSessionManager();
    const restored = await restoredManager.restoreRecoverySnapshot(recovery);
    expect(restored.status).toBe("restored");
    if (restored.status !== "restored") throw new Error("Expected restored session.");
    expect(restored.documents[0]?.session).toMatchObject({
      editorText: "unsaved draft\n",
      savedText: "externally changed with a different length\n",
      recovered: true,
    });
    const save = await restoredManager.save({
      sessionId: restored.documents[0]!.session!.sessionId,
      editorText: "unsaved draft\n",
    });
    expect(save.status).toBe("conflict");
  });

  it("restores untitled drafts and makes missing files recoverable", async () => {
    const directory = await createTemporaryDirectory();
    const missingPath = join(directory, "missing.md");
    await writeFile(missingPath, "original\n", "utf8");
    const original = new FileSessionManager();
    const saved = await original.openPath(missingPath);
    const untitled = await original.createUntitled();
    const recovery = original.createRecoverySnapshot({
      activeSessionId: untitled.session!.sessionId,
      tabs: [
        { sessionId: saved.session!.sessionId, editorText: "saved-file draft\n" },
        { sessionId: untitled.session!.sessionId, editorText: "untitled draft\n" },
      ],
    });
    await rm(missingPath);

    const restoredManager = new FileSessionManager();
    const restored = await restoredManager.restoreRecoverySnapshot(recovery);
    expect(restored.status).toBe("restored");
    if (restored.status !== "restored") throw new Error("Expected restored session.");
    expect(restored.documents).toHaveLength(2);
    expect(restored.documents[0]?.session).toMatchObject({ displayName: "恢复 · missing.md", editorText: "saved-file draft\n", isUntitled: true });
    expect(restored.documents[1]?.session).toMatchObject({ displayName: "未命名（已恢复）", editorText: "untitled draft\n", isUntitled: true });
    expect(restored.warnings).toHaveLength(1);
  });});




