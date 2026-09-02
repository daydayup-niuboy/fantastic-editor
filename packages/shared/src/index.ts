import type { Diagnostic, ParsedDocument, ResourceReference } from "@fantastic-editor/document-core";
export { FANTASTIC_EDITOR_LIMITS, IPC_CHANNELS } from "./runtime.js";
export {
  OFFICIAL_WECHAT_THEME_IDS,
  WECHAT_CUSTOM_THEME_ID_RE,
  WECHAT_THEME_OPTIONS,
  OFFICIAL_THEME_TOKENS,
  applyOfficialWechatThemeToFragment,
  applyWechatThemeToFragment,
  buildDeepBlueTechRecipe,
  buildMinimalInkRecipe,
  buildWechatNativeEnhancedRecipe,
  buildWechatThemeDefinition,
  canonicalWechatThemeIdentity,
  canonicalWechatThemeJson,
  normalizeOfficialWechatThemeId,
  normalizeWechatThemeTokens,
  resolveOfficialWechatTheme,
  resolveWechatTheme,
  validateWechatThemeName,
  WechatThemeError,
} from "./wechat-themes.js";
export type {
  OfficialWechatThemeId,
  LegacyWechatThemeAlias,
  WechatThemeDefinition,
  WechatThemeErrorCode,
  WechatThemeId,
  WechatThemeListItem,
  WechatThemeOverlayFile,
  WechatThemeOverlayInput,
  WechatThemeOverlayPatch,
  WechatThemeRecipe,
  WechatThemeStyleTag,
  WechatThemeTokens,
  ResolvedWechatTheme,
} from "./wechat-themes.js";
export { compileWechatPublishHtml, normalizeWechatHtmlMarkup } from "./wechat-theme-compiler.js";
export type { CompileWechatPublishHtmlInput } from "./wechat-theme-compiler.js";
import type {
  ResolvedWechatTheme,
  WechatThemeDefinition,
  WechatThemeId,
  WechatThemeListItem,
  WechatThemeOverlayFile,
  WechatThemeOverlayInput,
} from "./wechat-themes.js";
export { auditGeneratedHtmlMarkup, auditWechatHtmlMarkup } from "@fantastic-editor/document-core";
export type { GeneratedHtmlSecurityIssue } from "@fantastic-editor/document-core";

export type LineSeparator = "lf" | "crlf" | "mixed";
export type TextEncoding = "utf-8" | "utf-8-bom";
export type WorkspaceMode = "single-file" | "folder-workspace";

export interface FileFingerprint {
  byteLength: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface OpenFileResult {
  status: "opened" | "cancelled" | "failed";
  session?: {
    sessionId: string;
    documentId: string;
    workspaceId: string;
    workspaceRevision: number;
    workspaceMode: WorkspaceMode;
    displayName: string;
    editorText: string;
    encoding: TextEncoding;
    lineSeparator: LineSeparator;
    fingerprint: FileFingerprint;
    isUntitled: boolean;
    savedText?: string;
    recovered?: boolean;
    requiresSave?: boolean;
  };
  error?: string;
}

export interface FileSessionRequest {
  sessionId: string;
}

export interface RecentFileEntry {
  recentId: string;
  displayName: string;
  lastOpenedAt: string;
}

export type RecentFilesResult =
  | { status: "listed"; items: RecentFileEntry[] }
  | { status: "failed"; error: string };

export interface OpenRecentFileRequest { recentId: string; }

export interface ExternalMarkdownOpenRequest {
  requestId: string;
  displayName: string;
}

export interface ExternalMarkdownOpenResult {
  status: "opened" | "cancelled" | "failed";
  session?: OpenFileResult["session"];
  error?: string;
}

export type FileSessionCommandResult =
  | { status: "activated" | "closed" }
  | { status: "failed"; error: string };
export interface PersistRecoveryRequest {
  activeSessionId: string | null;
  tabs: Array<{ sessionId: string; editorText: string }>;
}

export type PersistRecoveryResult =
  | { status: "persisted" | "cleared" }
  | { status: "failed"; error: string };

export type RestoreRecoveryResult =
  | { status: "empty" }
  | { status: "restored"; documents: OpenFileResult[]; activeSessionId: string | null; warnings: string[] }
  | { status: "failed"; error: string };
export interface WorkspaceFileEntry {
  fileId: string;
  relativePath: string;
  displayName: string;
}

export interface OpenFolderResult {
  status: "opened" | "cancelled" | "failed";
  workspace?: {
    workspaceId: string;
    workspaceRevision: number;
    displayName: string;
    files: WorkspaceFileEntry[];
    warnings: string[];
  };
  error?: string;
}

export interface OpenWorkspaceFileRequest {
  workspaceId: string;
  workspaceRevision: number;
  fileId: string;
}

export interface RenameWorkspaceFileRequest {
  workspaceId: string;
  workspaceRevision: number;
  fileId: string;
  newName: string;
}

export type RenameWorkspaceFileResult =
  | { status: "renamed"; workspaceRevision: number; file: WorkspaceFileEntry }
  | { status: "failed"; error: string };

export interface RenameOpenFileRequest {
  sessionId: string;
  newName: string;
}

export type RenameOpenFileResult =
  | { status: "renamed"; displayName: string; workspaceRevision: number; file?: WorkspaceFileEntry }
  | { status: "failed"; error: string };

export interface SaveFileRequest {
  sessionId: string;
  editorText: string;
  allowOverwriteExternalChanges?: boolean;
}

export interface SaveFileResult {
  status: "saved" | "cancelled" | "conflict" | "failed";
  displayName?: string;
  fingerprint?: FileFingerprint;
  workspaceRevision?: number;
  workspaceMode?: WorkspaceMode;
  error?: string;
}

export interface ImageImportSessionRequest {
  importRequestId: string;
  sessionId: string;
  documentId: string;
  workspaceRevision: number;
}

export interface DroppedImageFile {
  displayName: string;
  declaredMimeType: string;
  bytes: Uint8Array;
}

export interface ImportDroppedImagesRequest extends ImageImportSessionRequest {
  files: DroppedImageFile[];
}

export interface ImportedAssetReceipt {
  importRequestId: string;
  documentId: string;
  sessionId: string;
  workspaceRevision: number;
  relativeRef: string;
  displayName: string;
  mimeType: string;
  byteLength: number;
  contentHash: string;
  reusedExisting: boolean;
}

export type ImportImagesResult =
  | { status: "imported"; receipts: ImportedAssetReceipt[]; workspaceRevision: number }
  | { status: "cancelled" }
  | { status: "failed"; error: string };
export interface ParseCommitRequest {
  documentId: string;
  sourceHash: string;
  parserProfile: string;
  taskSequence: number;
}

export interface ParseCommitResult {
  status: "committed" | "rejected";
  documentId: string;
  sourceHash: string;
  parserProfile: string;
  taskSequence: number;
  parseCommitId?: string;
  workspaceRevision?: number;
  error?: string;
}

export type ResolutionState =
  | "resolved"
  | "missing"
  | "blocked"
  | "ambiguous"
  | "unsupported"
  | "failed";

export interface ResourceFileFingerprint {
  byteLength: number;
  mtimeNs: string;
  ctimeNs: string;
  fileId: string | null;
}

export interface ResolutionRecord {
  referenceKey: string;
  workspaceRevision: number;
  assetCacheKey: string | null;
  fileFingerprint: ResourceFileFingerprint | null;
  originalRef: string;
  resolvedRef: string;
  workspaceRelativePath: string | null;
  mimeType: string | null;
  byteLength: number | null;
  contentHash: string | null;
  width: number | null;
  height: number | null;
  state: ResolutionState;
  candidates: string[];
  assetHandle: string | null;
  securityFlags: string[];
}

export interface ResolutionSnapshot {
  schema: "fantastic-editor-resolution-snapshot";
  documentId: string;
  sourceHash: string;
  workspaceId: string;
  workspaceRevision: number;
  resolverProfile: string;
  records: Record<string, ResolutionRecord>;
  diagnostics: Diagnostic[];
  createdAt: string;
}

export interface PreviewDerivedEntry {
  referenceKey: string;
  sourceContentHash: string;
  transformProfile: string;
  previewAssetHandle: string;
  mimeType: string;
  width: number | null;
  height: number | null;
}

export interface PreviewDerivedManifest {
  schema: "fantastic-editor-preview-derived-manifest";
  documentId: string;
  sourceHash: string;
  parserProfile: string;
  taskSequence: number;
  parseCommitId: string;
  workspaceRevision: number;
  manifestRevision: number;
  entries: Record<string, PreviewDerivedEntry>;
}

export interface PreviewDerivedUpdate {
  documentId: string;
  sourceHash: string;
  parserProfile: string;
  taskSequence: number;
  parseCommitId: string;
  workspaceRevision: number;
  manifestRevision: number;
  entries: Record<string, PreviewDerivedEntry>;
  diagnostics: Diagnostic[];
}

export interface PreviewSession {
  schema: "fantastic-editor-preview-session";
  documentId: string;
  sourceHash: string;
  workspaceRevision: number;
  parsedDocument: ParsedDocument;
  resolutionSnapshot: ResolutionSnapshot;
  previewDerivedManifest: PreviewDerivedManifest;
  diagnostics: Diagnostic[];
}

export interface ResolveRequest {
  documentId: string;
  sourceHash: string;
  parserProfile: string;
  taskSequence: number;
  parseCommitId: string;
  workspaceRevision: number;
  resourceReferences: ResourceReference[];
}

export interface ResolveResult {
  status: "resolved" | "rejected";
  documentId: string;
  sourceHash: string;
  parserProfile: string;
  taskSequence: number;
  parseCommitId: string;
  workspaceRevision: number;
  resolutionSnapshot?: ResolutionSnapshot;
  previewDerivedManifest?: PreviewDerivedManifest;
  diagnostics: Diagnostic[];
  error?: string;
}

export type OutputTarget = "pdf" | "docx" | "offline-html" | "wechat-html" | "wechat-clipboard";
export type OutputResultStatus = "completed" | "completed-with-omissions" | "failed" | "cancelled" | "timed-out";
export type OutputJobState =
  | "created"
  | "parsing"
  | "resolving-assets"
  | "rendering-assets"
  | "preflighting"
  | "awaiting-user-approval"
  | "ready"
  | "generating"
  | OutputResultStatus;

export interface DerivedAssetEntry {
  derivedAssetKey: string;
  sourceReferenceKey: string | null;
  sourceContentHash: string | null;
  transformProfile: string;
  derivedContentHash: string;
  mimeType: string;
  width: number | null;
  height: number | null;
}

export interface DerivedAssetManifest {
  schema: "fantastic-editor-derived-asset-manifest";
  jobId: string;
  sourceHash: string;
  workspaceRevision: number;
  entries: Record<string, DerivedAssetEntry>;
}

export interface OutputTheme {
  id: string;
  tokens: Record<string, string | number>;
  baseThemeId?: string;
  definition?: WechatThemeDefinition;
}

export interface OutputPreflightContext {
  jobId: string;
  documentId: string;
  target: OutputTarget;
  sourceHash: string;
  workspaceRevision: number;
  preflightId: string;
  parsedDocument: ParsedDocument;
  resolutionSnapshot: ResolutionSnapshot;
  derivedAssetManifest: DerivedAssetManifest;
  theme: OutputTheme;
  locale: string;
  options: Record<string, unknown>;
}

export interface OutputPreflightResult {
  preflightId: string;
  jobId: string;
  documentId: string;
  sourceHash: string;
  workspaceRevision: number;
  status: "ready" | "approval-required" | "failed";
  diagnostics: Diagnostic[];
  candidateOmittedReferenceKeys: string[];
  nonOverridableDiagnosticIds: string[];
}

export interface ApproveOmissions {
  preflightId: string;
  jobId: string;
  documentId: string;
  sourceHash: string;
  workspaceRevision: number;
  approvedOmittedReferenceKeys: string[];
}

export interface OutputContext extends OutputPreflightContext {
  approvedOmittedReferenceKeys: string[];
}

export interface OutputArtifact {
  kind: "file" | "clipboard";
  displayName: string;
  mimeType: string;
  byteLength: number;
}

export interface WechatReplacementItem {
  itemId: string;
  sequence: number;
  kind: "image" | "formula" | "diagram";
  placement: "inline" | "block";
  label: string;
  placeholderText: string;
  sourceOffset: number;
  mimeType: string;
  width: number | null;
  height: number | null;
}

export interface CopyWechatReplacementRequest {
  jobId: string;
  itemId: string;
}

export type CopyWechatReplacementResult =
  | { status: "copied"; itemId: string }
  | { status: "failed"; error: string };

export interface CreateWechatDraftRequest {
  jobId: string;
}

export type CreateWechatDraftResult =
  | { status: "created"; draftMediaId: string; uploadedImageCount: number; verified: true }
  | { status: "failed"; error: string; uploadedImageCount?: number };

export interface PublishWechatArticleRequest {
  jobId: string;
}

export type PublishWechatArticleResult =
  | { status: "published"; draftMediaId: string; publishId: string; articleUrl: string | null; verified: true }
  | { status: "processing"; draftMediaId: string; publishId: string; message: string }
  | { status: "failed"; error: string; draftMediaId?: string; publishId?: string };

export interface WechatApiConfigSummary {
  appId: string;
  hasAppSecret: boolean;
  coverPath: string;
  coverDisplayName: string | null;
  configured: boolean;
  source: "stored" | "environment" | "mixed" | "none";
}

export type GetWechatApiConfigResult =
  | { status: "loaded"; config: WechatApiConfigSummary }
  | { status: "failed"; error: string };

export type TestWechatApiConnectionResult =
  | { status: "ready"; ip: string | null; message: string }
  | { status: "whitelist-required"; ip: string; message: string }
  | { status: "failed"; error: string };

export interface SaveWechatApiConfigRequest {
  appId: string;
  appSecret?: string;
  coverPath: string;
}

export type SaveWechatApiConfigResult =
  | { status: "saved"; config: WechatApiConfigSummary }
  | { status: "failed"; error: string };

export type SelectWechatCoverResult =
  | { status: "selected"; path: string; displayName: string }
  | { status: "cancelled" }
  | { status: "failed"; error: string };

export type ClearWechatApiConfigResult =
  | { status: "cleared"; config: WechatApiConfigSummary }
  | { status: "failed"; error: string };

export interface WechatAcceptanceConfirmation {
  bodyPasted: boolean;
  draftSaved: boolean;
  draftReopened: boolean;
  mobilePreviewed: boolean;
}

export interface SaveWechatAcceptanceReportRequest {
  jobId: string;
  confirmedReplacementItemIds: string[];
  confirmation: WechatAcceptanceConfirmation;
}

export type SaveWechatAcceptanceReportResult =
  | { status: "saved"; displayName: string }
  | { status: "cancelled" }
  | { status: "failed"; error: string };

export interface ListWechatThemesRequest { documentId: string; }
export type ListWechatThemesResult =
  | { status: "listed"; themes: WechatThemeListItem[] }
  | { status: "failed"; error: string };

export interface ResolveWechatThemeForPreviewRequest {
  documentId: string;
  themeId: string;
}
export type ResolveWechatThemeForPreviewResult =
  | { status: "resolved"; theme: ResolvedWechatTheme }
  | { status: "failed"; error: string };

export interface SaveWechatThemeAsCustomRequest {
  documentId: string;
  input: WechatThemeOverlayInput;
}
export type SaveWechatThemeAsCustomResult =
  | { status: "saved"; theme: ResolvedWechatTheme }
  | { status: "failed"; error: string };

export interface DeleteWechatThemeRequest {
  documentId: string;
  themeId: string;
  currentThemeId?: string;
}
export type DeleteWechatThemeResult =
  | { status: "deleted" }
  | { status: "failed"; error: string };

export interface ExportWechatThemeRequest {
  documentId: string;
  themeId: string;
}
export type ExportWechatThemeResult =
  | { status: "exported"; file: WechatThemeOverlayFile }
  | { status: "cancelled" }
  | { status: "failed"; error: string };

export interface ImportWechatThemeRequest {
  documentId: string;
  storage?: "workspace" | "global";
}
export type ImportWechatThemeResult =
  | { status: "imported"; theme: ResolvedWechatTheme }
  | { status: "cancelled" }
  | { status: "failed"; error: string };
export interface OutputTiming {
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

export interface OutputResult {
  jobId: string;
  documentId: string;
  target: OutputTarget;
  sourceHash: string;
  workspaceRevision: number;
  preflightId: string;
  status: OutputResultStatus;
  artifact: OutputArtifact | null;
  diagnostics: Diagnostic[];
  usedReferenceKeys: string[];
  usedFormulaReferences: string[];
  omittedReferenceKeys: string[];
  approvedOmittedReferenceKeys: string[];
  derivedAssetManifest: DerivedAssetManifest;
  wechatReplacementItems?: WechatReplacementItem[];
  wechatSuggestedTitle?: string;
  wechatThemeId?: WechatThemeId;
  timing: OutputTiming;
}

export interface OutputJobIdentity {
  jobId: string;
  documentId: string;
  target: OutputTarget;
  sourceHash: string;
  workspaceRevision: number;
}

export interface OutputJobSnapshot extends OutputJobIdentity {
  state: OutputJobState;
  preflightId: string | null;
  candidateOmittedReferenceKeys: string[];
  approvedOmittedReferenceKeys: string[];
  result: OutputResult | null;
}

export interface BeginOutputRequest {
  documentId: string;
  target: OutputTarget;
  sourceHash: string;
  parserProfile: string;
  taskSequence: number;
  parseCommitId: string;
  workspaceRevision: number;
  parsedDocument: ParsedDocument;
  fontFamily?: string;
  darkMode?: boolean;
  wechatThemeId?: WechatThemeId;
}

export interface OutputCommandResult {
  status: OutputResultStatus | "approval-required";
  job?: OutputJobSnapshot;
  preflight?: OutputPreflightResult;
  result?: OutputResult;
  error?: string;
}

export interface CancelOutputRequest {
  jobId: string;
}

export interface FantasticEditorApi {
  openMarkdownFile(): Promise<OpenFileResult>;
  listRecentFiles(): Promise<RecentFilesResult>;
  openRecentFile(request: OpenRecentFileRequest): Promise<OpenFileResult>;
  createUntitledFile(): Promise<OpenFileResult>;
  openDroppedMarkdownFile(file: unknown): Promise<OpenFileResult>;
  listExternalOpenRequests(): Promise<ExternalMarkdownOpenRequest[]>;
  openExternalFile(request: { requestId: string }): Promise<OpenFileResult>;
  discardExternalOpenRequest(request: { requestId: string }): Promise<{ status: "discarded" | "missing" }>;
  activateFileSession(request: FileSessionRequest): Promise<FileSessionCommandResult>;
  closeFileSession(request: FileSessionRequest): Promise<FileSessionCommandResult>;
  persistRecoverySession(request: PersistRecoveryRequest): Promise<PersistRecoveryResult>;
  restoreRecoverySession(): Promise<RestoreRecoveryResult>;
  openWorkspaceFolder(): Promise<OpenFolderResult>;
  openWorkspaceFile(request: OpenWorkspaceFileRequest): Promise<OpenFileResult>;
  renameWorkspaceFile(request: RenameWorkspaceFileRequest): Promise<RenameWorkspaceFileResult>;
  renameOpenFile(request: RenameOpenFileRequest): Promise<RenameOpenFileResult>;
  saveCurrentFile(request: SaveFileRequest): Promise<SaveFileResult>;
  saveCurrentFileAs(request: SaveFileRequest): Promise<SaveFileResult>;
  selectAndImportImages(request: ImageImportSessionRequest): Promise<ImportImagesResult>;
  importDroppedImages(request: ImageImportSessionRequest, files: unknown[]): Promise<ImportImagesResult>;
  commitParse(request: ParseCommitRequest): Promise<ParseCommitResult>;
  resolveResources(request: ResolveRequest): Promise<ResolveResult>;
  onPreviewDerivedUpdate(listener: (update: PreviewDerivedUpdate) => void): () => void;
  beginOutput(request: BeginOutputRequest): Promise<OutputCommandResult>;
  approveOutputOmissions(request: ApproveOmissions): Promise<OutputCommandResult>;
  cancelOutput(request: CancelOutputRequest): Promise<OutputCommandResult>;
  copyWechatReplacement(request: CopyWechatReplacementRequest): Promise<CopyWechatReplacementResult>;
  createWechatDraft(request: CreateWechatDraftRequest): Promise<CreateWechatDraftResult>;
  publishWechatArticle(request: PublishWechatArticleRequest): Promise<PublishWechatArticleResult>;
  getWechatApiConfig(): Promise<GetWechatApiConfigResult>;
  testWechatApiConnection(): Promise<TestWechatApiConnectionResult>;
  saveWechatApiConfig(request: SaveWechatApiConfigRequest): Promise<SaveWechatApiConfigResult>;
  selectWechatCover(): Promise<SelectWechatCoverResult>;
  clearWechatApiConfig(): Promise<ClearWechatApiConfigResult>;
  saveWechatAcceptanceReport(request: SaveWechatAcceptanceReportRequest): Promise<SaveWechatAcceptanceReportResult>;
  listWechatThemes(request: ListWechatThemesRequest): Promise<ListWechatThemesResult>;
  resolveWechatThemeForPreview(request: ResolveWechatThemeForPreviewRequest): Promise<ResolveWechatThemeForPreviewResult>;
  saveWechatThemeAsCustom(request: SaveWechatThemeAsCustomRequest): Promise<SaveWechatThemeAsCustomResult>;
  deleteWechatTheme(request: DeleteWechatThemeRequest): Promise<DeleteWechatThemeResult>;
  exportWechatTheme(request: ExportWechatThemeRequest): Promise<ExportWechatThemeResult>;
  importWechatTheme(request: ImportWechatThemeRequest): Promise<ImportWechatThemeResult>;
}
