import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseDocument } from "@fantastic-editor/document-core";
import type { ResolveRequest } from "@fantastic-editor/shared";
import { FileSessionManager } from "./file-sessions.js";
import { ParseCommitRegistry } from "./parse-commit-registry.js";
import { AssetHandleRegistry, SingleFileResourceResolver } from "./single-file-resource-resolver.js";

const temporaryDirectories: string[] = [];

function validPng(width = 1, height = 1): Buffer {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 0, 0, 0, 0, 0]);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

async function setup(markdown: string): Promise<{
  temporaryRoot: string;
  workspaceRoot: string;
  articlePath: string;
  sessions: FileSessionManager;
  documentId: string;
  editorText: string;
}> {
  const temporaryRoot = resolve(await mkdtemp(join(tmpdir(), "fantastic-editor-resolver-")));
  if (!temporaryRoot.startsWith(resolve(tmpdir()))) throw new Error("Unsafe temporary test path.");
  temporaryDirectories.push(temporaryRoot);
  const workspaceRoot = join(temporaryRoot, "article-root");
  await mkdir(join(workspaceRoot, "assets"), { recursive: true });
  const articlePath = join(workspaceRoot, "article.md");
  await writeFile(articlePath, markdown, "utf8");
  const sessions = new FileSessionManager();
  const opened = await sessions.openPath(articlePath);
  if (opened.status !== "opened" || !opened.session) throw new Error(opened.error ?? "open failed");
  return {
    temporaryRoot,
    workspaceRoot,
    articlePath,
    sessions,
    documentId: opened.session.documentId,
    editorText: opened.session.editorText,
  };
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function committedRequest(
  markdown: string,
  taskSequence = 1,
): Promise<{
  resolver: SingleFileResourceResolver;
  commits: ParseCommitRegistry;
  sessions: FileSessionManager;
  request: ResolveRequest;
  workspaceRoot: string;
  temporaryRoot: string;
}> {
  const environment = await setup(markdown);
  const parsed = await parseDocument({ documentId: environment.documentId, editorText: environment.editorText });
  const commits = new ParseCommitRegistry();
  const context = environment.sessions.getResolutionContext(environment.documentId)!;
  const commit = commits.commit({
    documentId: environment.documentId,
    sourceHash: parsed.sourceHash,
    parserProfile: parsed.parserProfile,
    taskSequence,
  }, context);
  if (commit.status !== "committed" || !commit.parseCommitId || commit.workspaceRevision === undefined) {
    throw new Error(commit.error ?? "commit failed");
  }
  return {
    resolver: new SingleFileResourceResolver(commits),
    commits,
    sessions: environment.sessions,
    request: {
      documentId: environment.documentId,
      sourceHash: parsed.sourceHash,
      parserProfile: parsed.parserProfile,
      taskSequence,
      parseCommitId: commit.parseCommitId,
      workspaceRevision: commit.workspaceRevision,
      resourceReferences: parsed.resourceReferences,
    },
    workspaceRoot: environment.workspaceRoot,
    temporaryRoot: environment.temporaryRoot,
  };
}

describe("ParseCommitRegistry", () => {
  it("is idempotent and rejects older or conflicting task identities", async () => {
    const environment = await setup("# doc\n");
    const parsed = await parseDocument({ documentId: environment.documentId, editorText: environment.editorText });
    const registry = new ParseCommitRegistry();
    const context = environment.sessions.getResolutionContext(environment.documentId)!;
    const request = {
      documentId: environment.documentId,
      sourceHash: parsed.sourceHash,
      parserProfile: parsed.parserProfile,
      taskSequence: 2,
    };
    const first = registry.commit(request, context);
    const duplicate = registry.commit(request, context);
    expect(first.status).toBe("committed");
    expect(duplicate.parseCommitId).toBe(first.parseCommitId);
    expect(registry.commit({ ...request, taskSequence: 1 }, context).status).toBe("rejected");
    expect(registry.commit({ ...request, sourceHash: "a".repeat(64) }, context).status).toBe("rejected");
  });

  it("invalidates resolve identity after a newer commit", async () => {
    const environment = await setup("![a](asset.png)\n");
    const parsed = await parseDocument({ documentId: environment.documentId, editorText: environment.editorText });
    const registry = new ParseCommitRegistry();
    const context = environment.sessions.getResolutionContext(environment.documentId)!;
    const first = registry.commit({ documentId: environment.documentId, sourceHash: parsed.sourceHash, parserProfile: parsed.parserProfile, taskSequence: 1 }, context);
    const oldRequest: ResolveRequest = {
      documentId: environment.documentId,
      sourceHash: parsed.sourceHash,
      parserProfile: parsed.parserProfile,
      taskSequence: 1,
      parseCommitId: first.parseCommitId!,
      workspaceRevision: first.workspaceRevision!,
      resourceReferences: parsed.resourceReferences,
    };
    registry.commit({ documentId: environment.documentId, sourceHash: "b".repeat(64), parserProfile: parsed.parserProfile, taskSequence: 2 }, context);
    expect(registry.acceptsResolve(oldRequest, context)).toBe(false);
  });
});

describe("AssetHandleRegistry", () => {
  it("reads an unchanged raster only for the current authorization context", async () => {
    const environment = await setup("# document\n");
    const imagePath = join(environment.workspaceRoot, "assets", "image.png");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    await writeFile(imagePath, bytes);
    const context = environment.sessions.getResolutionContext(environment.documentId)!;
    const registry = new AssetHandleRegistry();
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const handle = registry.create(context, imagePath, contentHash, "image/png");
    const result = await registry.read(handle, context);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(Buffer.from(result.bytes)).toEqual(bytes);
      expect(result.mimeType).toBe("image/png");
    }

    const staleHandle = registry.create(context, imagePath, contentHash, "image/png");
    expect(await registry.read(staleHandle, { ...context, workspaceRevision: context.workspaceRevision + 1 })).toEqual({ status: "stale" });
  });

  it("invalidates changed files and refuses direct SVG delivery", async () => {
    const environment = await setup("# document\n");
    const imagePath = join(environment.workspaceRoot, "assets", "image.png");
    const original = Buffer.from([1, 2, 3]);
    await writeFile(imagePath, original);
    const context = environment.sessions.getResolutionContext(environment.documentId)!;
    const registry = new AssetHandleRegistry();
    const contentHash = createHash("sha256").update(original).digest("hex");
    const changedHandle = registry.create(context, imagePath, contentHash, "image/png");
    await writeFile(imagePath, Buffer.from([4, 5, 6]));
    expect(await registry.read(changedHandle, context)).toEqual({ status: "changed" });

    const svgPath = join(environment.workspaceRoot, "assets", "image.svg");
    const svg = Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>");
    await writeFile(svgPath, svg);
    const svgHandle = registry.create(
      context,
      svgPath,
      createHash("sha256").update(svg).digest("hex"),
      "image/svg+xml",
    );
    expect(await registry.read(svgHandle, context)).toEqual({ status: "unsupported" });
    const transformRead = await registry.readSvgForTransform(svgHandle, context);
    expect(transformRead.status).toBe("ok");
    if (transformRead.status === "ok") expect(Buffer.from(transformRead.bytes)).toEqual(svg);
  });
});

describe("SingleFileResourceResolver", () => {
  it("resolves an authorized image without exposing an absolute path", async () => {
    const environment = await committedRequest("![image](assets/image.png)\n");
    await writeFile(join(environment.workspaceRoot, "assets", "image.png"), validPng(640, 480));
    const context = environment.sessions.getResolutionContext(environment.request.documentId)!;
    const first = await environment.resolver.resolve(environment.request, context);
    expect(first.status).toBe("resolved");
    const record = Object.values(first.resolutionSnapshot!.records)[0]!;
    expect(record).toMatchObject({
      state: "resolved",
      workspaceRelativePath: "assets/image.png",
      mimeType: "image/png",
      byteLength: 24,
      width: 640,
      height: 480,
    });
    expect(record.assetHandle).toMatch(/^[a-f\d-]{36}$/i);
    expect(record.assetCacheKey).toMatch(/^[a-f\d]{64}$/);
    expect(record.contentHash).toMatch(/^[a-f\d]{64}$/);
    expect(JSON.stringify(first)).not.toContain(environment.workspaceRoot);
    const second = await environment.resolver.resolve(environment.request, context);
    expect(Object.values(second.resolutionSnapshot!.records)[0]?.assetCacheKey).toBe(record.assetCacheKey);
  });

  it("returns final missing and blocked states without reading outside the authorization root", async () => {
    const markdown = "![missing](assets/missing.png)\n\n![outside](../outside.png)\n\n![remote](https://example.com/a.png)\n";
    const environment = await committedRequest(markdown);
    await writeFile(join(environment.temporaryRoot, "outside.png"), "outside", "utf8");
    const result = await environment.resolver.resolve(
      environment.request,
      environment.sessions.getResolutionContext(environment.request.documentId),
    );
    const states = Object.values(result.resolutionSnapshot!.records).map((item) => item.state);
    expect(states).toEqual(["missing", "blocked", "blocked"]);
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      "RESOURCE_MISSING",
      "RESOURCE_OUTSIDE_AUTHORIZED_ROOT",
      "REMOTE_IMAGE_BLOCKED",
    ]);
    expect(await readFile(join(environment.temporaryRoot, "outside.png"), "utf8")).toBe("outside");
  });

  it("enforces the document image budget across distinct content", async () => {
    const environment = await committedRequest("![one](assets/one.png)\n\n![two](assets/two.png)\n");
    await writeFile(join(environment.workspaceRoot, "assets", "one.png"), validPng(1, 1));
    await writeFile(join(environment.workspaceRoot, "assets", "two.png"), validPng(2, 2));
    const resolver = new SingleFileResourceResolver(environment.commits, new AssetHandleRegistry(), {
      maxUniqueResolutionBytes: 24,
    });
    const result = await resolver.resolve(
      environment.request,
      environment.sessions.getResolutionContext(environment.request.documentId),
    );
    expect(Object.values(result.resolutionSnapshot!.records).map((record) => record.state)).toEqual(["resolved", "blocked"]);
    expect(result.diagnostics.at(-1)?.code).toBe("DOCUMENT_RESOURCE_BUDGET_EXCEEDED");
    expect(Object.values(result.resolutionSnapshot!.records)[1]?.assetHandle).toBeNull();
  });

  it("counts repeated references to identical image content only once", async () => {
    const environment = await committedRequest("![one](assets/same.png)\n\n![again](assets/same.png)\n");
    await writeFile(join(environment.workspaceRoot, "assets", "same.png"), validPng(1, 1));
    const resolver = new SingleFileResourceResolver(environment.commits, new AssetHandleRegistry(), {
      maxUniqueResolutionBytes: 24,
    });
    const result = await resolver.resolve(
      environment.request,
      environment.sessions.getResolutionContext(environment.request.documentId),
    );
    expect(Object.values(result.resolutionSnapshot!.records).map((record) => record.state)).toEqual(["resolved", "resolved"]);
  });
  it("rejects a truncated raster image before creating a handle", async () => {
    const environment = await committedRequest("![broken](assets/broken.png)\n");
    await writeFile(join(environment.workspaceRoot, "assets", "broken.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const result = await environment.resolver.resolve(
      environment.request,
      environment.sessions.getResolutionContext(environment.request.documentId),
    );
    const record = Object.values(result.resolutionSnapshot!.records)[0]!;
    expect(record.state).toBe("failed");
    expect(record.assetHandle).toBeNull();
    expect(result.diagnostics[0]?.code).toBe("RASTER_IMAGE_HEADER_INVALID");
  });

  it("rejects a resolution that becomes stale while file reads are in flight", async () => {
    const environment = await committedRequest("![image](assets/image.png)\n");
    await writeFile(join(environment.workspaceRoot, "assets", "image.png"), Buffer.alloc(1024 * 1024, 1));
    const context = environment.sessions.getResolutionContext(environment.request.documentId)!;
    const pending = environment.resolver.resolve(environment.request, context, () =>
      environment.sessions.getResolutionContext(environment.request.documentId),
    );
    environment.commits.commit({
      documentId: environment.request.documentId,
      sourceHash: "c".repeat(64),
      parserProfile: environment.request.parserProfile,
      taskSequence: environment.request.taskSequence + 1,
    }, context);
    const result = await pending;
    expect(result.status).toBe("rejected");
    expect(result.resolutionSnapshot).toBeUndefined();
  });

  it("blocks a directory junction whose real path escapes the authorization root", async () => {
    const environment = await committedRequest("![junction](assets/link/outside.png)\n");
    const outsideDirectory = join(environment.temporaryRoot, "outside-directory");
    await mkdir(outsideDirectory, { recursive: true });
    await writeFile(join(outsideDirectory, "outside.png"), "outside", "utf8");
    await symlink(outsideDirectory, join(environment.workspaceRoot, "assets", "link"), "junction");
    const result = await environment.resolver.resolve(
      environment.request,
      environment.sessions.getResolutionContext(environment.request.documentId),
    );
    const record = Object.values(result.resolutionSnapshot!.records)[0]!;
    expect(record.state).toBe("blocked");
    expect(result.diagnostics[0]?.code).toBe("RESOURCE_REALPATH_OUTSIDE_AUTHORIZED_ROOT");
    expect(JSON.stringify(result)).not.toContain(outsideDirectory);
  });

  it("rejects stale commits, duplicate references and unredacted data URI payloads", async () => {
    const environment = await committedRequest("![data](data:image/png;base64,SECRET)\n");
    const context = environment.sessions.getResolutionContext(environment.request.documentId)!;
    const stale = await environment.resolver.resolve({ ...environment.request, parseCommitId: "stale" }, context);
    expect(stale.status).toBe("rejected");
    const duplicate = environment.request.resourceReferences[0]!;
    const duplicateResult = await environment.resolver.resolve({
      ...environment.request,
      resourceReferences: [duplicate, duplicate],
    }, context);
    expect(duplicateResult.status).toBe("rejected");
    const unredacted = { ...duplicate, resolvedRef: "data:image/png;base64,SECRET" };
    const payloadResult = await environment.resolver.resolve({
      ...environment.request,
      resourceReferences: [unredacted],
    }, context);
    expect(payloadResult.status).toBe("rejected");
    expect(JSON.stringify(payloadResult)).not.toContain("SECRET");
  });
});
async function folderCommittedRequest(markdown: string, imagePaths: string[]) {
  const temporaryRoot = resolve(await mkdtemp(join(tmpdir(), "fantastic-editor-folder-resolver-")));
  temporaryDirectories.push(temporaryRoot);
  const workspaceRoot = join(temporaryRoot, "workspace");
  await mkdir(join(workspaceRoot, "notes"), { recursive: true });
  await writeFile(join(workspaceRoot, "notes", "article.md"), markdown, "utf8");
  for (const relativePath of imagePaths) {
    const imagePath = join(workspaceRoot, ...relativePath.split("/"));
    await mkdir(resolve(imagePath, ".."), { recursive: true });
    await writeFile(imagePath, validPng());
  }
  const sessions = new FileSessionManager();
  const openedFolder = await sessions.openFolder(workspaceRoot);
  const article = openedFolder.workspace?.files.find((item) => item.relativePath === "notes/article.md");
  if (!openedFolder.workspace || !article) throw new Error("folder workspace fixture failed");
  const openedFile = await sessions.openWorkspaceFile({
    workspaceId: openedFolder.workspace.workspaceId,
    workspaceRevision: openedFolder.workspace.workspaceRevision,
    fileId: article.fileId,
  });
  if (!openedFile.session) throw new Error(openedFile.error ?? "folder file open failed");
  const parsed = await parseDocument({ documentId: openedFile.session.documentId, editorText: openedFile.session.editorText });
  const commits = new ParseCommitRegistry();
  const context = sessions.getResolutionContext(openedFile.session.documentId)!;
  const commit = commits.commit({
    documentId: parsed.documentId,
    sourceHash: parsed.sourceHash,
    parserProfile: parsed.parserProfile,
    taskSequence: 1,
  }, context);
  if (!commit.parseCommitId || commit.workspaceRevision === undefined) throw new Error("folder parse commit failed");
  const request: ResolveRequest = {
    documentId: parsed.documentId,
    sourceHash: parsed.sourceHash,
    parserProfile: parsed.parserProfile,
    taskSequence: 1,
    parseCommitId: commit.parseCommitId,
    workspaceRevision: commit.workspaceRevision,
    resourceReferences: parsed.resourceReferences,
  };
  return { sessions, workspaceRoot, request, resolver: new SingleFileResourceResolver(commits) };
}

describe("folder-workspace wiki image resolution", () => {
  it("uses the bounded filename index for one unique wiki image", async () => {
    const environment = await folderCommittedRequest("![[image.png]]\n", ["assets/image.png"]);
    const result = await environment.resolver.resolve(
      environment.request,
      environment.sessions.getResolutionContext(environment.request.documentId),
    );
    const record = Object.values(result.resolutionSnapshot!.records)[0]!;
    expect(record.state).toBe("resolved");
    expect(record.workspaceRelativePath).toBe("assets/image.png");
    expect(record.securityFlags).toContain("folder-workspace-root-checked");
  });

  it("returns deterministic ambiguous candidates instead of guessing", async () => {
    const environment = await folderCommittedRequest("![[image.png]]\n", ["assets/image.png", "other/image.png"]);
    const result = await environment.resolver.resolve(
      environment.request,
      environment.sessions.getResolutionContext(environment.request.documentId),
    );
    const record = Object.values(result.resolutionSnapshot!.records)[0]!;
    expect(record.state).toBe("ambiguous");
    expect(record.candidates).toEqual(["assets/image.png", "other/image.png"]);
    expect(result.diagnostics[0]?.code).toBe("RESOURCE_AMBIGUOUS");
  });

  it("falls back from the document directory to an exact workspace-root path", async () => {
    const environment = await folderCommittedRequest("![[assets/image.png]]\n", ["assets/image.png"]);
    const result = await environment.resolver.resolve(
      environment.request,
      environment.sessions.getResolutionContext(environment.request.documentId),
    );
    expect(Object.values(result.resolutionSnapshot!.records)[0]).toMatchObject({
      state: "resolved",
      workspaceRelativePath: "assets/image.png",
    });
  });

  it("does not recursively search a single-file parent directory", async () => {
    const environment = await committedRequest("![[image.png]]\n");
    await writeFile(join(environment.workspaceRoot, "assets", "image.png"), Buffer.from([1, 2, 3]));
    const result = await environment.resolver.resolve(
      environment.request,
      environment.sessions.getResolutionContext(environment.request.documentId),
    );
    expect(Object.values(result.resolutionSnapshot!.records)[0]?.state).toBe("missing");
  });

  it("rejects extensionless wiki images in P0", async () => {
    const environment = await folderCommittedRequest("![[image]]\n", []);
    const result = await environment.resolver.resolve(
      environment.request,
      environment.sessions.getResolutionContext(environment.request.documentId),
    );
    expect(Object.values(result.resolutionSnapshot!.records)[0]?.state).toBe("unsupported");
    expect(result.diagnostics[0]?.code).toBe("WIKI_IMAGE_EXTENSION_REQUIRED");
  });
});
