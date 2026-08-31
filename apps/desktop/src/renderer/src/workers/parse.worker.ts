import { parseDocument, renderPreviewHtml } from "@fantastic-editor/document-core";
import type { ParseWorkerRequest, ParseWorkerResponse } from "./parse-worker-protocol";

interface WorkerScope {
  onmessage: ((event: MessageEvent<ParseWorkerRequest>) => void) | null;
  postMessage(message: ParseWorkerResponse): void;
}

const workerScope = self as unknown as WorkerScope;
workerScope.onmessage = (event) => {
  const request = event.data;
  if (request.type !== "parse") return;
  const startedAt = performance.now();
  void parseDocument({
    documentId: request.documentId,
    editorText: request.editorText,
    parserProfile: request.parserProfile,
  }).then((parsedDocument) => {
    if (parsedDocument.sourceHash !== request.sourceHash) {
      workerScope.postMessage({
        type: "parse-failed",
        documentId: request.documentId,
        sourceHash: request.sourceHash,
        parserProfile: request.parserProfile,
        taskSequence: request.taskSequence,
        errorCode: "SOURCE_HASH_MISMATCH",
        error: "Worker 重算的 sourceHash 与请求不一致。",
      });
      return;
    }
    workerScope.postMessage({
      type: "parsed",
      parseDurationMs: performance.now() - startedAt,
      documentId: request.documentId,
      sourceHash: parsedDocument.sourceHash,
      parserProfile: request.parserProfile,
      taskSequence: request.taskSequence,
      parsedDocument,
      diagnostics: parsedDocument.diagnostics,
      previewHtml: renderPreviewHtml(request.editorText, parsedDocument.resourceReferences),
    });
  }).catch((error: unknown) => {
    workerScope.postMessage({
      type: "parse-failed",
      documentId: request.documentId,
      sourceHash: request.sourceHash,
      parserProfile: request.parserProfile,
      taskSequence: request.taskSequence,
      errorCode: "PARSE_FAILED",
      error: error instanceof Error ? error.message : "Markdown 解析失败。",
    });
  });
};
