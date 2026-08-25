import type { PreviewDerivedEntry, PreviewSession, ResolutionRecord } from "@fantastic-editor/shared";

const RASTER_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const UUID_PATTERN = /^[a-f\d]{8}-[a-f\d]{4}-[1-5][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const RESOURCE_PLACEHOLDER = /<span class="resource-placeholder" role="img" data-reference-key="([a-f\d]{64})" data-alt="([^"]*)"( data-source-from="\d+" data-source-to="\d+" data-source-kind="image")>\[图片：[\s\S]*?\]<\/span>/gi;

interface PreviewAsset {
  handle: string;
  mimeType: string;
}

function directAsset(record: ResolutionRecord | undefined): PreviewAsset | undefined {
  if (
    record?.state !== "resolved"
    || record.mimeType === "image/svg+xml"
    || typeof record.assetHandle !== "string"
    || !UUID_PATTERN.test(record.assetHandle)
    || typeof record.mimeType !== "string"
    || !RASTER_MIME_TYPES.has(record.mimeType)
  ) return undefined;
  return { handle: record.assetHandle, mimeType: record.mimeType };
}

function derivedAsset(
  record: ResolutionRecord | undefined,
  entry: PreviewDerivedEntry | undefined,
): PreviewAsset | undefined {
  if (
    record?.state !== "resolved"
    || record.mimeType !== "image/svg+xml"
    || typeof record.contentHash !== "string"
    || !entry
    || entry.referenceKey !== record.referenceKey
    || entry.sourceContentHash !== record.contentHash
    || !UUID_PATTERN.test(entry.previewAssetHandle)
    || !RASTER_MIME_TYPES.has(entry.mimeType)
  ) return undefined;
  return { handle: entry.previewAssetHandle, mimeType: entry.mimeType };
}

export function applyResolutionToPreviewHtml(
  previewHtml: string,
  session: PreviewSession,
): string {
  return previewHtml.replace(RESOURCE_PLACEHOLDER, (placeholder, referenceKey: string, escapedAlt: string, sourceAttributes: string) => {
    const record = session.resolutionSnapshot.records[referenceKey];
    const asset = directAsset(record)
      ?? derivedAsset(record, session.previewDerivedManifest.entries[referenceKey]);
    if (!asset) return placeholder;
    return `<img class="resolved-local-image" src="fantastic-asset://asset/${asset.handle}" alt="${escapedAlt}" data-reference-key="${referenceKey}" data-mime-type="${asset.mimeType}"${sourceAttributes} loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
  });
}