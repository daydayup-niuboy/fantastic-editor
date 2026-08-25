import { randomUUID } from "node:crypto";
import type {
  ApproveOmissions,
  OutputJobIdentity,
  OutputJobSnapshot,
  OutputJobState,
  OutputPreflightResult,
  OutputResult,
  OutputTarget,
} from "@fantastic-editor/shared";

interface OutputJobRecord extends OutputJobIdentity {
  state: OutputJobState;
  preflightId: string | null;
  preflight: OutputPreflightResult | null;
  candidateOmittedReferenceKeys: string[];
  approvedOmittedReferenceKeys: string[];
  result: OutputResult | null;
}

const TERMINAL = new Set<OutputJobState>(["completed", "completed-with-omissions", "failed", "cancelled", "timed-out"]);
const TRANSITIONS: Record<OutputJobState, ReadonlySet<OutputJobState>> = {
  created: new Set(["parsing", "failed", "cancelled", "timed-out"]),
  parsing: new Set(["resolving-assets", "failed", "cancelled", "timed-out"]),
  "resolving-assets": new Set(["rendering-assets", "failed", "cancelled", "timed-out"]),
  "rendering-assets": new Set(["preflighting", "failed", "cancelled", "timed-out"]),
  preflighting: new Set(["awaiting-user-approval", "ready", "failed", "cancelled", "timed-out"]),
  "awaiting-user-approval": new Set(["ready", "failed", "cancelled", "timed-out"]),
  ready: new Set(["generating", "failed", "cancelled", "timed-out"]),
  generating: new Set(["completed", "completed-with-omissions", "failed", "cancelled", "timed-out"]),
  completed: new Set(),
  "completed-with-omissions": new Set(),
  failed: new Set(),
  cancelled: new Set(),
  "timed-out": new Set(),
};

function canonicalKeys(keys: readonly string[]): string[] | undefined {
  if (keys.some((key) => !/^[a-f\d]{64}$/i.test(key))) return undefined;
  const unique = [...new Set(keys)].sort();
  return unique.length === keys.length ? unique : undefined;
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  const a = canonicalKeys(left);
  const b = canonicalKeys(right);
  return Boolean(a && b && a.length === b.length && a.every((key, index) => key === b[index]));
}

function snapshot(record: OutputJobRecord): OutputJobSnapshot {
  return {
    jobId: record.jobId,
    documentId: record.documentId,
    target: record.target,
    sourceHash: record.sourceHash,
    workspaceRevision: record.workspaceRevision,
    state: record.state,
    preflightId: record.preflightId,
    candidateOmittedReferenceKeys: [...record.candidateOmittedReferenceKeys],
    approvedOmittedReferenceKeys: [...record.approvedOmittedReferenceKeys],
    result: record.result,
  };
}

export class OutputJobRegistry {
  readonly #jobs = new Map<string, OutputJobRecord>();

  create(input: {
    documentId: string;
    target: OutputTarget;
    sourceHash: string;
    workspaceRevision: number;
  }): OutputJobSnapshot {
    if (!input.documentId || !/^[a-f\d]{64}$/i.test(input.sourceHash) || !Number.isInteger(input.workspaceRevision) || input.workspaceRevision < 1) {
      throw new Error("Invalid output job identity.");
    }
    const record: OutputJobRecord = {
      jobId: randomUUID(),
      ...input,
      state: "created",
      preflightId: null,
      preflight: null,
      candidateOmittedReferenceKeys: [],
      approvedOmittedReferenceKeys: [],
      result: null,
    };
    this.#jobs.set(record.jobId, record);
    return snapshot(record);
  }

  get(jobId: string): OutputJobSnapshot | undefined {
    const record = this.#jobs.get(jobId);
    return record ? snapshot(record) : undefined;
  }

  transition(jobId: string, next: OutputJobState): OutputJobSnapshot | undefined {
    const record = this.#jobs.get(jobId);
    if (!record || !TRANSITIONS[record.state].has(next)) return undefined;
    record.state = next;
    return snapshot(record);
  }

  beginPreflight(jobId: string): { job: OutputJobSnapshot; preflightId: string } | undefined {
    const record = this.#jobs.get(jobId);
    if (!record || record.state !== "preflighting" || record.preflightId) return undefined;
    record.preflightId = randomUUID();
    return { job: snapshot(record), preflightId: record.preflightId };
  }

  acceptPreflight(result: OutputPreflightResult): OutputJobSnapshot | undefined {
    const record = this.#jobs.get(result.jobId);
    const candidates = canonicalKeys(result.candidateOmittedReferenceKeys);
    if (
      !record
      || record.state !== "preflighting"
      || !record.preflightId
      || result.preflightId !== record.preflightId
      || result.documentId !== record.documentId
      || result.sourceHash !== record.sourceHash
      || result.workspaceRevision !== record.workspaceRevision
      || !candidates
      || (result.status === "ready" && candidates.length > 0)
      || (result.status === "approval-required" && (candidates.length === 0 || result.nonOverridableDiagnosticIds.length > 0))
    ) return undefined;
    record.preflight = { ...result, candidateOmittedReferenceKeys: candidates };
    record.candidateOmittedReferenceKeys = candidates;
    if (result.status === "failed") record.state = "failed";
    else if (result.status === "approval-required") record.state = "awaiting-user-approval";
    else record.state = "ready";
    return snapshot(record);
  }

  approve(request: ApproveOmissions): OutputJobSnapshot | undefined {
    const record = this.#jobs.get(request.jobId);
    const approved = canonicalKeys(request.approvedOmittedReferenceKeys);
    if (
      !record
      || record.state !== "awaiting-user-approval"
      || !record.preflight
      || request.preflightId !== record.preflightId
      || request.documentId !== record.documentId
      || request.sourceHash !== record.sourceHash
      || request.workspaceRevision !== record.workspaceRevision
      || !approved
      || !sameKeys(approved, record.candidateOmittedReferenceKeys)
    ) return undefined;
    record.approvedOmittedReferenceKeys = approved;
    record.state = "ready";
    return snapshot(record);
  }

  finalize(result: OutputResult): OutputJobSnapshot | undefined {
    const record = this.#jobs.get(result.jobId);
    if (
      !record
      || TERMINAL.has(record.state)
      || result.documentId !== record.documentId
      || result.target !== record.target
      || result.sourceHash !== record.sourceHash
      || result.workspaceRevision !== record.workspaceRevision
      || result.preflightId !== record.preflightId
      || !TRANSITIONS[record.state].has(result.status)
    ) return undefined;
    const omitted = canonicalKeys(result.omittedReferenceKeys);
    const approved = canonicalKeys(result.approvedOmittedReferenceKeys);
    if (!omitted || !approved) return undefined;
    if (result.status === "completed" && (omitted.length > 0 || approved.length > 0)) return undefined;
    if (
      result.status === "completed-with-omissions"
      && (omitted.length === 0 || !sameKeys(omitted, approved) || !sameKeys(approved, record.approvedOmittedReferenceKeys))
    ) return undefined;
    record.state = result.status;
    record.result = result;
    return snapshot(record);
  }

  cancel(jobId: string): OutputJobSnapshot | undefined {
    const record = this.#jobs.get(jobId);
    if (!record || TERMINAL.has(record.state)) return undefined;
    record.state = "cancelled";
    return snapshot(record);
  }

  timeOut(jobId: string): OutputJobSnapshot | undefined {
    const record = this.#jobs.get(jobId);
    if (!record || TERMINAL.has(record.state)) return undefined;
    record.state = "timed-out";
    return snapshot(record);
  }

  clear(): void {
    this.#jobs.clear();
  }
}