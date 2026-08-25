import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileSessionManager } from "./file-sessions.js";

async function workspaceFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fantastic-folder-workspace-"));
  await mkdir(join(root, "notes", "nested"), { recursive: true });
  await writeFile(join(root, "root.md"), "# Root\n", "utf8");
  await writeFile(join(root, "notes", "second.markdown"), "# Second\r\n", "utf8");
  await writeFile(join(root, "notes", "nested", "third.md"), "# Third\n", "utf8");
  await writeFile(join(root, "notes", "ignore.txt"), "not markdown", "utf8");
  return root;
}

describe("FileSessionManager folder workspace", () => {
  it("recursively lists only Markdown files and switches with a fresh documentId", async () => {
    const root = await workspaceFixture();
    const manager = new FileSessionManager();
    const opened = await manager.openFolder(root);
    expect(opened.status).toBe("opened");
    expect(opened.workspace?.files.map((item) => item.relativePath)).toEqual([
      "notes/nested/third.md",
      "notes/second.markdown",
      "root.md",
    ]);
    const firstFile = opened.workspace?.files[0];
    const secondFile = opened.workspace?.files[1];
    if (!opened.workspace || !firstFile || !secondFile) throw new Error("missing workspace files");
    const first = await manager.openWorkspaceFile({
      workspaceId: opened.workspace.workspaceId,
      workspaceRevision: opened.workspace.workspaceRevision,
      fileId: firstFile.fileId,
    });
    const second = await manager.openWorkspaceFile({
      workspaceId: opened.workspace.workspaceId,
      workspaceRevision: opened.workspace.workspaceRevision,
      fileId: secondFile.fileId,
    });
    expect(first.status).toBe("opened");
    expect(second.status).toBe("opened");
    expect(first.session?.workspaceMode).toBe("folder-workspace");
    expect(first.session?.documentId).not.toBe(second.session?.documentId);
    expect(manager.getResolutionContext(second.session!.documentId)?.authorizationRootRealPath).toBe(await realpath(root));
  });

  it("rejects stale workspace identity and unknown file IDs", async () => {
    const root = await workspaceFixture();
    const manager = new FileSessionManager();
    const opened = await manager.openFolder(root);
    if (!opened.workspace) throw new Error("missing workspace");
    const fileId = opened.workspace.files[0]!.fileId;
    expect((await manager.openWorkspaceFile({ workspaceId: "wrong", workspaceRevision: 1, fileId })).status).toBe("failed");
    expect((await manager.openWorkspaceFile({ workspaceId: opened.workspace.workspaceId, workspaceRevision: 2, fileId })).status).toBe("failed");
    expect((await manager.openWorkspaceFile({ workspaceId: opened.workspace.workspaceId, workspaceRevision: 1, fileId: "unknown" })).status).toBe("failed");
  });

  it("does not follow a directory symlink while scanning", async () => {
    const root = await workspaceFixture();
    const outside = await mkdtemp(join(tmpdir(), "fantastic-folder-outside-"));
    await writeFile(join(outside, "secret.md"), "# Secret\n", "utf8");
    try {
      await symlink(outside, join(root, "linked"), "junction");
    } catch {
      return;
    }
    const manager = new FileSessionManager();
    const opened = await manager.openFolder(root);
    expect(opened.workspace?.files.some((item) => item.relativePath.includes("secret.md"))).toBe(false);
  });

  it("keeps folder file encoding and line endings when saving", async () => {
    const root = await workspaceFixture();
    const manager = new FileSessionManager();
    const opened = await manager.openFolder(root);
    const file = opened.workspace?.files.find((item) => item.relativePath.endsWith("second.markdown"));
    if (!opened.workspace || !file) throw new Error("missing workspace file");
    const selected = await manager.openWorkspaceFile({
      workspaceId: opened.workspace.workspaceId,
      workspaceRevision: opened.workspace.workspaceRevision,
      fileId: file.fileId,
    });
    const saved = await manager.save({ sessionId: selected.session!.sessionId, editorText: "# Changed\n" });
    expect(saved.status).toBe("saved");
    expect(await readFile(join(root, "notes", "second.markdown"), "utf8")).toBe("# Changed\r\n");
  });
});