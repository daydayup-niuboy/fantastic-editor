import type { Diagnostic, ParsedDocument } from "@fantastic-editor/document-core";

export interface ParseWorkerRequest {
  type: "parse";
  documentId: string;
  editorText: string;
  sourceHash: string;
  parserProfile: string;
  taskSequence: number;
}

interface ParseWorkerIdentity {
  documentId: string;
  sourceHash: string;
  parserProfile: string;
  taskSequence: number;
}

export interface ParseWorkerSuccess extends ParseWorkerIdentity {
  type: "parsed";
  parseDurationMs: number;
  parsedDocument: ParsedDocument;
  diagnostics: Diagnostic[];
  previewHtml: string;
}

export interface ParseWorkerFailure extends ParseWorkerIdentity {
  type: "parse-failed";
  errorCode: "SOURCE_HASH_MISMATCH" | "PARSE_FAILED";
  error: string;
}

export type ParseWorkerResponse = ParseWorkerSuccess | ParseWorkerFailure;
