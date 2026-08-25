import type {
  OutputPreflightContext,
  OutputPreflightResult,
} from "@fantastic-editor/shared";

export function preflightOutput(context: OutputPreflightContext): OutputPreflightResult {
  const diagnostics = [
    ...context.parsedDocument.diagnostics,
    ...context.resolutionSnapshot.diagnostics,
  ];
  const references = new Set(context.parsedDocument.resourceReferences.map((item) => item.referenceKey));
  const records = context.resolutionSnapshot.records;
  const shapeInvalid = context.parsedDocument.documentId !== context.documentId
    || context.parsedDocument.sourceHash !== context.sourceHash
    || context.resolutionSnapshot.documentId !== context.documentId
    || context.resolutionSnapshot.sourceHash !== context.sourceHash
    || context.resolutionSnapshot.workspaceRevision !== context.workspaceRevision
    || Object.keys(records).length !== references.size
    || Object.entries(records).some(([key, record]) =>
      !references.has(key) || record.referenceKey !== key || record.workspaceRevision !== context.workspaceRevision,
    );
  if (shapeInvalid) {
    return {
      preflightId: context.preflightId,
      jobId: context.jobId,
      documentId: context.documentId,
      sourceHash: context.sourceHash,
      workspaceRevision: context.workspaceRevision,
      status: "failed",
      diagnostics: [{
        id: `diagnostic-${context.jobId}-OUTPUT_SNAPSHOT_IDENTITY_INVALID`,
        code: "OUTPUT_SNAPSHOT_IDENTITY_INVALID",
        severity: "blocking",
        category: "security",
        message: "导出快照身份或资源记录集合无效。",
      }],
      candidateOmittedReferenceKeys: [],
      nonOverridableDiagnosticIds: [`diagnostic-${context.jobId}-OUTPUT_SNAPSHOT_IDENTITY_INVALID`],
    };
  }

  const candidateOmittedReferenceKeys = Object.values(records)
    .filter((record) => record.state !== "resolved")
    .map((record) => record.referenceKey)
    .sort();
  const candidateSet = new Set(candidateOmittedReferenceKeys);
  const nonOverridableDiagnosticIds = diagnostics
    .filter((item) => item.severity === "blocking" && (!item.referenceKey || !candidateSet.has(item.referenceKey)))
    .map((item) => item.id);
  const status = nonOverridableDiagnosticIds.length > 0
    ? "failed"
    : candidateOmittedReferenceKeys.length > 0 ? "approval-required" : "ready";
  return {
    preflightId: context.preflightId,
    jobId: context.jobId,
    documentId: context.documentId,
    sourceHash: context.sourceHash,
    workspaceRevision: context.workspaceRevision,
    status,
    diagnostics,
    candidateOmittedReferenceKeys,
    nonOverridableDiagnosticIds,
  };
}