import { randomUUID } from "node:crypto";
import type {
  ParseCommitRequest,
  ParseCommitResult,
  ResolveRequest,
} from "@fantastic-editor/shared";
import type { SingleFileResolutionContext } from "./file-sessions.js";

interface ParseCommitRecord {
  documentId: string;
  sourceHash: string;
  parserProfile: string;
  taskSequence: number;
  parseCommitId: string;
  workspaceRevision: number;
}

function rejected(request: ParseCommitRequest, error: string): ParseCommitResult {
  return {
    status: "rejected",
    documentId: request.documentId,
    sourceHash: request.sourceHash,
    parserProfile: request.parserProfile,
    taskSequence: request.taskSequence,
    error,
  };
}

export class ParseCommitRegistry {
  readonly #records = new Map<string, ParseCommitRecord>();

  clear(): void { this.#records.clear(); }

  commit(
    request: ParseCommitRequest,
    context: SingleFileResolutionContext | undefined,
  ): ParseCommitResult {
    if (!context || context.documentId !== request.documentId) {
      return rejected(request, "文档会话不存在或已经结束。");
    }
    if (!/^[a-f\d]{64}$/i.test(request.sourceHash)) {
      return rejected(request, "sourceHash 格式无效。");
    }
    if (!request.parserProfile || request.parserProfile.length > 128) {
      return rejected(request, "parserProfile 无效。");
    }
    if (!Number.isSafeInteger(request.taskSequence) || request.taskSequence <= 0) {
      return rejected(request, "taskSequence 无效。");
    }

    const current = this.#records.get(request.documentId);
    if (current && request.taskSequence < current.taskSequence) {
      return rejected(request, "解析任务已经过期。");
    }
    if (
      current
      && request.taskSequence === current.taskSequence
      && current.sourceHash === request.sourceHash
      && current.parserProfile === request.parserProfile
      && current.workspaceRevision === context.workspaceRevision
    ) {
      return { status: "committed", ...current };
    }
    if (current && request.taskSequence === current.taskSequence) {
      return rejected(request, "同一 taskSequence 的解析身份不一致。");
    }

    const record: ParseCommitRecord = {
      documentId: request.documentId,
      sourceHash: request.sourceHash,
      parserProfile: request.parserProfile,
      taskSequence: request.taskSequence,
      parseCommitId: randomUUID(),
      workspaceRevision: context.workspaceRevision,
    };
    this.#records.set(request.documentId, record);
    return { status: "committed", ...record };
  }

  acceptsResolve(request: ResolveRequest, context: SingleFileResolutionContext | undefined): boolean {
    const record = this.#records.get(request.documentId);
    return Boolean(
      record
      && context
      && record.documentId === context.documentId
      && record.sourceHash === request.sourceHash
      && record.parserProfile === request.parserProfile
      && record.taskSequence === request.taskSequence
      && record.parseCommitId === request.parseCommitId
      && record.workspaceRevision === request.workspaceRevision
      && context.workspaceRevision === request.workspaceRevision,
    );
  }
}