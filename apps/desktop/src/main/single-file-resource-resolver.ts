import { createHash, randomUUID } from "node:crypto";
import { FANTASTIC_EDITOR_LIMITS } from "@fantastic-editor/shared";
import type { BigIntStats } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Diagnostic, ResourceReference } from "@fantastic-editor/document-core";
import type {
  PreviewDerivedManifest,
  ResolutionRecord,
  ResolveRequest,
  ResolveResult,
  ResourceFileFingerprint,
} from "@fantastic-editor/shared";
import type { SingleFileResolutionContext } from "./file-sessions.js";
import { probeRasterDimensions } from "./image-dimensions.js";
import { ParseCommitRegistry } from "./parse-commit-registry.js";

const RESOLVER_PROFILE = "fantastic-editor-resource-resolver-0.2";
const HANDLE_LIFETIME_MS = 5 * 60 * 1000;
const DRIVE_RELATIVE = /^[a-z]:(?![\\/])/i;

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};
const DIRECT_PREVIEW_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const SVG_TRANSFORM_MIME_TYPES = new Set(["image/svg+xml"]);

interface AssetGrant {
  handleId: string;
  documentId: string;
  workspaceId: string;
  grantId: string;
  workspaceRevision: number;
  contentHash: string;
  mimeType: string;
  absolutePath: string;
  expiresAt: number;
}

export type AssetReadResult =
  | { status: "ok"; bytes: Uint8Array; mimeType: string; contentHash: string }
  | { status: "not-found" | "stale" | "changed" | "unsupported" };

export class AssetHandleRegistry {
  readonly #grants = new Map<string, AssetGrant>();

  create(
    context: SingleFileResolutionContext,
    absolutePath: string,
    contentHash: string,
    mimeType: string,
  ): string {
    this.prune();
    const handleId = randomUUID();
    this.#grants.set(handleId, {
      handleId,
      documentId: context.documentId,
      workspaceId: context.workspaceId,
      grantId: context.grantId,
      workspaceRevision: context.workspaceRevision,
      contentHash,
      mimeType,
      absolutePath,
      expiresAt: Date.now() + HANDLE_LIFETIME_MS,
    });
    return handleId;
  }

  read(handleId: string, context: SingleFileResolutionContext | undefined): Promise<AssetReadResult> {
    return this.#read(handleId, context, DIRECT_PREVIEW_MIME_TYPES);
  }

  readSvgForTransform(handleId: string, context: SingleFileResolutionContext | undefined): Promise<AssetReadResult> {
    return this.#read(handleId, context, SVG_TRANSFORM_MIME_TYPES);
  }

  async #read(
    handleId: string,
    context: SingleFileResolutionContext | undefined,
    allowedMimeTypes: ReadonlySet<string>,
  ): Promise<AssetReadResult> {
    this.prune();
    const grant = this.#grants.get(handleId);
    if (!grant) return { status: "not-found" };
    if (
      !context
      || grant.documentId !== context.documentId
      || grant.workspaceId !== context.workspaceId
      || grant.grantId !== context.grantId
      || grant.workspaceRevision !== context.workspaceRevision
    ) {
      this.#grants.delete(handleId);
      return { status: "stale" };
    }
    if (!allowedMimeTypes.has(grant.mimeType)) return { status: "unsupported" };
    try {
      const resolvedPath = await realpath(grant.absolutePath);
      if (!isWithinRoot(context.authorizationRootRealPath, resolvedPath)) {
        this.#grants.delete(handleId);
        return { status: "stale" };
      }
      const before = await stat(resolvedPath, { bigint: true });
      if (!before.isFile() || before.size > BigInt(FANTASTIC_EDITOR_LIMITS.maxSingleResourceBytes)) return { status: "changed" };
      const bytes = await readFile(resolvedPath);
      const after = await stat(resolvedPath, { bigint: true });
      if (!sameReadIdentity(before, after) || sha256Bytes(bytes) !== grant.contentHash) {
        this.#grants.delete(handleId);
        return { status: "changed" };
      }
      return { status: "ok", bytes, mimeType: grant.mimeType, contentHash: grant.contentHash };
    } catch {
      this.#grants.delete(handleId);
      return { status: "changed" };
    }
  }

  revoke(handleId: string): void { this.#grants.delete(handleId); }

  revokeAll(): void { this.#grants.clear(); }

  private prune(): void {
    const now = Date.now();
    for (const [id, grant] of this.#grants) if (grant.expiresAt <= now) this.#grants.delete(id);
  }
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashParts(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(`${Buffer.byteLength(part, "utf8")}:${part}`);
  return hash.digest("hex");
}

function isWithinRoot(root: string, candidate: string): boolean {
  const result = relative(root, candidate);
  return result === "" || (!result.startsWith(`..${sep}`) && result !== ".." && !isAbsolute(result));
}

async function isSafeExistingCandidate(root: string, candidate: string): Promise<boolean> {
  if (!isWithinRoot(root, candidate)) return false;
  try {
    return isWithinRoot(root, await realpath(candidate));
  } catch {
    return false;
  }
}

function workspacePath(root: string, candidate: string): string {
  return relative(root, candidate).split(sep).join("/");
}

function safeReferenceValue(reference: ResourceReference, value: string): string {
  if (reference.kind === "data-uri") return "data:[blocked]";
  if (reference.kind === "local-path" && isAbsolute(value)) return "[absolute-local-path]";
  return value.slice(0, 4096);
}

function emptyRecord(
  reference: ResourceReference,
  workspaceRevision: number,
  state: ResolutionRecord["state"],
  securityFlags: string[],
): ResolutionRecord {
  return {
    referenceKey: reference.referenceKey,
    workspaceRevision,
    assetCacheKey: null,
    fileFingerprint: null,
    originalRef: safeReferenceValue(reference, reference.originalRef),
    resolvedRef: safeReferenceValue(reference, reference.resolvedRef),
    workspaceRelativePath: null,
    mimeType: null,
    byteLength: null,
    contentHash: null,
    width: null,
    height: null,
    state,
    candidates: [],
    assetHandle: null,
    securityFlags,
  };
}

function diagnostic(
  reference: ResourceReference,
  code: string,
  message: string,
  category: Diagnostic["category"] = "resource",
): Diagnostic {
  return {
    id: `diagnostic-${reference.referenceKey}-${code}`,
    code,
    severity: "blocking",
    category,
    message,
    source: reference.source,
    nodeId: reference.nodeId,
    referenceKey: reference.referenceKey,
  };
}

function fingerprint(value: BigIntStats): ResourceFileFingerprint {
  return {
    byteLength: Number(value.size),
    mtimeNs: value.mtimeNs.toString(),
    ctimeNs: value.ctimeNs.toString(),
    fileId: `${value.dev.toString()}:${value.ino.toString()}`,
  };
}

function sameReadIdentity(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function isSafeReferenceShape(reference: ResourceReference): boolean {
  return typeof reference.referenceKey === "string"
    && /^[a-f\d]{64}$/i.test(reference.referenceKey)
    && typeof reference.nodeId === "string"
    && typeof reference.originalRef === "string"
    && typeof reference.resolvedRef === "string"
    && typeof reference.normalizedResolvedRef === "string"
    && typeof reference.source?.from === "number"
    && typeof reference.source?.to === "number";
}

interface ResourceResolverLimits {
  maxResourceReferences: number;
  maxSingleResourceBytes: number;
  maxUniqueResolutionBytes: number;
}

export class SingleFileResourceResolver {
  readonly #commits: ParseCommitRegistry;
  readonly #handles: AssetHandleRegistry;
  readonly #limits: ResourceResolverLimits;

  constructor(
    commits: ParseCommitRegistry,
    handles = new AssetHandleRegistry(),
    limits: Partial<ResourceResolverLimits> = {},
  ) {
    this.#commits = commits;
    this.#handles = handles;
    this.#limits = {
      maxResourceReferences: limits.maxResourceReferences ?? FANTASTIC_EDITOR_LIMITS.maxResourceReferences,
      maxSingleResourceBytes: limits.maxSingleResourceBytes ?? FANTASTIC_EDITOR_LIMITS.maxSingleResourceBytes,
      maxUniqueResolutionBytes: limits.maxUniqueResolutionBytes ?? FANTASTIC_EDITOR_LIMITS.maxUniqueResolutionBytes,
    };
  }

  revokeAllHandles(): void { this.#handles.revokeAll(); }

  async resolve(
    request: ResolveRequest,
    context: SingleFileResolutionContext | undefined,
    getCurrentContext: () => SingleFileResolutionContext | undefined = () => context,
  ): Promise<ResolveResult> {
    const base = {
      documentId: request.documentId,
      sourceHash: request.sourceHash,
      parserProfile: request.parserProfile,
      taskSequence: request.taskSequence,
      parseCommitId: request.parseCommitId,
      workspaceRevision: request.workspaceRevision,
    };
    if (!context || !this.#commits.acceptsResolve(request, context)) {
      return { status: "rejected", ...base, diagnostics: [], error: "ResolveRequest 已过期或身份不匹配。" };
    }
    if (!Array.isArray(request.resourceReferences) || request.resourceReferences.length > this.#limits.maxResourceReferences) {
      return { status: "rejected", ...base, diagnostics: [], error: "资源引用集合无效。" };
    }
    const seen = new Set<string>();
    for (const reference of request.resourceReferences) {
      if (!isSafeReferenceShape(reference) || seen.has(reference.referenceKey)) {
        return { status: "rejected", ...base, diagnostics: [], error: "资源引用身份无效或重复。" };
      }
      seen.add(reference.referenceKey);
      if (
        reference.kind === "data-uri"
        && (reference.originalRef !== "data:[blocked]" || reference.resolvedRef !== "data:[blocked]")
      ) {
        return { status: "rejected", ...base, diagnostics: [], error: "源 data URI 未在解析边界脱敏。" };
      }
    }

    const records: Record<string, ResolutionRecord> = {};
    const diagnostics: Diagnostic[] = [];
    const createdHandles: string[] = [];
    const resolvedContentHashes = new Set<string>();
    let totalUniqueResolvedBytes = 0;
    const rejectIfStale = (): ResolveResult | undefined => {
      if (this.#commits.acceptsResolve(request, getCurrentContext())) return undefined;
      for (const handleId of createdHandles) this.#handles.revoke(handleId);
      return { status: "rejected", ...base, diagnostics: [], error: "ResolveRequest 在处理期间失效。" };
    };
    for (const reference of request.resourceReferences) {
      const staleBeforeRead = rejectIfStale();
      if (staleBeforeRead) return staleBeforeRead;
      let result = await this.#resolveOne(reference, context);
      const record = result.record;
      if (record.state === "resolved" && record.contentHash && record.byteLength !== null && !resolvedContentHashes.has(record.contentHash)) {
        if (totalUniqueResolvedBytes + record.byteLength > this.#limits.maxUniqueResolutionBytes) {
          if (record.assetHandle) this.#handles.revoke(record.assetHandle);
          result = {
            record: {
              ...record,
              state: "blocked",
              assetHandle: null,
              securityFlags: [...record.securityFlags, "document-resource-budget-exceeded"],
            },
            diagnostic: diagnostic(
              reference,
              "DOCUMENT_RESOURCE_BUDGET_EXCEEDED",
              "文档图片资源总量超过 200 MiB 安全预算；该图片未授权进入预览或导出。",
              "performance",
            ),
          };
        } else {
          resolvedContentHashes.add(record.contentHash);
          totalUniqueResolvedBytes += record.byteLength;
        }
      }
      records[reference.referenceKey] = result.record;
      if (result.record.assetHandle) createdHandles.push(result.record.assetHandle);
      if (result.diagnostic) diagnostics.push(result.diagnostic);
    }
    const staleAfterRead = rejectIfStale();
    if (staleAfterRead) return staleAfterRead;
    const previewDerivedManifest: PreviewDerivedManifest = {
      schema: "fantastic-editor-preview-derived-manifest",
      documentId: request.documentId,
      sourceHash: request.sourceHash,
      parserProfile: request.parserProfile,
      taskSequence: request.taskSequence,
      parseCommitId: request.parseCommitId,
      workspaceRevision: request.workspaceRevision,
      manifestRevision: 0,
      entries: {},
    };
    return {
      status: "resolved",
      ...base,
      resolutionSnapshot: {
        schema: "fantastic-editor-resolution-snapshot",
        documentId: request.documentId,
        sourceHash: request.sourceHash,
        workspaceId: context.workspaceId,
        workspaceRevision: context.workspaceRevision,
        resolverProfile: RESOLVER_PROFILE,
        records,
        diagnostics,
        createdAt: new Date().toISOString(),
      },
      previewDerivedManifest,
      diagnostics,
    };
  }

  async #resolveOne(
    reference: ResourceReference,
    context: SingleFileResolutionContext,
  ): Promise<{ record: ResolutionRecord; diagnostic?: Diagnostic }> {
    if (reference.kind !== "local-path") {
      const code = {
        "remote-http": "REMOTE_IMAGE_BLOCKED",
        "data-uri": "DATA_URI_SOURCE_BLOCKED",
        "file-uri": "FILE_URI_BLOCKED",
        "app-internal": "APP_INTERNAL_RESOURCE_BLOCKED",
        "unsupported-scheme": "UNSUPPORTED_RESOURCE_SCHEME",
      }[reference.kind];
      return {
        record: emptyRecord(reference, context.workspaceRevision, reference.kind === "unsupported-scheme" ? "unsupported" : "blocked", ["protocol-blocked"]),
        diagnostic: diagnostic(reference, code, "该资源协议未获 P0 本地资源读取授权。", "security"),
      };
    }
    if (reference.resolvedRef.length > 4096 || DRIVE_RELATIVE.test(reference.resolvedRef)) {
      return {
        record: emptyRecord(reference, context.workspaceRevision, "blocked", ["drive-relative-or-overlong"]),
        diagnostic: diagnostic(reference, "WINDOWS_DRIVE_RELATIVE_PATH_BLOCKED", "盘符相对路径或超长路径已被阻止。", "security"),
      };
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(reference.resolvedRef);
    } catch {
      return {
        record: emptyRecord(reference, context.workspaceRevision, "blocked", ["invalid-percent-encoding"]),
        diagnostic: diagnostic(reference, "INVALID_PERCENT_ENCODING", "路径包含非法百分号编码。", "security"),
      };
    }
    if (reference.syntax === "wiki-image" && !extname(decoded)) {
      return {
        record: emptyRecord(reference, context.workspaceRevision, "unsupported", ["wiki-extension-required"]),
        diagnostic: diagnostic(reference, "WIKI_IMAGE_EXTENSION_REQUIRED", "双链图片必须包含受支持的文件扩展名。", "compatibility"),
      };
    }

    let candidate: string;
    if (reference.syntax === "wiki-image" && context.workspaceMode === "folder-workspace") {
      const isSimpleName = !/[\\/]/.test(decoded);
      if (isSimpleName) {
        const indexed = context.resourceNameIndex?.[decoded.toLocaleLowerCase("en-US")] ?? [];
        if (indexed.length > 1) {
          return {
            record: {
              ...emptyRecord(reference, context.workspaceRevision, "ambiguous", ["workspace-index-ambiguous"]),
              candidates: [...indexed],
            },
            diagnostic: diagnostic(reference, "RESOURCE_AMBIGUOUS", "工作区内存在多个同名图片，请使用包含目录的双链路径。"),
          };
        }
        candidate = indexed[0]
          ? resolve(context.authorizationRootRealPath, ...indexed[0].split("/"))
          : resolve(dirname(context.documentRealPath), decoded);
      } else {
        const documentRelative = isAbsolute(decoded) ? resolve(decoded) : resolve(dirname(context.documentRealPath), decoded);
        const workspaceRelative = isAbsolute(decoded) ? resolve(decoded) : resolve(context.authorizationRootRealPath, decoded);
        candidate = await isSafeExistingCandidate(context.authorizationRootRealPath, documentRelative)
          ? documentRelative
          : workspaceRelative;
      }
    } else {
      candidate = isAbsolute(decoded) ? resolve(decoded) : resolve(dirname(context.documentRealPath), decoded);
    }
    if (!isWithinRoot(context.authorizationRootRealPath, candidate)) {
      return {
        record: emptyRecord(reference, context.workspaceRevision, "blocked", ["lexical-root-check-failed"]),
        diagnostic: diagnostic(reference, "RESOURCE_OUTSIDE_AUTHORIZED_ROOT", "资源位于当前会话授权目录之外。", "security"),
      };
    }

    let candidateRealPath: string;
    try {
      candidateRealPath = await realpath(candidate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        return {
          record: emptyRecord(reference, context.workspaceRevision, "missing", ["lexical-root-check-passed"]),
          diagnostic: diagnostic(reference, "RESOURCE_MISSING", "找不到本地图片资源。"),
        };
      }
      return {
        record: emptyRecord(reference, context.workspaceRevision, "failed", ["realpath-failed"]),
        diagnostic: diagnostic(reference, "RESOURCE_REALPATH_FAILED", "无法确认本地资源的真实路径。"),
      };
    }
    if (!isWithinRoot(context.authorizationRootRealPath, candidateRealPath)) {
      return {
        record: emptyRecord(reference, context.workspaceRevision, "blocked", ["realpath-root-check-failed"]),
        diagnostic: diagnostic(reference, "RESOURCE_REALPATH_OUTSIDE_AUTHORIZED_ROOT", "资源真实路径越出当前授权目录。", "security"),
      };
    }

    const mimeType = MIME_TYPES[extname(candidateRealPath).toLowerCase()];
    if (!mimeType) {
      return {
        record: emptyRecord(reference, context.workspaceRevision, "unsupported", ["unsupported-extension"]),
        diagnostic: diagnostic(reference, "UNSUPPORTED_IMAGE_FORMAT", "P0 不支持该本地图片格式。", "compatibility"),
      };
    }

    try {
      const before = await stat(candidateRealPath, { bigint: true });
      if (!before.isFile()) {
        return {
          record: emptyRecord(reference, context.workspaceRevision, "unsupported", ["not-a-file"]),
          diagnostic: diagnostic(reference, "RESOURCE_NOT_A_FILE", "资源目标不是普通文件。"),
        };
      }
      if (before.size > BigInt(this.#limits.maxSingleResourceBytes)) {
        return {
          record: emptyRecord(reference, context.workspaceRevision, "blocked", ["provisional-size-limit"]),
          diagnostic: diagnostic(reference, "RESOURCE_SIZE_LIMIT_EXCEEDED", "资源超过阶段 0 临时 50 MiB 安全上限。", "security"),
        };
      }
      const bytes = await readFile(candidateRealPath);
      const after = await stat(candidateRealPath, { bigint: true });
      if (!sameReadIdentity(before, after)) {
        return {
          record: emptyRecord(reference, context.workspaceRevision, "failed", ["changed-during-read"]),
          diagnostic: diagnostic(reference, "RESOURCE_CHANGED_DURING_READ", "资源在读取期间发生变化，请重试。"),
        };
      }
      const dimensions = mimeType === "image/svg+xml" ? undefined : probeRasterDimensions(bytes, mimeType);
      if (mimeType !== "image/svg+xml" && !dimensions) {
        return {
          record: emptyRecord(reference, context.workspaceRevision, "failed", ["raster-header-invalid"]),
          diagnostic: diagnostic(reference, "RASTER_IMAGE_HEADER_INVALID", "图片文件头损坏、被截断或尺寸超过安全上限。", "security"),
        };
      }
      const contentHash = sha256Bytes(bytes);
      const relativePath = workspacePath(context.authorizationRootRealPath, candidateRealPath);
      const fileFingerprint = fingerprint(after);
      const assetCacheKey = hashParts([
        context.workspaceId,
        relativePath,
        fileFingerprint.byteLength.toString(),
        fileFingerprint.mtimeNs,
        fileFingerprint.ctimeNs,
        fileFingerprint.fileId ?? "",
      ]);
      return {
        record: {
          referenceKey: reference.referenceKey,
          workspaceRevision: context.workspaceRevision,
          assetCacheKey,
          fileFingerprint,
          originalRef: safeReferenceValue(reference, reference.originalRef),
          resolvedRef: safeReferenceValue(reference, reference.resolvedRef),
          workspaceRelativePath: relativePath,
          mimeType,
          byteLength: bytes.byteLength,
          contentHash,
          width: dimensions?.width ?? null,
          height: dimensions?.height ?? null,
          state: "resolved",
          candidates: [],
          assetHandle: this.#handles.create(context, candidateRealPath, contentHash, mimeType),
          securityFlags: [`${context.workspaceMode}-root-checked`, "realpath-root-checked"],
        },
      };
    } catch {
      return {
        record: emptyRecord(reference, context.workspaceRevision, "failed", ["read-failed"]),
        diagnostic: diagnostic(reference, "RESOURCE_READ_FAILED", "读取本地资源失败。"),
      };
    }
  }
}



