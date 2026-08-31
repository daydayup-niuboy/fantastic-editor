import { describe, expect, it, vi } from "vitest";
import type { ParsedDocument } from "@fantastic-editor/document-core";
import { PARSER_PROFILE } from "@fantastic-editor/document-core";
import {
  ParseWorkerClient,
  type ParseWorkerLike,
} from "./parse-worker-client";
import type { ParseWorkerRequest, ParseWorkerResponse } from "./parse-worker-protocol";

class FakeWorker implements ParseWorkerLike {
  onmessage: ((event: MessageEvent<ParseWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posted: ParseWorkerRequest[] = [];
  terminated = false;

  postMessage(message: ParseWorkerRequest): void { this.posted.push(message); }
  terminate(): void { this.terminated = true; }
  emit(message: ParseWorkerResponse): void {
    this.onmessage?.({ data: message } as MessageEvent<ParseWorkerResponse>);
  }
}

function parsedResponse(request: ParseWorkerRequest): ParseWorkerResponse {
  return {
    type: "parsed",
    parseDurationMs: 1,
    documentId: request.documentId,
    sourceHash: request.sourceHash,
    parserProfile: request.parserProfile,
    taskSequence: request.taskSequence,
    parsedDocument: {
      schema: "fantastic-editor-parsed-document",
      udmVersion: "0.5",
      parserProfile: request.parserProfile,
      documentId: request.documentId,
      sourceHash: request.sourceHash,
      sourceLength: request.editorText.length,
      metadata: {}, children: [], resourceReferences: [], diagnostics: [],
      statistics: { headings: 0, images: 0, formulas: 0, characters: request.editorText.length },
    } satisfies ParsedDocument,
    diagnostics: [],
    previewHtml: `<p>${request.editorText}</p>`,
  };
}

describe("ParseWorkerClient", () => {
  it("drops results from older tasks after rapid edits", async () => {
    const worker = new FakeWorker();
    const onResult = vi.fn();
    const client = new ParseWorkerClient({ onResult, onWorkerError: vi.fn() }, worker);
    await client.parse("doc-1", "first");
    await client.parse("doc-1", "second");
    expect(worker.posted.map((item) => item.taskSequence)).toEqual([1, 2]);
    expect(worker.posted.every((item) => /^[a-f\d]{64}$/.test(item.sourceHash))).toBe(true);
    worker.emit(parsedResponse(worker.posted[0]!));
    worker.emit(parsedResponse(worker.posted[1]!));
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult.mock.calls[0]?.[0].taskSequence).toBe(2);
  });

  it("drops results from a previous document session", async () => {
    const worker = new FakeWorker();
    const onResult = vi.fn();
    const client = new ParseWorkerClient({ onResult, onWorkerError: vi.fn() }, worker);
    await client.parse("doc-old", "old");
    await client.parse("doc-new", "new");
    worker.emit(parsedResponse(worker.posted[0]!));
    expect(onResult).not.toHaveBeenCalled();
    worker.emit(parsedResponse(worker.posted[1]!));
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it("terminates an in-flight worker when a newer large-document parse invalidates it", async () => {
    const first = new FakeWorker();
    const replacements: FakeWorker[] = [];
    const client = new ParseWorkerClient(
      { onResult: vi.fn(), onWorkerError: vi.fn() },
      first,
      () => {
        const worker = new FakeWorker();
        replacements.push(worker);
        return worker;
      },
    );
    await client.parse("doc", "large first draft");
    expect(first.posted).toHaveLength(1);
    client.invalidate();
    expect(first.terminated).toBe(true);
    expect(replacements).toHaveLength(1);
    await client.parse("doc", "new draft");
    expect(replacements[0]!.posted).toHaveLength(1);
    expect(replacements[0]!.posted[0]!.editorText).toBe("new draft");
  });
  it("rejects mismatched parser profiles and late messages after disposal", async () => {
    const worker = new FakeWorker();
    const onResult = vi.fn();
    const client = new ParseWorkerClient({ onResult, onWorkerError: vi.fn() }, worker);
    await client.parse("doc", "text", PARSER_PROFILE);
    const response = parsedResponse(worker.posted[0]!);
    worker.emit({ ...response, parserProfile: "stale-profile" });
    expect(onResult).not.toHaveBeenCalled();
    client.dispose();
    worker.emit(response);
    expect(onResult).not.toHaveBeenCalled();
    expect(worker.terminated).toBe(true);
  });
});
