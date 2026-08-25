import { createHash } from "node:crypto";
import { readFile, mkdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import {
  FANTASTIC_EDITOR_LIMITS,
  type DroppedImageFile,
  type ImageImportSessionRequest,
  type ImportedAssetReceipt,
  type ImportImagesResult,
} from "@fantastic-editor/shared";
import { atomicWriteCandidate, FileSessionManager, type SingleFileResolutionContext } from "./file-sessions.js";
import { probeRasterDimensions } from "./image-dimensions.js";

const MAX_IMPORT_FILES = 100;
const IDENTITY = /^[A-Za-z0-9-]{1,128}$/;
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
});
const EXTENSION_BY_MIME: Readonly<Record<string, string>> = Object.freeze({
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
});

interface ValidatedImage {
  displayName: string;
  stem: string;
  mimeType: string;
  extension: string;
  bytes: Uint8Array;
  contentHash: string;
}

interface StoredImage extends ValidatedImage {
  absolutePath: string;
  relativeRef: string;
  workspaceRelativePath: string;
  reusedExisting: boolean;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function workspacePath(root: string, candidate: string): string {
  return relative(root, candidate).split(sep).join("/");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeDisplayName(value: string): string {
  const leaf = basename(value.replace(/\0/g, "").trim()).slice(0, 255);
  return leaf || "image";
}

function safeStem(displayName: string): string {
  const withoutExtension = displayName.slice(0, Math.max(0, displayName.length - extname(displayName).length));
  let value = withoutExtension
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f\[\](){}#%]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[. -]+|[. -]+$/g, "")
    .slice(0, 64);
  if (!value || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)) value = "image";
  return value;
}

function looksLikeSvg(bytes: Uint8Array): boolean {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, Math.min(bytes.byteLength, 512 * 1024)));
    if (text.includes("\0")) return false;
    return /^\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--(?:[\s\S]*?)-->\s*)*<svg(?:\s|>)/i.test(text.replace(/^\uFEFF/, ""));
  } catch {
    return false;
  }
}

function validateImage(source: DroppedImageFile): ValidatedImage {
  if (!source || typeof source.displayName !== "string" || typeof source.declaredMimeType !== "string") {
    throw new Error("图片导入载荷无效。");
  }
  if (!(source.bytes instanceof Uint8Array)) throw new Error("图片导入字节格式无效。");
  if (source.bytes.byteLength === 0) throw new Error("不能导入空图片文件。");
  if (source.bytes.byteLength > FANTASTIC_EDITOR_LIMITS.maxSingleResourceBytes) throw new Error("单张图片超过 50 MiB 安全上限。");
  const displayName = safeDisplayName(source.displayName);
  const declaredExtension = extname(displayName).toLocaleLowerCase("en-US");
  const declaredMime = MIME_BY_EXTENSION[declaredExtension];
  if (!declaredMime) throw new Error(`不支持图片格式：${displayName}`);
  const valid = declaredMime === "image/svg+xml"
    ? looksLikeSvg(source.bytes)
    : Boolean(probeRasterDimensions(source.bytes, declaredMime));
  if (!valid) throw new Error(`图片内容损坏或扩展名与文件签名不匹配：${displayName}`);
  if (source.declaredMimeType && source.declaredMimeType !== declaredMime && !(declaredMime === "image/jpeg" && source.declaredMimeType === "image/jpg")) {
    throw new Error(`图片声明类型与文件扩展名不匹配：${displayName}`);
  }
  return {
    displayName,
    stem: safeStem(displayName),
    mimeType: declaredMime,
    extension: EXTENSION_BY_MIME[declaredMime]!,
    bytes: source.bytes,
    contentHash: sha256(source.bytes),
  };
}

function validRequest(request: ImageImportSessionRequest): boolean {
  return Boolean(
    request
    && IDENTITY.test(request.importRequestId)
    && IDENTITY.test(request.sessionId)
    && IDENTITY.test(request.documentId)
    && Number.isSafeInteger(request.workspaceRevision)
    && request.workspaceRevision > 0,
  );
}

async function readSelectedFile(path: string): Promise<DroppedImageFile> {
  const before = await stat(path, { bigint: true });
  if (!before.isFile()) throw new Error("选择的图片不是普通文件。");
  if (before.size <= 0n || before.size > BigInt(FANTASTIC_EDITOR_LIMITS.maxSingleResourceBytes)) throw new Error("选择的图片为空或超过 50 MiB 安全上限。");
  const bytes = await readFile(path);
  const after = await stat(path, { bigint: true });
  if (
    before.size !== after.size
    || before.mtimeNs !== after.mtimeNs
    || before.ctimeNs !== after.ctimeNs
  ) throw new Error("图片在读取期间发生变化，请重试。");
  const displayName = safeDisplayName(path);
  return {
    displayName,
    declaredMimeType: MIME_BY_EXTENSION[extname(displayName).toLocaleLowerCase("en-US")] ?? "",
    bytes,
  };
}

export class ImageImportService {
  constructor(private readonly sessions: FileSessionManager) {}

  async importSelectedPaths(request: ImageImportSessionRequest, paths: readonly string[]): Promise<ImportImagesResult> {
    if (!validRequest(request) || !this.sessions.getImageImportContext(request)) return { status: "failed", error: "文档尚未保存、会话已变化或工作区版本已过期。" };
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_IMPORT_FILES) return { status: "failed", error: `一次只能导入 1 至 ${MAX_IMPORT_FILES} 张图片。` };
    try {
      const files: DroppedImageFile[] = [];
      let totalBytes = 0;
      for (const path of paths) {
        const file = await readSelectedFile(path);
        totalBytes += file.bytes.byteLength;
        if (totalBytes > FANTASTIC_EDITOR_LIMITS.maxUniqueResolutionBytes) throw new Error("本次图片导入总量超过 200 MiB 安全上限。");
        files.push(file);
      }
      return await this.importDroppedFiles(request, files);
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : "读取所选图片失败。" };
    }
  }

  async importDroppedFiles(request: ImageImportSessionRequest, files: readonly DroppedImageFile[]): Promise<ImportImagesResult> {
    if (!validRequest(request)) return { status: "failed", error: "图片导入身份无效。" };
    const context = this.sessions.getImageImportContext(request);
    if (!context) return { status: "failed", error: "文档尚未保存、会话已变化或工作区版本已过期。" };
    if (!Array.isArray(files) || files.length === 0 || files.length > MAX_IMPORT_FILES) {
      return { status: "failed", error: `一次只能导入 1 至 ${MAX_IMPORT_FILES} 张图片。` };
    }
    try {
      const validated = files.map(validateImage);
      const totalBytes = validated.reduce((sum, item) => sum + item.bytes.byteLength, 0);
      if (totalBytes > FANTASTIC_EDITOR_LIMITS.maxUniqueResolutionBytes) throw new Error("本次图片导入总量超过 200 MiB 安全上限。");
      const stored = await this.storeImages(context, validated);
      const nextRevision = this.sessions.commitImageImport(request, stored.map((item) => item.workspaceRelativePath));
      if (!nextRevision) throw new Error("图片写入期间文档或工作区身份发生变化；已写文件未自动删除，请检查 assets 目录。");
      const receipts: ImportedAssetReceipt[] = stored.map((item) => ({
        importRequestId: request.importRequestId,
        documentId: request.documentId,
        sessionId: request.sessionId,
        workspaceRevision: nextRevision,
        relativeRef: item.relativeRef,
        displayName: item.displayName,
        mimeType: item.mimeType,
        byteLength: item.bytes.byteLength,
        contentHash: item.contentHash,
        reusedExisting: item.reusedExisting,
      }));
      return { status: "imported", receipts, workspaceRevision: nextRevision };
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : "导入图片失败。" };
    }
  }

  private async storeImages(context: SingleFileResolutionContext, images: readonly ValidatedImage[]): Promise<StoredImage[]> {
    const documentDirectory = dirname(context.documentRealPath);
    if (!isWithinRoot(context.authorizationRootRealPath, documentDirectory)) throw new Error("Markdown 文件目录越出当前授权边界。");
    const assetsCandidate = join(documentDirectory, "assets");
    await mkdir(assetsCandidate, { recursive: true });
    const assetsDirectory = await realpath(assetsCandidate);
    if (!isWithinRoot(context.authorizationRootRealPath, assetsDirectory)) throw new Error("assets 目录越出当前授权边界或指向外部位置。");
    const stored: StoredImage[] = [];
    for (const image of images) {
      const suffixLengths = [8, 12, 16, 24, 64];
      let selected: { path: string; reused: boolean } | undefined;
      for (const suffixLength of suffixLengths) {
        const fileName = `${image.stem}-${image.contentHash.slice(0, suffixLength)}${image.extension}`;
        const candidate = join(assetsDirectory, fileName);
        try {
          const existingRealPath = await realpath(candidate);
          if (!isWithinRoot(assetsDirectory, existingRealPath)) throw new Error("目标图片越出 assets 目录。");
          const existing = await readFile(existingRealPath);
          if (sha256(existing) === image.contentHash) {
            selected = { path: existingRealPath, reused: true };
            break;
          }
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") throw error;
          await atomicWriteCandidate(candidate, image.bytes);
          const writtenRealPath = await realpath(candidate);
          if (!isWithinRoot(assetsDirectory, writtenRealPath)) throw new Error("写入的图片越出 assets 目录。");
          selected = { path: writtenRealPath, reused: false };
          break;
        }
      }
      if (!selected) throw new Error(`无法为图片生成无冲突文件名：${image.displayName}`);
      const fileName = basename(selected.path);
      stored.push({
        ...image,
        absolutePath: selected.path,
        relativeRef: `./assets/${fileName}`,
        workspaceRelativePath: workspacePath(context.authorizationRootRealPath, selected.path),
        reusedExisting: selected.reused,
      });
    }
    return stored;
  }
}

