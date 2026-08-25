export const UDM_VERSION = "0.5";
export const PARSER_PROFILE = "fantastic-editor-p0-markdown-0.1";

export type SourcePrecision = "exact" | "block";

export interface SourceRange {
  from: number;
  to: number;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  precision: SourcePrecision;
}

export type DiagnosticSeverity = "info" | "warning" | "error" | "blocking";
export type DiagnosticCategory =
  | "parse"
  | "syntax"
  | "resource"
  | "security"
  | "compatibility"
  | "export"
  | "performance";

export interface Diagnostic {
  id: string;
  code: string;
  severity: DiagnosticSeverity;
  category: DiagnosticCategory;
  message: string;
  source?: SourceRange;
  nodeId?: string;
  referenceKey?: string;
  outputTarget?: string;
  details?: Record<string, unknown>;
  suggestedActions?: string[];
}

export type ResourceKind =
  | "local-path"
  | "remote-http"
  | "data-uri"
  | "file-uri"
  | "app-internal"
  | "unsupported-scheme";

export type ResourceSyntax = "markdown-inline" | "markdown-reference" | "wiki-image";

export interface ResourceReference {
  referenceKey: string;
  nodeId: string;
  source: SourceRange;
  kind: ResourceKind;
  syntax: ResourceSyntax;
  originalRef: string;
  resolvedRef: string;
  normalizedResolvedRef: string;
}

export type NodeType =
  | "text"
  | "softBreak"
  | "hardBreak"
  | "emphasis"
  | "strong"
  | "strikethrough"
  | "inlineCode"
  | "link"
  | "image"
  | "formulaInline"
  | "rawHtmlInline"
  | "unsupportedInline"
  | "heading"
  | "paragraph"
  | "blockquote"
  | "bulletList"
  | "orderedList"
  | "listItem"
  | "taskItem"
  | "codeBlock"
  | "table"
  | "tableHead"
  | "tableBody"
  | "tableRow"
  | "tableCell"
  | "thematicBreak"
  | "formulaBlock"
  | "rawHtmlBlock"
  | "unsupportedBlock";

export interface DocumentNode {
  id: string;
  type: NodeType;
  source: SourceRange;
  generated: boolean;
  attributes: Record<string, unknown>;
  children?: DocumentNode[];
}

export interface ParsedDocument {
  schema: "fantastic-editor-parsed-document";
  udmVersion: typeof UDM_VERSION;
  parserProfile: string;
  documentId: string;
  sourceHash: string;
  sourceLength: number;
  metadata: Record<string, unknown>;
  children: DocumentNode[];
  resourceReferences: ResourceReference[];
  diagnostics: Diagnostic[];
  statistics: {
    headings: number;
    images: number;
    formulas: number;
    characters: number;
  };
}

export interface ParseDocumentInput {
  editorText: string;
  documentId: string;
  parserProfile?: string;
}