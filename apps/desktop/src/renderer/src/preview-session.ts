import type { Diagnostic } from "@fantastic-editor/document-core";
import type {
  PreviewDerivedEntry,
  PreviewDerivedUpdate,
  PreviewSession,
  ResolutionSnapshot,
  ResolveResult,
} from "@fantastic-editor/shared";
import type { ParseWorkerSuccess } from "./workers/parse-worker-protocol";

const HANDLE_PATTERN = /^[a-f\d]{8}-[a-f\d]{4}-[1-5][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const HASH_PATTERN = /^[a-f\d]{64}$/i;
const PREVIEW_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export type PreviewSessionResult =
  | { status: "accepted"; session: PreviewSession }
  | { status: "rejected"; error: string };

function sameIdentity(parse: ParseWorkerSuccess, resolved: ResolveResult): boolean {
  const snapshot = resolved.resolutionSnapshot;
  const manifest = resolved.previewDerivedManifest;
  return resolved.status === "resolved"
    && Boolean(snapshot)
    && Boolean(manifest)
    && parse.documentId === parse.parsedDocument.documentId
    && parse.sourceHash === parse.parsedDocument.sourceHash
    && parse.parserProfile === parse.parsedDocument.parserProfile
    && resolved.documentId === parse.documentId
    && resolved.sourceHash === parse.sourceHash
    && resolved.parserProfile === parse.parserProfile
    && resolved.taskSequence === parse.taskSequence
    && snapshot?.documentId === parse.documentId
    && snapshot.sourceHash === parse.sourceHash
    && snapshot.workspaceRevision === resolved.workspaceRevision
    && manifest?.documentId === parse.documentId
    && manifest.sourceHash === parse.sourceHash
    && manifest.parserProfile === parse.parserProfile
    && manifest.taskSequence === parse.taskSequence
    && manifest.parseCommitId === resolved.parseCommitId
    && manifest.workspaceRevision === resolved.workspaceRevision;
}

function isValidEntry(
  key: string,
  entry: PreviewDerivedEntry,
  snapshot: ResolutionSnapshot,
): boolean {
  const source = snapshot.records[key];
  return Boolean(source)
    && entry.referenceKey === key
    && source?.state === "resolved"
    && typeof source.contentHash === "string"
    && entry.sourceContentHash === source.contentHash
    && HASH_PATTERN.test(entry.sourceContentHash)
    && entry.transformProfile.length > 0
    && HANDLE_PATTERN.test(entry.previewAssetHandle)
    && PREVIEW_MIME_TYPES.has(entry.mimeType)
    && (entry.width === null || (Number.isInteger(entry.width) && entry.width > 0))
    && (entry.height === null || (Number.isInteger(entry.height) && entry.height > 0));
}

function hasValidEntries(
  entries: Record<string, PreviewDerivedEntry>,
  snapshot: ResolutionSnapshot,
): boolean {
  return Object.entries(entries).every(([key, entry]) => isValidEntry(key, entry, snapshot));
}

function mergeDiagnostics(...groups: readonly Diagnostic[][]): Diagnostic[] {
  const result: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const diagnostic of groups.flat()) {
    const key = `${diagnostic.code}\u0000${diagnostic.referenceKey ?? ""}\u0000${diagnostic.nodeId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(diagnostic);
  }
  return result;
}

export function createPreviewSession(
  parse: ParseWorkerSuccess,
  resolved: ResolveResult,
): PreviewSessionResult {
  if (!sameIdentity(parse, resolved) || !resolved.resolutionSnapshot || !resolved.previewDerivedManifest) {
    return { status: "rejected", error: "预览解析、资源快照或派生清单身份不匹配。" };
  }
  const referenceKeys = new Set(parse.parsedDocument.resourceReferences.map((item) => item.referenceKey));
  const records = resolved.resolutionSnapshot.records;
  if (
    Object.keys(records).length !== referenceKeys.size
    || Object.entries(records).some(([key, record]) =>
      !referenceKeys.has(key)
      || record.referenceKey !== key
      || record.workspaceRevision !== resolved.workspaceRevision,
    )
    || !Number.isInteger(resolved.previewDerivedManifest.manifestRevision)
    || resolved.previewDerivedManifest.manifestRevision < 0
    || !hasValidEntries(resolved.previewDerivedManifest.entries, resolved.resolutionSnapshot)
  ) {
    return { status: "rejected", error: "预览资源记录或派生清单内容无效。" };
  }
  return {
    status: "accepted",
    session: {
      schema: "fantastic-editor-preview-session",
      documentId: parse.documentId,
      sourceHash: parse.sourceHash,
      workspaceRevision: resolved.workspaceRevision,
      parsedDocument: parse.parsedDocument,
      resolutionSnapshot: resolved.resolutionSnapshot,
      previewDerivedManifest: resolved.previewDerivedManifest,
      diagnostics: mergeDiagnostics(parse.diagnostics, resolved.diagnostics),
    },
  };
}

export function applyPreviewDerivedUpdate(
  session: PreviewSession,
  update: PreviewDerivedUpdate,
): PreviewSessionResult {
  const manifest = session.previewDerivedManifest;
  if (
    update.documentId !== session.documentId
    || update.sourceHash !== session.sourceHash
    || update.parserProfile !== manifest.parserProfile
    || update.taskSequence !== manifest.taskSequence
    || update.parseCommitId !== manifest.parseCommitId
    || update.workspaceRevision !== session.workspaceRevision
    || !Number.isInteger(update.manifestRevision)
    || update.manifestRevision <= manifest.manifestRevision
    || !hasValidEntries(update.entries, session.resolutionSnapshot)
  ) {
    return { status: "rejected", error: "PreviewDerivedUpdate 已过期、倒退或内容无效。" };
  }
  return {
    status: "accepted",
    session: {
      ...session,
      previewDerivedManifest: {
        ...manifest,
        manifestRevision: update.manifestRevision,
        entries: { ...manifest.entries, ...update.entries },
      },
      diagnostics: mergeDiagnostics(session.diagnostics, update.diagnostics),
    },
  };
}