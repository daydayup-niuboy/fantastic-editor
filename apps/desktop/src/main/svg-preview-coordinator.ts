import { createHash } from "node:crypto";
import type { Diagnostic, ResourceReference, SvgContentReference } from "@fantastic-editor/document-core";
import type {
  PreviewDerivedEntry,
  PreviewDerivedUpdate,
  ResolveRequest,
  ResolveResult,
} from "@fantastic-editor/shared";
import type { SingleFileResolutionContext } from "./file-sessions.js";
import type { SvgTransformResult } from "./svg-transform.js";
import { SVG_TRANSFORM_PROFILE, SVG_TRANSFORMER_VERSION } from "./svg-transform.js";
import type { AssetHandleRegistry } from "./single-file-resource-resolver.js";
import type { PreviewDerivedAssetCache } from "./preview-derived-cache.js";

interface SvgTransformer {
  transformSvg(bytes: Uint8Array): Promise<SvgTransformResult>;
}

type DiagnosticReference = Pick<ResourceReference, "referenceKey" | "source" | "nodeId">;
const HASH_PATTERN = /^[a-f\d]{64}$/i;
const MAX_INLINE_SVG_COUNT = 100;
const MAX_INLINE_SVG_BYTES = 10 * 1024 * 1024;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function inlineSvgReferenceKey(reference: SvgContentReference, documentId: string): string {
  const values = ["svg-content", documentId, String(reference.source.from), String(reference.source.to), reference.sourceContentHash];
  return sha256(values.map((value) => `${Buffer.byteLength(value, "utf8")}:${value}`).join(""));
}

function isValidInlineSvg(reference: SvgContentReference, documentId: string): boolean {
  return Boolean(reference)
    && typeof reference.referenceKey === "string"
    && HASH_PATTERN.test(reference.referenceKey)
    && typeof reference.sourceContentHash === "string"
    && HASH_PATTERN.test(reference.sourceContentHash)
    && typeof reference.nodeId === "string"
    && reference.nodeId.length > 0
    && reference.nodeId.length <= 200
    && typeof reference.content === "string"
    && Buffer.byteLength(reference.content, "utf8") > 0
    && Buffer.byteLength(reference.content, "utf8") <= MAX_INLINE_SVG_BYTES
    && Number.isInteger(reference.source?.from)
    && Number.isInteger(reference.source?.to)
    && reference.source.from >= 0
    && reference.source.to > reference.source.from
    && sha256(reference.content) === reference.sourceContentHash
    && inlineSvgReferenceKey(reference, documentId) === reference.referenceKey;
}

function diagnosticReference(value: unknown): DiagnosticReference | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<DiagnosticReference>;
  return typeof candidate.referenceKey === "string"
    && typeof candidate.nodeId === "string"
    && Boolean(candidate.source)
    ? candidate as DiagnosticReference
    : undefined;
}

function transformDiagnostic(
  reference: DiagnosticReference | undefined,
  code: string,
  message: string,
): Diagnostic {
  return {
    id: `diagnostic-${reference?.referenceKey ?? "unknown"}-${code}`,
    code,
    severity: "blocking",
    category: code.includes("BLOCKED") ? "security" : "compatibility",
    message,
    ...(reference ? {
      source: reference.source,
      nodeId: reference.nodeId,
      referenceKey: reference.referenceKey,
    } : {}),
  };
}

export class SvgPreviewCoordinator {
  readonly #sourceHandles: AssetHandleRegistry;
  readonly #derivedCache: PreviewDerivedAssetCache;
  readonly #transformer: SvgTransformer;

  constructor(
    sourceHandles: AssetHandleRegistry,
    derivedCache: PreviewDerivedAssetCache,
    transformer: SvgTransformer,
  ) {
    this.#sourceHandles = sourceHandles;
    this.#derivedCache = derivedCache;
    this.#transformer = transformer;
  }

  async schedule(
    request: ResolveRequest,
    result: ResolveResult,
    context: SingleFileResolutionContext,
    isCurrent: () => boolean,
    emit: (update: PreviewDerivedUpdate) => void,
  ): Promise<void> {
    const snapshot = result.resolutionSnapshot;
    const manifest = result.previewDerivedManifest;
    if (result.status !== "resolved" || !snapshot || !manifest) return;
    const svgRecords = Object.values(snapshot.records).filter((record) =>
      record.state === "resolved"
      && record.mimeType === "image/svg+xml"
      && typeof record.contentHash === "string"
      && typeof record.assetHandle === "string",
    );
    const inlineSvgs = Array.isArray(request.svgContents) ? request.svgContents : [];
    if ((svgRecords.length === 0 && inlineSvgs.length === 0) || !isCurrent()) return;

    const references = new Map(request.resourceReferences.map((reference) => [reference.referenceKey, reference]));
    const entries: Record<string, PreviewDerivedEntry> = {};
    const diagnostics: Diagnostic[] = [];
    const createdHandles: string[] = [];
    const transformed = new Map<string, Promise<SvgTransformResult>>();

    if (inlineSvgs.length > MAX_INLINE_SVG_COUNT) diagnostics.push(transformDiagnostic(
      undefined,
      "SVG_CONTENT_COUNT_EXCEEDED",
      `正文 SVG 内容超过 ${MAX_INLINE_SVG_COUNT} 个安全上限，多余内容未渲染。`,
    ));

    for (const record of svgRecords) {
      if (!isCurrent()) break;
      const cached = this.#derivedCache.reuse(
        context,
        record.referenceKey,
        record.contentHash!,
        SVG_TRANSFORM_PROFILE,
        SVG_TRANSFORMER_VERSION,
      );
      if (cached) {
        entries[record.referenceKey] = cached;
        createdHandles.push(cached.previewAssetHandle);
        continue;
      }

      const source = await this.#sourceHandles.readSvgForTransform(record.assetHandle!, context);
      if (source.status !== "ok" || source.contentHash !== record.contentHash || source.mimeType !== "image/svg+xml") {
        diagnostics.push(transformDiagnostic(
          references.get(record.referenceKey),
          "SVG_SOURCE_HANDLE_INVALID",
          "SVG 源资源在安全转换前已失效或发生变化。",
        ));
        continue;
      }
      let pending = transformed.get(record.contentHash!);
      if (!pending) {
        pending = this.#transformer.transformSvg(source.bytes);
        transformed.set(record.contentHash!, pending);
      }
      const transformedSvg = await pending;
      if (transformedSvg.status !== "completed") {
        diagnostics.push(transformDiagnostic(
          references.get(record.referenceKey),
          transformedSvg.code,
          transformedSvg.message,
        ));
        continue;
      }
      if (!isCurrent()) break;
      try {
        const entry = this.#derivedCache.put(
          context,
          record.referenceKey,
          record.contentHash!,
          SVG_TRANSFORM_PROFILE,
          SVG_TRANSFORMER_VERSION,
          transformedSvg.png,
          transformedSvg.width,
          transformedSvg.height,
        );
        entries[record.referenceKey] = entry;
        createdHandles.push(entry.previewAssetHandle);
      } catch {
        diagnostics.push(transformDiagnostic(
          references.get(record.referenceKey),
          "SVG_DERIVED_CACHE_FAILED",
          "SVG 已转换，但无法写入预览派生缓存。",
        ));
      }
    }

    const usedKeys = new Set(svgRecords.map((record) => record.referenceKey));
    for (const reference of inlineSvgs.slice(0, MAX_INLINE_SVG_COUNT)) {
      if (!isCurrent()) break;
      if (!isValidInlineSvg(reference, request.documentId) || usedKeys.has(reference.referenceKey)) {
        diagnostics.push(transformDiagnostic(diagnosticReference(reference), "SVG_CONTENT_REQUEST_INVALID", "正文 SVG 内容身份无效，已拒绝渲染。"));
        continue;
      }
      usedKeys.add(reference.referenceKey);
      const cached = this.#derivedCache.reuse(
        context,
        reference.referenceKey,
        reference.sourceContentHash,
        SVG_TRANSFORM_PROFILE,
        SVG_TRANSFORMER_VERSION,
      );
      if (cached) {
        entries[reference.referenceKey] = cached;
        createdHandles.push(cached.previewAssetHandle);
        continue;
      }
      let pending = transformed.get(reference.sourceContentHash);
      if (!pending) {
        pending = this.#transformer.transformSvg(new TextEncoder().encode(reference.content));
        transformed.set(reference.sourceContentHash, pending);
      }
      const transformedSvg = await pending;
      if (transformedSvg.status !== "completed") {
        diagnostics.push(transformDiagnostic(reference, transformedSvg.code, transformedSvg.message));
        continue;
      }
      if (!isCurrent()) break;
      try {
        const entry = this.#derivedCache.put(
          context,
          reference.referenceKey,
          reference.sourceContentHash,
          SVG_TRANSFORM_PROFILE,
          SVG_TRANSFORMER_VERSION,
          transformedSvg.png,
          transformedSvg.width,
          transformedSvg.height,
        );
        entries[reference.referenceKey] = entry;
        createdHandles.push(entry.previewAssetHandle);
      } catch {
        diagnostics.push(transformDiagnostic(reference, "SVG_DERIVED_CACHE_FAILED", "SVG 已转换，但无法写入预览派生缓存。"));
      }
    }

    if (!isCurrent()) {
      for (const handleId of createdHandles) this.#derivedCache.revoke(handleId);
      return;
    }
    emit({
      documentId: request.documentId,
      sourceHash: request.sourceHash,
      parserProfile: request.parserProfile,
      taskSequence: request.taskSequence,
      parseCommitId: request.parseCommitId,
      workspaceRevision: request.workspaceRevision,
      manifestRevision: manifest.manifestRevision + 1,
      entries,
      diagnostics,
    });
  }
}
