import { describe, expect, it } from "vitest";
import type { PreviewDerivedEntry, PreviewSession, ResolutionRecord } from "@fantastic-editor/shared";
import { applyResolutionToPreviewHtml } from "./preview-assets.js";

const REFERENCE_KEY = "a".repeat(64);
const CONTENT_HASH = "c".repeat(64);
const HANDLE = "00000000-0000-4000-8000-000000000001";
const DERIVED_HANDLE = "00000000-0000-4000-8000-000000000002";
const PLACEHOLDER = `<p><span class="resource-placeholder" role="img" data-reference-key="${REFERENCE_KEY}" data-alt="示例 &amp; 图片" data-source-from="12" data-source-to="34" data-source-kind="image">[图片：示例 &amp; 图片]</span></p>`;

function record(overrides: Partial<ResolutionRecord> = {}): ResolutionRecord {
  return {
    referenceKey: REFERENCE_KEY,
    workspaceRevision: 1,
    assetCacheKey: "b".repeat(64),
    fileFingerprint: null,
    originalRef: "assets/image.png",
    resolvedRef: "assets/image.png",
    workspaceRelativePath: "assets/image.png",
    mimeType: "image/png",
    byteLength: 4,
    contentHash: CONTENT_HASH,
    width: null,
    height: null,
    state: "resolved",
    candidates: [],
    assetHandle: HANDLE,
    securityFlags: [],
    ...overrides,
  };
}

function session(
  resourceRecord: ResolutionRecord,
  derivedEntries: Record<string, PreviewDerivedEntry> = {},
): PreviewSession {
  return {
    schema: "fantastic-editor-preview-session",
    documentId: "document-1",
    sourceHash: "d".repeat(64),
    workspaceRevision: 1,
    parsedDocument: {
      schema: "fantastic-editor-parsed-document",
      udmVersion: "0.5",
      parserProfile: "test",
      documentId: "document-1",
      sourceHash: "d".repeat(64),
      sourceLength: 0,
      metadata: {},
      children: [],
      resourceReferences: [],
      diagnostics: [],
      statistics: { headings: 0, images: 0, formulas: 0, characters: 0 },
    },
    resolutionSnapshot: {
      schema: "fantastic-editor-resolution-snapshot",
      documentId: "document-1",
      sourceHash: "d".repeat(64),
      workspaceId: "workspace-1",
      workspaceRevision: 1,
      resolverProfile: "test",
      records: { [REFERENCE_KEY]: resourceRecord },
      diagnostics: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    previewDerivedManifest: {
      schema: "fantastic-editor-preview-derived-manifest",
      documentId: "document-1",
      sourceHash: "d".repeat(64),
      parserProfile: "test",
      taskSequence: 1,
      parseCommitId: "commit-1",
      workspaceRevision: 1,
      manifestRevision: Object.keys(derivedEntries).length > 0 ? 1 : 0,
      entries: derivedEntries,
    },
    diagnostics: [],
  };
}

describe("applyResolutionToPreviewHtml", () => {
  it("maps a resolved raster record to the restricted asset protocol", () => {
    const html = applyResolutionToPreviewHtml(PLACEHOLDER, session(record()));
    expect(html).toContain(`src="fantastic-asset://asset/${HANDLE}"`);
    expect(html).toContain(`data-reference-key="${REFERENCE_KEY}"`);
    expect(html).toContain('data-source-from="12" data-source-to="34" data-source-kind="image"');
    expect(html).toContain('alt="示例 &amp; 图片"');
    expect(html).not.toContain("resource-placeholder");
  });

  it("maps SVG only through a source-bound rasterized derived entry", () => {
    const svg = record({ mimeType: "image/svg+xml", assetHandle: HANDLE });
    const entry: PreviewDerivedEntry = {
      referenceKey: REFERENCE_KEY,
      sourceContentHash: CONTENT_HASH,
      transformProfile: "svg-safe-png-0.1",
      previewAssetHandle: DERIVED_HANDLE,
      mimeType: "image/png",
      width: 100,
      height: 80,
    };
    expect(applyResolutionToPreviewHtml(PLACEHOLDER, session(svg))).toBe(PLACEHOLDER);
    expect(applyResolutionToPreviewHtml(PLACEHOLDER, session(svg, { [REFERENCE_KEY]: entry })))
      .toContain(`src="fantastic-asset://asset/${DERIVED_HANDLE}"`);
    expect(applyResolutionToPreviewHtml(PLACEHOLDER, session(svg, {
      [REFERENCE_KEY]: { ...entry, sourceContentHash: "e".repeat(64) },
    }))).toBe(PLACEHOLDER);
  });

  it("maps fenced SVG content only through its parsed identity and derived PNG", () => {
    const svgKey = "f".repeat(64);
    const svgHash = "e".repeat(64);
    const placeholder = `<span class="inline-svg-placeholder" role="img" data-reference-key="${svgKey}" data-source-content-hash="${svgHash}" data-source-from="0" data-source-to="42" data-source-kind="svg-content" data-source-block="true">[SVG 等待安全转换]</span>`;
    const value = session(record());
    value.resolutionSnapshot.records = {};
    value.parsedDocument.svgContents = [{
      referenceKey: svgKey,
      nodeId: "node-svg",
      source: { from: 0, to: 42, startLine: 1, startColumn: 1, endLine: 3, endColumn: 4, precision: "exact" },
      sourceContentHash: svgHash,
      content: "<svg/>",
    }];
    value.previewDerivedManifest.entries = {
      [svgKey]: { referenceKey: svgKey, sourceContentHash: svgHash, transformProfile: "svg-safe-png-0.1", previewAssetHandle: DERIVED_HANDLE, mimeType: "image/png", width: 20, height: 10 },
    };
    const html = applyResolutionToPreviewHtml(placeholder, value);
    expect(html).toContain(`src="fantastic-asset://asset/${DERIVED_HANDLE}"`);
    expect(html).toContain('data-source-kind="svg-content"');
    expect(html).not.toContain("inline-svg-placeholder");
    value.parsedDocument.svgContents[0]!.sourceContentHash = "d".repeat(64);
    expect(applyResolutionToPreviewHtml(placeholder, value)).toBe(placeholder);
  });

  it("keeps placeholders for invalid handles and non-resolved records", () => {
    expect(applyResolutionToPreviewHtml(PLACEHOLDER, session(record({ assetHandle: "not-a-handle" })))).toBe(PLACEHOLDER);
    expect(applyResolutionToPreviewHtml(PLACEHOLDER, session(record({ state: "blocked" })))).toBe(PLACEHOLDER);
  });

  it("does not rewrite unrelated or malformed HTML", () => {
    const unrelated = `<span data-reference-key="${REFERENCE_KEY}">untrusted</span>`;
    expect(applyResolutionToPreviewHtml(unrelated, session(record()))).toBe(unrelated);
  });
});
