import { FANTASTIC_EDITOR_LIMITS } from "@fantastic-editor/shared";
import {
  PARSER_PROFILE,
  canonicalizeEditorText,
  sha256,
} from "@fantastic-editor/document-core";
import type { ParseWorkerRequest, ParseWorkerResponse } from "./parse-worker-protocol";

export interface ParseWorkerLike {
  onmessage: ((event: MessageEvent<ParseWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: ParseWorkerRequest): void;
  terminate(): void;
}

interface ExpectedParseIdentity {
  taskSequence: number;
  documentId: string;
  parserProfile: string;
  sourceHash: string;
}

export class ParseResultGate {
  #expected: ExpectedParseIdentity = {
    taskSequence: 0,
    documentId: "",
    parserProfile: PARSER_PROFILE,
    sourceHash: "",
  };

  begin(documentId: string, parserProfile = PARSER_PROFILE): number {
    this.#expected = {
      taskSequence: this.#expected.taskSequence + 1,
      documentId,
      parserProfile,
      sourceHash: "",
    };
    return this.#expected.taskSequence;
  }

  bindSourceHash(taskSequence: number, documentId: string, parserProfile: string, sourceHash: string): boolean {
    if (
      this.#expected.taskSequence !== taskSequence
      || this.#expected.documentId !== documentId
      || this.#expected.parserProfile !== parserProfile
    ) return false;
    this.#expected.sourceHash = sourceHash;
    return true;
  }

  accepts(response: ParseWorkerResponse): boolean {
    return response.taskSequence === this.#expected.taskSequence
      && response.documentId === this.#expected.documentId
      && response.parserProfile === this.#expected.parserProfile
      && response.sourceHash === this.#expected.sourceHash;
  }

  invalidate(): void {
    this.#expected = {
      taskSequence: this.#expected.taskSequence + 1,
      documentId: "",
      parserProfile: this.#expected.parserProfile,
      sourceHash: "",
    };
  }
}

export interface ParseWorkerClientHandlers {
  onResult(response: ParseWorkerResponse): void;
  onWorkerError(message: string): void;
}

export type ParseWorkerFactory = () => ParseWorkerLike;

function createBrowserWorker(): ParseWorkerLike {
  return new Worker(new URL("./parse.worker.ts", import.meta.url), {
    type: "module",
    name: "fantastic-editor-document-core",
  });
}

export class ParseWorkerClient {
  #worker: ParseWorkerLike;
  readonly #workerFactory: ParseWorkerFactory | undefined;
  readonly #gate = new ParseResultGate();
  readonly #handlers: ParseWorkerClientHandlers;
  #hasPendingTask = false;
  #disposed = false;

  constructor(
    handlers: ParseWorkerClientHandlers,
    worker?: ParseWorkerLike,
    workerFactory?: ParseWorkerFactory,
  ) {
    this.#handlers = handlers;
    this.#workerFactory = workerFactory ?? (worker ? undefined : createBrowserWorker);
    this.#worker = worker ?? this.#workerFactory!();
    this.#attachWorker();
  }

  async parse(documentId: string, editorText: string, parserProfile = PARSER_PROFILE): Promise<number> {
    if (this.#disposed) throw new Error("ParseWorkerClient has been disposed.");
    const taskSequence = this.#gate.begin(documentId, parserProfile);
    const canonicalText = canonicalizeEditorText(editorText);
    if (canonicalText.length > FANTASTIC_EDITOR_LIMITS.maxSourceCharacters) {
      throw new Error("文档超过 1,000 万字符编辑上限；请缩小文档后继续解析。");
    }
    const sourceHash = await sha256(canonicalText);
    if (this.#disposed || !this.#gate.bindSourceHash(taskSequence, documentId, parserProfile, sourceHash)) {
      return taskSequence;
    }
    if (this.#hasPendingTask && this.#workerFactory && !this.#restartWorker()) {
      throw new Error("无法重启解析 Worker；旧的大文档解析任务已取消。" );
    }
    this.#worker.postMessage({
      type: "parse",
      documentId,
      editorText: canonicalText,
      sourceHash,
      parserProfile,
      taskSequence,
    });
    this.#hasPendingTask = true;
    return taskSequence;
  }

  isCurrent(response: ParseWorkerResponse): boolean {
    return !this.#disposed && this.#gate.accepts(response);
  }

  invalidate(): void {
    this.#gate.invalidate();
    if (this.#hasPendingTask && this.#workerFactory) this.#restartWorker();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#gate.invalidate();
    this.#hasPendingTask = false;
    this.#worker.onmessage = null;
    this.#worker.onerror = null;
    this.#worker.terminate();
  }

  #attachWorker(): void {
    this.#worker.onmessage = (event) => {
      if (this.#disposed || !this.#gate.accepts(event.data)) return;
      this.#hasPendingTask = false;
      this.#handlers.onResult(event.data);
    };
    this.#worker.onerror = (event) => {
      if (this.#disposed) return;
      this.#hasPendingTask = false;
      this.#handlers.onWorkerError(event.message || "解析 Worker 发生错误。");
    };
  }

  #restartWorker(): boolean {
    const factory = this.#workerFactory;
    if (!factory || this.#disposed) return false;
    this.#worker.onmessage = null;
    this.#worker.onerror = null;
    this.#worker.terminate();
    try {
      this.#worker = factory();
      this.#hasPendingTask = false;
      this.#attachWorker();
      return true;
    } catch (error) {
      this.#hasPendingTask = false;
      this.#handlers.onWorkerError(error instanceof Error ? error.message : "无法重启解析 Worker。");
      return false;
    }
  }
}

