import type { Diagnostic, ResourceReference } from "@fantastic-editor/document-core";
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

function transformDiagnostic(
  reference: ResourceReference | undefined,
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
    if (svgRecords.length === 0 || !isCurrent()) return;

    const references = new Map(request.resourceReferences.map((reference) => [reference.referenceKey, reference]));
    const entries: Record<string, PreviewDerivedEntry> = {};
    const diagnostics: Diagnostic[] = [];
    const createdHandles: string[] = [];
    const transformed = new Map<string, Promise<SvgTransformResult>>();

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