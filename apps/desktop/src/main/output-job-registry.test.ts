import { describe, expect, it } from "vitest";
import type { OutputPreflightResult, OutputResult } from "@fantastic-editor/shared";
import { OutputJobRegistry } from "./output-job-registry.js";

const sourceHash = "a".repeat(64);
const omittedA = "b".repeat(64);
const omittedB = "c".repeat(64);

function reachPreflight(registry: OutputJobRegistry) {
  const created = registry.create({ documentId: "document-1", target: "offline-html", sourceHash, workspaceRevision: 1 });
  for (const state of ["parsing", "resolving-assets", "rendering-assets", "preflighting"] as const) {
    if (!registry.transition(created.jobId, state)) throw new Error(`transition to ${state} failed`);
  }
  const begun = registry.beginPreflight(created.jobId);
  if (!begun) throw new Error("begin preflight failed");
  return { created, preflightId: begun.preflightId };
}

function preflight(jobId: string, preflightId: string, candidates: string[]): OutputPreflightResult {
  return {
    preflightId,
    jobId,
    documentId: "document-1",
    sourceHash,
    workspaceRevision: 1,
    status: candidates.length > 0 ? "approval-required" : "ready",
    diagnostics: [],
    candidateOmittedReferenceKeys: candidates,
    nonOverridableDiagnosticIds: [],
  };
}

function outputResult(
  jobId: string,
  preflightId: string,
  status: OutputResult["status"],
  omitted: string[],
  approved: string[],
): OutputResult {
  return {
    jobId,
    preflightId,
    documentId: "document-1",
    target: "offline-html",
    sourceHash,
    workspaceRevision: 1,
    status,
    artifact: status.startsWith("completed")
      ? { kind: "file", displayName: "article.html", mimeType: "text/html", byteLength: 100 }
      : null,
    diagnostics: [],
    usedReferenceKeys: [],
    usedFormulaReferences: [],
    omittedReferenceKeys: omitted,
    approvedOmittedReferenceKeys: approved,
    derivedAssetManifest: {
      schema: "fantastic-editor-derived-asset-manifest",
      jobId,
      sourceHash,
      workspaceRevision: 1,
      entries: {},
    },
    timing: { startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:00.100Z", durationMs: 100 },
  };
}

describe("OutputJobRegistry", () => {
  it("enforces the fixed forward lifecycle and rejects state jumps", () => {
    const registry = new OutputJobRegistry();
    const created = registry.create({ documentId: "document-1", target: "pdf", sourceHash, workspaceRevision: 1 });
    expect(registry.transition(created.jobId, "generating")).toBeUndefined();
    expect(registry.transition(created.jobId, "parsing")?.state).toBe("parsing");
    expect(registry.transition(created.jobId, "resolving-assets")?.state).toBe("resolving-assets");
  });

  it("requires exact omission approval identity and complete candidate set", () => {
    const registry = new OutputJobRegistry();
    const { created, preflightId } = reachPreflight(registry);
    expect(registry.acceptPreflight(preflight(created.jobId, preflightId, [omittedA, omittedB]))?.state)
      .toBe("awaiting-user-approval");
    expect(registry.approve({
      preflightId,
      jobId: created.jobId,
      documentId: "document-1",
      sourceHash,
      workspaceRevision: 1,
      approvedOmittedReferenceKeys: [omittedA],
    })).toBeUndefined();
    expect(registry.approve({
      preflightId,
      jobId: created.jobId,
      documentId: "document-1",
      sourceHash,
      workspaceRevision: 1,
      approvedOmittedReferenceKeys: [omittedB, omittedA],
    })?.state).toBe("ready");
  });

  it("never reports partial output as complete success", () => {
    const registry = new OutputJobRegistry();
    const { created, preflightId } = reachPreflight(registry);
    registry.acceptPreflight(preflight(created.jobId, preflightId, [omittedA]));
    registry.approve({
      preflightId,
      jobId: created.jobId,
      documentId: "document-1",
      sourceHash,
      workspaceRevision: 1,
      approvedOmittedReferenceKeys: [omittedA],
    });
    registry.transition(created.jobId, "generating");
    expect(registry.finalize(outputResult(created.jobId, preflightId, "completed", [omittedA], [omittedA])))
      .toBeUndefined();
    expect(registry.finalize(outputResult(created.jobId, preflightId, "completed-with-omissions", [omittedA], [omittedA]))?.state)
      .toBe("completed-with-omissions");
  });

  it("drops late results after cancellation", () => {
    const registry = new OutputJobRegistry();
    const { created, preflightId } = reachPreflight(registry);
    registry.acceptPreflight(preflight(created.jobId, preflightId, []));
    registry.transition(created.jobId, "generating");
    expect(registry.cancel(created.jobId)?.state).toBe("cancelled");
    expect(registry.finalize(outputResult(created.jobId, preflightId, "completed", [], []))).toBeUndefined();
  });
});