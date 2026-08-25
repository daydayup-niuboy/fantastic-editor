import { randomUUID } from "node:crypto";
import { constants, type Dirent, type Stats } from "node:fs";
import { access, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { FANTASTIC_EDITOR_LIMITS } from "@fantastic-editor/shared";
import type {
  FileFingerprint,
  ImageImportSessionRequest,
  LineSeparator,
  OpenFileResult,
  OpenFolderResult,
  OpenWorkspaceFileRequest,
  FileSessionCommandResult,
  PersistRecoveryRequest,
  RestoreRecoveryResult,
  SaveFileRequest,
  SaveFileResult,
  TextEncoding,
  WorkspaceFileEntry,
  WorkspaceMode,
} from "@fantastic-editor/shared";
import type { RecoverySnapshot } from "./recovery-store.js";

const FOLDER_SCAN_MAX_DEPTH = 32;
const FOLDER_SCAN_SOFT_MARKDOWN_FILES = 2_000;
const FOLDER_SCAN_HARD_MARKDOWN_FILES = 10_000;
const FOLDER_SCAN_HARD_ENTRIES = 100_000;
const FOLDER_SCAN_HARD_RESOURCE_FILES = 20_000;
const INDEXED_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const IGNORED_DIRECTORIES = new Set([".git", ".hg", ".svn", "node_modules"]);

interface FileSession {
  sessionId: string;
  documentId: string;
  workspaceId: string;
  workspaceRevision: number;
  workspaceMode: WorkspaceMode;
  grantId: string;
  path: string;
  documentRealPath: string;
  authorizationRootRealPath: string;
  encoding: TextEncoding;
  lineSeparator: Exclude<LineSeparator, "mixed">;
  fingerprint: FileFingerprint;
  isUntitled: boolean;
  requiresSave: boolean;
  displayNameOverride?: string;
  temporaryRoot?: string;
}

interface FolderWorkspace {
  workspaceId: string;
  workspaceRevision: number;
  grantId: string;
  rootRealPath: string;
  displayName: string;
  files: Map<string, WorkspaceFileEntry>;
  resourceNameIndex: Readonly<Record<string, readonly string[]>>;
}

export interface SingleFileResolutionContext {
  sessionId: string;
  documentId: string;
  workspaceId: string;
  workspaceRevision: number;
  workspaceMode: WorkspaceMode;
  grantId: string;
  documentRealPath: string;
  authorizationRootRealPath: string;
  resourceNameIndex?: Readonly<Record<string, readonly string[]>>;
}

function fingerprintFromStat(value: Stats): FileFingerprint {
  return { byteLength: value.size, mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs };
}

function fingerprintsEqual(left: FileFingerprint, right: FileFingerprint): boolean {
  return left.byteLength === right.byteLength && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const value = relative(rootPath, candidatePath);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

export interface MarkdownOpenOptions {
  allowEncodingConversion?: boolean;
  mixedLineSeparator?: "lf" | "crlf";
  expectedFingerprint?: FileFingerprint;
}

export type FileOpenAttempt = OpenFileResult | {
  status: "confirmation-required";
  session?: undefined;
  error?: undefined;
  confirmation: {
    displayName: string;
    fingerprint: FileFingerprint;
    requiresEncodingConversion: boolean;
    detectedEncoding?: "gb18030";
    hasMixedLineSeparators: boolean;
    crlfCount: number;
    lfCount: number;
    bareCrCount: number;
    preview: string;
  };
};

type MarkdownDecodeAttempt = {
  status: "decoded";
  editorText: string;
  encoding: TextEncoding;
  lineSeparator: "lf" | "crlf";
  requiresSave: boolean;
} | {
  status: "confirmation-required";
  session?: undefined;
  error?: undefined;
  requiresEncodingConversion: boolean;
  detectedEncoding?: "gb18030";
  hasMixedLineSeparators: boolean;
  crlfCount: number;
  lfCount: number;
  bareCrCount: number;
  preview: string;
};

function isLikelyText(value: string): boolean {
  if (value.includes("\0")) return false;
  let controls = 0;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) controls += 1;
  }
  return controls <= Math.max(2, Math.floor(value.length * 0.01));
}

function decodeMarkdown(bytes: Uint8Array, options: MarkdownOpenOptions = {}): MarkdownDecodeAttempt {
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const content = hasBom ? bytes.subarray(3) : bytes;
  let decoded: string;
  let requiresEncodingConversion = false;
  let encoding: TextEncoding = hasBom ? "utf-8-bom" : "utf-8";
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    try {
      decoded = new TextDecoder("gb18030", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("文件既不是有效 UTF-8，也无法按 GB18030/GBK 安全解码。");
    }
    if (!isLikelyText(decoded)) throw new Error("文件包含二进制或控制字符，未按 Markdown 文本打开。");
    requiresEncodingConversion = true;
    encoding = "utf-8";
  }
  if (!isLikelyText(decoded)) throw new Error("文件包含二进制或控制字符，未按 Markdown 文本打开。");
  const crlfCount = (decoded.match(/\r\n/g) ?? []).length;
  const lfCount = (decoded.match(/(?<!\r)\n/g) ?? []).length;
  const bareCrCount = (decoded.match(/\r(?!\n)/g) ?? []).length;
  const hasMixedLineSeparators = (crlfCount > 0 && (lfCount > 0 || bareCrCount > 0)) || bareCrCount > 0;
  if (
    (requiresEncodingConversion && !options.allowEncodingConversion)
    || (hasMixedLineSeparators && !options.mixedLineSeparator)
  ) {
    return {
      status: "confirmation-required",
      requiresEncodingConversion,
      ...(requiresEncodingConversion ? { detectedEncoding: "gb18030" as const } : {}),
      hasMixedLineSeparators,
      crlfCount,
      lfCount,
      bareCrCount,
      preview: decoded.replace(/\r\n?/g, "\n").slice(0, 400),
    };
  }
  const lineSeparator = hasMixedLineSeparators
    ? options.mixedLineSeparator!
    : crlfCount > 0 ? "crlf" : "lf";
  return {
    status: "decoded",
    editorText: decoded.replace(/\r\n?/g, "\n"),
    encoding,
    lineSeparator,
    requiresSave: requiresEncodingConversion || hasMixedLineSeparators,
  };
}
function encodeMarkdown(
  editorText: string,
  encoding: TextEncoding,
  lineSeparator: Exclude<LineSeparator, "mixed">,
): Uint8Array {
  const canonical = editorText.replace(/\r\n?/g, "\n");
  const diskText = lineSeparator === "crlf" ? canonical.replace(/\n/g, "\r\n") : canonical;
  const encoded = new TextEncoder().encode(diskText);
  if (encoding !== "utf-8-bom") return encoded;
  const result = new Uint8Array(encoded.length + 3);
  result.set([0xef, 0xbb, 0xbf]);
  result.set(encoded, 3);
  return result;
}

function isMarkdownFile(name: string): boolean {
  const extension = extname(name).toLowerCase();
  return extension === ".md" || extension === ".markdown";
}

function entrySort(left: Dirent, right: Dirent): number {
  if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
  return left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" });
}

async function scanMarkdownFiles(rootRealPath: string): Promise<{ files: WorkspaceFileEntry[]; warnings: string[]; resourceNameIndex: Readonly<Record<string, readonly string[]>> }> {
  const files: WorkspaceFileEntry[] = [];
  const warnings: string[] = [];
  const resourceNames = new Map<string, string[]>();
  let indexedResourceFiles = 0;
  const pending: Array<{ absolutePath: string; relativePath: string; depth: number }> = [
    { absolutePath: rootRealPath, relativePath: "", depth: 0 },
  ];
  let scannedEntries = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries: Dirent[];
    try {
      entries = (await readdir(current.absolutePath, { withFileTypes: true })).sort(entrySort);
    } catch {
      warnings.push(`无法读取目录：${current.relativePath || "."}`);
      continue;
    }
    for (const entry of entries) {
      scannedEntries += 1;
      if (scannedEntries > FOLDER_SCAN_HARD_ENTRIES) {
        throw new Error(`工作区条目超过 ${FOLDER_SCAN_HARD_ENTRIES.toLocaleString()} 项硬上限，请选择更小的文件夹。`);
      }
      if (entry.isSymbolicLink()) continue;
      const relativePath = current.relativePath ? join(current.relativePath, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name) || current.depth >= FOLDER_SCAN_MAX_DEPTH) continue;
        pending.push({ absolutePath: join(current.absolutePath, entry.name), relativePath, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      const normalizedRelativePath = relativePath.split(sep).join("/");
      if (INDEXED_IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        indexedResourceFiles += 1;
        if (indexedResourceFiles > FOLDER_SCAN_HARD_RESOURCE_FILES) {
          throw new Error(`图片资源超过 ${FOLDER_SCAN_HARD_RESOURCE_FILES.toLocaleString()} 项索引硬上限，请选择更小的文件夹。`);
        }
        const key = entry.name.toLocaleLowerCase("en-US");
        const candidates = resourceNames.get(key) ?? [];
        candidates.push(normalizedRelativePath);
        resourceNames.set(key, candidates);
      }
      if (!isMarkdownFile(entry.name)) continue;
      if (files.length >= FOLDER_SCAN_HARD_MARKDOWN_FILES) {
        throw new Error(`Markdown 文件超过 ${FOLDER_SCAN_HARD_MARKDOWN_FILES.toLocaleString()} 项硬上限，请选择更小的文件夹。`);
      }
      files.push({ fileId: randomUUID(), relativePath: normalizedRelativePath, displayName: normalizedRelativePath });
    }
  }
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "zh-CN", { numeric: true, sensitivity: "base" }));
  if (files.length > FOLDER_SCAN_SOFT_MARKDOWN_FILES) {
    warnings.push(`工作区包含 ${files.length.toLocaleString()} 个 Markdown 文件，超过 ${FOLDER_SCAN_SOFT_MARKDOWN_FILES.toLocaleString()} 项软上限。`);
  }
  const resourceNameIndex = Object.fromEntries([...resourceNames].map(([key, value]) => [key, [...value].sort()]));
  return { files, warnings, resourceNameIndex };
}

export async function atomicWriteCandidate(targetPath: string, bytes: Uint8Array): Promise<void> {
  const tempPath = join(dirname(targetPath), `.${basename(targetPath)}.${randomUUID()}.tmp`);
  const handle = await open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tempPath, targetPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

export class FileSessionManager {
  readonly #sessions = new Map<string, FileSession>();
  #folderWorkspace: FolderWorkspace | undefined;
  #activeSessionId: string | undefined;

  getActiveResolutionContext(): SingleFileResolutionContext | undefined {
    const active = this.#activeSessionId ? this.#sessions.get(this.#activeSessionId) : undefined;
    return active ? this.getResolutionContext(active.documentId) : undefined;
  }

  async createUntitled(): Promise<OpenFileResult> {
    try {
      if ([...this.#sessions.values()].some((session) => session.workspaceMode === "folder-workspace")) {
        await this.clearSessions();
        this.#folderWorkspace = undefined;
      }
      const temporaryRoot = await mkdtemp(join(tmpdir(), "fantastic-editor-untitled-"));
      const session: FileSession = {
        sessionId: randomUUID(),
        documentId: randomUUID(),
        workspaceId: randomUUID(),
        workspaceRevision: 1,
        workspaceMode: "single-file",
        grantId: randomUUID(),
        path: join(temporaryRoot, "untitled.md"),
        documentRealPath: join(temporaryRoot, "untitled.md"),
        authorizationRootRealPath: temporaryRoot,
        encoding: "utf-8",
        lineSeparator: "lf",
        fingerprint: { byteLength: 0, mtimeMs: 0, ctimeMs: 0 },
        isUntitled: true,
        requiresSave: false,
        temporaryRoot,
      };
      this.#sessions.set(session.sessionId, session);
      this.#activeSessionId = session.sessionId;
      return this.openResult(session, "# 未命名文档\n\n");
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : "无法创建新文档。" };
    }
  }

  createRecoverySnapshot(request: PersistRecoveryRequest): RecoverySnapshot {
    if (!Array.isArray(request.tabs) || request.tabs.length > 50) throw new Error("恢复标签数量超过 50 项安全上限。");
    if (request.activeSessionId !== null && typeof request.activeSessionId !== "string") throw new Error("恢复活动标签身份无效。");
    let totalCharacters = 0;
    const seen = new Set<string>();
    const entries = request.tabs.map((tab) => {
      if (!tab || typeof tab.sessionId !== "string" || typeof tab.editorText !== "string") throw new Error("恢复草稿载荷无效。");
      if (seen.has(tab.sessionId)) throw new Error("恢复草稿包含重复的标签身份。");
      seen.add(tab.sessionId);
      if (tab.editorText.length > FANTASTIC_EDITOR_LIMITS.maxSourceCharacters) throw new Error("单个恢复草稿超过 1,000 万字符上限。");
      totalCharacters += tab.editorText.length;
      if (totalCharacters > FANTASTIC_EDITOR_LIMITS.maxSourceCharacters * 5) throw new Error("恢复草稿总量超过 5,000 万字符上限。");
      const session = this.#sessions.get(tab.sessionId);
      if (!session) throw new Error("恢复草稿引用了失效的文件会话。");
      return {
        sessionId: session.sessionId,
        path: session.isUntitled ? null : session.path,
        displayName: session.displayNameOverride ?? (session.isUntitled ? "未命名" : basename(session.path)),
        editorText: tab.editorText.replace(/\r\n?/g, "\n"),
        isUntitled: session.isUntitled,
        encoding: session.encoding,
        lineSeparator: session.lineSeparator,
        fingerprint: session.fingerprint,
        requiresSave: session.requiresSave,
      };
    });
    if (request.activeSessionId && !seen.has(request.activeSessionId)) throw new Error("恢复活动标签不在标签列表中。");
    return {
      schema: "fantastic-editor-recovery",
      version: 1,
      createdAt: new Date().toISOString(),
      activeSessionId: request.activeSessionId,
      entries,
    };
  }

  async restoreRecoverySnapshot(snapshot: RecoverySnapshot): Promise<RestoreRecoveryResult> {
    await this.clearSessions();
    this.#folderWorkspace = undefined;
    const documents: OpenFileResult[] = [];
    const warnings: string[] = [];
    const restoredIds = new Map<string, string>();
    for (const entry of snapshot.entries) {
      let opened: FileOpenAttempt;
      if (entry.isUntitled || !entry.path) {
        opened = await this.createRecoveredUntitled(entry.editorText, entry.displayName === "未命名" ? "未命名（已恢复）" : entry.displayName);
      } else {
        opened = await this.openPath(entry.path, { allowEncodingConversion: true, mixedLineSeparator: entry.lineSeparator });
        if (opened.status === "opened" && opened.session) {
          const session = this.#sessions.get(opened.session.sessionId)!;
          const savedText = opened.session.editorText;
          session.fingerprint = entry.fingerprint;
          session.requiresSave = entry.requiresSave ?? false;
          opened = {
            ...opened,
            session: { ...opened.session, editorText: entry.editorText, savedText, fingerprint: entry.fingerprint, recovered: true, requiresSave: entry.requiresSave ?? false },
          };
        } else {
          warnings.push(`${entry.displayName} 的原文件不可用，草稿已恢复为未命名文档。`);
          opened = await this.createRecoveredUntitled(entry.editorText, `恢复 · ${entry.displayName}`);
        }
      }
      if (opened.status !== "opened" || !opened.session) {
        warnings.push(`${entry.displayName} 的草稿恢复失败。`);
        continue;
      }
      restoredIds.set(entry.sessionId, opened.session.sessionId);
      documents.push(opened);
    }
    const requestedActiveId = snapshot.activeSessionId ? restoredIds.get(snapshot.activeSessionId) : undefined;
    const activeSessionId = requestedActiveId ?? documents.at(-1)?.session?.sessionId ?? null;
    if (activeSessionId) this.#activeSessionId = activeSessionId;
    return documents.length === 0
      ? { status: "empty" }
      : { status: "restored", documents, activeSessionId, warnings };
  }

  async dispose(): Promise<void> {
    await this.clearSessions();
    this.#folderWorkspace = undefined;
  }

  private async createRecoveredUntitled(editorText: string, displayName: string): Promise<OpenFileResult> {
    const opened = await this.createUntitled();
    if (opened.status !== "opened" || !opened.session) return opened;
    const session = this.#sessions.get(opened.session.sessionId)!;
    session.displayNameOverride = displayName;
    session.requiresSave = true;
    const result = this.openResult(session, editorText);
    return { ...result, session: { ...result.session!, savedText: "", recovered: true } };
  }

  activateSession(sessionId: string): FileSessionCommandResult {
    if (!this.#sessions.has(sessionId)) return { status: "failed", error: "文档标签会话已失效。" };
    this.#activeSessionId = sessionId;
    return { status: "activated" };
  }

  async closeSession(sessionId: string): Promise<FileSessionCommandResult> {
    const session = this.#sessions.get(sessionId);
    if (!session) return { status: "failed", error: "文档标签会话已失效。" };
    this.#sessions.delete(sessionId);
    if (session.temporaryRoot) await rm(session.temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
    if (this.#activeSessionId === sessionId) this.#activeSessionId = [...this.#sessions.keys()].at(-1);
    return { status: "closed" };
  }
  getResolutionContext(documentId: string): SingleFileResolutionContext | undefined {
    const session = [...this.#sessions.values()].find((item) => item.documentId === documentId);
    if (!session) return undefined;
    return {
      sessionId: session.sessionId,
      documentId: session.documentId,
      workspaceId: session.workspaceId,
      workspaceRevision: session.workspaceRevision,
      workspaceMode: session.workspaceMode,
      grantId: session.grantId,
      documentRealPath: session.documentRealPath,
      authorizationRootRealPath: session.authorizationRootRealPath,
      ...(session.workspaceMode === "folder-workspace"
        && this.#folderWorkspace?.workspaceId === session.workspaceId
        ? { resourceNameIndex: this.#folderWorkspace.resourceNameIndex }
        : {}),
    };
  }

  getImageImportContext(request: ImageImportSessionRequest): SingleFileResolutionContext | undefined {
    const session = this.#sessions.get(request.sessionId);
    if (
      !session
      || session.isUntitled
      || session.documentId !== request.documentId
      || session.workspaceRevision !== request.workspaceRevision
    ) return undefined;
    return this.getResolutionContext(session.documentId);
  }

  commitImageImport(request: ImageImportSessionRequest, workspaceRelativePaths: readonly string[]): number | undefined {
    const session = this.#sessions.get(request.sessionId);
    if (
      !session
      || session.isUntitled
      || session.documentId !== request.documentId
      || session.workspaceRevision !== request.workspaceRevision
    ) return undefined;
    if (session.workspaceMode === "folder-workspace") {
      const workspace = this.#folderWorkspace;
      if (!workspace || workspace.workspaceId !== session.workspaceId || workspace.workspaceRevision !== request.workspaceRevision) return undefined;
      workspace.workspaceRevision += 1;
      for (const item of this.#sessions.values()) {
        if (item.workspaceId === workspace.workspaceId) item.workspaceRevision = workspace.workspaceRevision;
      }
      const nextIndex: Record<string, readonly string[]> = { ...workspace.resourceNameIndex };
      for (const resourcePath of workspaceRelativePaths) {
        const key = basename(resourcePath).toLocaleLowerCase("en-US");
        const candidates = new Set(nextIndex[key] ?? []);
        candidates.add(resourcePath);
        nextIndex[key] = [...candidates].sort();
      }
      workspace.resourceNameIndex = nextIndex;
      return workspace.workspaceRevision;
    }
    session.workspaceRevision += 1;
    return session.workspaceRevision;
  }
  async openPath(path: string, options: MarkdownOpenOptions = {}): Promise<FileOpenAttempt> {
    if (!isMarkdownFile(path)) return { status: "failed", error: "只能打开 .md 或 .markdown 文件。" };
    try {
      const documentRealPath = await realpath(path);
      const authorizationRootRealPath = await realpath(dirname(documentRealPath));
      const opened = await this.openDocument(documentRealPath, {
        workspaceId: randomUUID(),
        workspaceRevision: 1,
        workspaceMode: "single-file",
        grantId: randomUUID(),
        authorizationRootRealPath,
      }, options);
      if (opened.status === "opened") this.#folderWorkspace = undefined;
      return opened;
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : "读取文件失败。" };
    }
  }

  async openFolder(path: string): Promise<OpenFolderResult> {
    try {
      await access(path, constants.R_OK);
      const rootRealPath = await realpath(path);
      if (!(await stat(rootRealPath)).isDirectory()) return { status: "failed", error: "所选项目不是文件夹。" };
      const scanned = await scanMarkdownFiles(rootRealPath);
      const workspace: FolderWorkspace = {
        workspaceId: randomUUID(),
        workspaceRevision: 1,
        grantId: randomUUID(),
        rootRealPath,
        displayName: basename(rootRealPath),
        files: new Map(scanned.files.map((file) => [file.fileId, file])),
        resourceNameIndex: scanned.resourceNameIndex,
      };
      await this.clearSessions();
      this.#folderWorkspace = workspace;
      return {
        status: "opened",
        workspace: {
          workspaceId: workspace.workspaceId,
          workspaceRevision: workspace.workspaceRevision,
          displayName: workspace.displayName,
          files: scanned.files,
          warnings: scanned.warnings,
        },
      };
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : "无法打开工作区。" };
    }
  }

  async openWorkspaceFile(request: OpenWorkspaceFileRequest, options: MarkdownOpenOptions = {}): Promise<FileOpenAttempt> {
    const workspace = this.#folderWorkspace;
    if (
      !workspace
      || request.workspaceId !== workspace.workspaceId
      || request.workspaceRevision !== workspace.workspaceRevision
    ) return { status: "failed", error: "工作区身份已失效，请重新打开文件夹。" };
    const file = workspace.files.get(request.fileId);
    if (!file) return { status: "failed", error: "文件标识不存在或已经失效。" };
    try {
      const candidate = join(workspace.rootRealPath, ...file.relativePath.split("/"));
      const documentRealPath = await realpath(candidate);
      if (!isPathInside(workspace.rootRealPath, documentRealPath)) {
        return { status: "failed", error: "所选文件越出工作区授权边界。" };
      }
      return await this.openDocument(documentRealPath, {
        workspaceId: workspace.workspaceId,
        workspaceRevision: workspace.workspaceRevision,
        workspaceMode: "folder-workspace",
        grantId: workspace.grantId,
        authorizationRootRealPath: workspace.rootRealPath,
      }, options);
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : "读取工作区文件失败。" };
    }
  }

  async save(request: SaveFileRequest, targetPath?: string): Promise<SaveFileResult> {
    const session = this.#sessions.get(request.sessionId);
    if (!session) return { status: "failed", error: "文件会话已失效，请重新打开文件。" };
    const path = targetPath ?? session.path;
    if (session.isUntitled && !targetPath) return { status: "failed", error: "未命名文档需要先另存为。" };
    try {
      if (!targetPath) {
        const currentFingerprint = fingerprintFromStat(await stat(path));
        if (!request.allowOverwriteExternalChanges && !fingerprintsEqual(session.fingerprint, currentFingerprint)) {
          return { status: "conflict", error: "磁盘文件已被其他程序修改。" };
        }
      }
      const canonicalText = request.editorText.replace(/\r\n?/g, "\n");
      if (canonicalText.length > FANTASTIC_EDITOR_LIMITS.maxSourceCharacters) return { status: "failed", error: "文档超过 1,000 万字符编辑上限，未写入磁盘。" };
      const encoded = encodeMarkdown(canonicalText, session.encoding, session.lineSeparator);
      if (encoded.byteLength > FANTASTIC_EDITOR_LIMITS.maxMarkdownFileBytes) return { status: "failed", error: "编码后的 Markdown 超过 40 MiB 安全上限，未写入磁盘。" };
      await atomicWriteCandidate(path, encoded);
      session.path = await realpath(path);
      session.documentRealPath = session.path;
      if (targetPath) {
        const temporaryRoot = session.temporaryRoot;
        session.isUntitled = false;
        delete session.temporaryRoot;
        if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
        this.#folderWorkspace = undefined;
        session.workspaceMode = "single-file";
        session.workspaceRevision += 1;
        session.grantId = randomUUID();
        session.authorizationRootRealPath = await realpath(dirname(session.path));
        delete session.displayNameOverride;
      }
      session.fingerprint = fingerprintFromStat(await stat(session.path));
      session.requiresSave = false;
      return {
        status: "saved",
        displayName: basename(session.path),
        fingerprint: session.fingerprint,
        workspaceRevision: session.workspaceRevision,
        workspaceMode: session.workspaceMode,
      };
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : "保存文件失败。" };
    }
  }

  private async openDocument(
    documentRealPath: string,
    workspace: Pick<FileSession, "workspaceId" | "workspaceRevision" | "workspaceMode" | "grantId" | "authorizationRootRealPath">,
    options: MarkdownOpenOptions = {},
  ): Promise<FileOpenAttempt> {
    if (!isMarkdownFile(documentRealPath)) return { status: "failed", error: "只能打开 .md 或 .markdown 文件。" };
    await access(documentRealPath, constants.R_OK);
    const beforeStat = await stat(documentRealPath);
    if (!beforeStat.isFile()) return { status: "failed", error: "所选项目不是文件。" };
    if (beforeStat.size > FANTASTIC_EDITOR_LIMITS.maxMarkdownFileBytes) {
      return { status: "failed", error: "Markdown 文件超过 40 MiB 安全上限。" };
    }
    const beforeFingerprint = fingerprintFromStat(beforeStat);
    if (options.expectedFingerprint && !fingerprintsEqual(options.expectedFingerprint, beforeFingerprint)) {
      return { status: "failed", error: "文件在转换确认期间发生变化，请重新打开并检查最新内容。" };
    }
    const bytes = await readFile(documentRealPath);
    const afterStat = await stat(documentRealPath);
    const fingerprint = fingerprintFromStat(afterStat);
    if (!fingerprintsEqual(beforeFingerprint, fingerprint)) {
      return { status: "failed", error: "Markdown 文件在读取期间发生变化，请重新打开。" };
    }
    const decoded = decodeMarkdown(bytes, options);
    if (decoded.status === "decoded" && decoded.editorText.length > FANTASTIC_EDITOR_LIMITS.maxSourceCharacters) {
      return { status: "failed", error: "文档超过 1,000 万字符编辑上限。" };
    }
    if (decoded.status === "confirmation-required") {
      return {
        status: "confirmation-required",
        confirmation: {
          displayName: basename(documentRealPath),
          fingerprint,
          requiresEncodingConversion: decoded.requiresEncodingConversion,
          ...(decoded.detectedEncoding ? { detectedEncoding: decoded.detectedEncoding } : {}),
          hasMixedLineSeparators: decoded.hasMixedLineSeparators,
          crlfCount: decoded.crlfCount,
          lfCount: decoded.lfCount,
          bareCrCount: decoded.bareCrCount,
          preview: decoded.preview,
        },
      };
    }
    if (workspace.workspaceMode === "folder-workspace" || [...this.#sessions.values()].some((session) => session.workspaceMode === "folder-workspace")) await this.clearSessions();
    const existing = [...this.#sessions.values()].find((session) => session.workspaceMode === "single-file" && session.path.toLocaleLowerCase("en-US") === documentRealPath.toLocaleLowerCase("en-US"));
    if (existing) {
      this.#activeSessionId = existing.sessionId;
      return this.openResult(existing, decoded.editorText);
    }

    const session: FileSession = {
      sessionId: randomUUID(),
      documentId: randomUUID(),
      workspaceId: workspace.workspaceId,
      workspaceRevision: workspace.workspaceRevision,
      workspaceMode: workspace.workspaceMode,
      grantId: workspace.grantId,
      path: documentRealPath,
      documentRealPath,
      authorizationRootRealPath: workspace.authorizationRootRealPath,
      encoding: decoded.encoding,
      lineSeparator: decoded.lineSeparator,
      fingerprint,
      isUntitled: false,
      requiresSave: decoded.requiresSave,
    };
    this.#sessions.set(session.sessionId, session);
    this.#activeSessionId = session.sessionId;
    return this.openResult(session, decoded.editorText);
  }

  private openResult(session: FileSession, editorText: string): OpenFileResult {
    return {
      status: "opened",
      session: {
        sessionId: session.sessionId,
        documentId: session.documentId,
        workspaceId: session.workspaceId,
        workspaceRevision: session.workspaceRevision,
        workspaceMode: session.workspaceMode,
        displayName: session.displayNameOverride ?? (session.isUntitled ? "未命名" : basename(session.path)),
        editorText,
        encoding: session.encoding,
        lineSeparator: session.lineSeparator,
        fingerprint: session.fingerprint,
        isUntitled: session.isUntitled,
        requiresSave: session.requiresSave,
      },
    };
  }

  private async clearSessions(): Promise<void> {
    const temporaryRoots = [...this.#sessions.values()].flatMap((session) => session.temporaryRoot ? [session.temporaryRoot] : []);
    this.#sessions.clear();
    this.#activeSessionId = undefined;
    await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)));
  }
}


















