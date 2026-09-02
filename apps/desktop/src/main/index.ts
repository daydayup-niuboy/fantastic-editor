import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  protocol,
  safeStorage,
  session,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import { parseDocument } from "@fantastic-editor/document-core";
import {
  IPC_CHANNELS,
  type ApproveOmissions,
  type BeginOutputRequest,
  type CancelOutputRequest,
  type CopyWechatReplacementRequest,
  type CreateWechatDraftRequest,
  type FileSessionRequest,
  type ImageImportSessionRequest,
  type ImportDroppedImagesRequest,
  type OpenWorkspaceFileRequest,
  type RenameWorkspaceFileRequest,
  type RenameOpenFileRequest,
  type OpenRecentFileRequest,
  type OpenFileResult,
  type OutputContext,
  type ParseCommitRequest,
  type PersistRecoveryRequest,
  type ResolveRequest,
  type SaveFileRequest,
  type SaveWechatApiConfigRequest,
  type SaveWechatAcceptanceReportRequest,
  type PublishWechatArticleRequest,
  type WechatApiConfigSummary,
  type ListWechatThemesRequest,
  type ResolveWechatThemeForPreviewRequest,
  type SaveWechatThemeAsCustomRequest,
  type DeleteWechatThemeRequest,
  type ExportWechatThemeRequest,
  type ImportWechatThemeRequest,
} from "@fantastic-editor/shared";
import { atomicWriteCandidate, FileSessionManager, type FileOpenAttempt, type MarkdownOpenOptions } from "./file-sessions.js";
import { ParseCommitRegistry } from "./parse-commit-registry.js";
import { AssetHandleRegistry, SingleFileResourceResolver } from "./single-file-resource-resolver.js";
import { ASSET_SCHEME, parseAssetHandleUrl } from "./asset-protocol.js";
import { PreviewDerivedAssetCache } from "./preview-derived-cache.js";
import { ImageTransformProcess } from "./image-transform-process.js";
import { SvgPreviewCoordinator } from "./svg-preview-coordinator.js";
import { NodeOutputProcess } from "./node-output-process.js";
import { OutputService } from "./output-service.js";
import { FormulaRenderWindow } from "./formula-render-window.js";
import { MermaidRenderWindow } from "./mermaid-render-window.js";
import { PdfRenderWindow } from "./pdf-render-window.js";
import { RecoveryStore } from "./recovery-store.js";
import { auditWechatHtmlMarkup } from "./wechat-html-security.js";
import { ImageImportService } from "./image-import-service.js";
import { generateWechatAcceptanceReport } from "./wechat-acceptance-report.js";
import { RecentFileStore } from "./recent-files.js";
import { WechatDraftConnector, configFromEnvironment } from "./wechat-draft-connector.js";
import { WechatApiConfigStore } from "./wechat-api-config-store.js";
import { parseMarkdownOpenArgs } from "./external-open.js";
import { WechatThemeRepository } from "./wechat-theme-repository.js";


// Some Windows graphics drivers crash Chromium during startup with a native
// breakpoint exception (0x80000003). This editor does not require GPU-only
// rendering, so prefer a stable software compositor for the packaged build.
// Electron requires this to run before the app is ready.
app.disableHardwareAcceleration();
// A few Windows environments still start a broken out-of-process GPU helper
// even after hardware acceleration is disabled. Keeping the helper in-process
// avoids the native startup crash without weakening the renderer sandbox.
if (process.platform === "win32") app.commandLine.appendSwitch("in-process-gpu");

protocol.registerSchemesAsPrivileged([{
  scheme: ASSET_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: false,
  },
}]);

const fileSessions = new FileSessionManager();
const imageImportService = new ImageImportService(fileSessions);
const parseCommits = new ParseCommitRegistry();
const assetHandles = new AssetHandleRegistry();
const previewDerivedCache = new PreviewDerivedAssetCache();
const imageTransformProcess = new ImageTransformProcess();
const nodeOutputProcess = new NodeOutputProcess();
const formulaRenderWindow = new FormulaRenderWindow();
const mermaidRenderWindow = new MermaidRenderWindow();
const pdfRenderWindow = new PdfRenderWindow();
const resourceResolver = new SingleFileResourceResolver(parseCommits, assetHandles);
const svgPreviewCoordinator = new SvgPreviewCoordinator(assetHandles, previewDerivedCache, imageTransformProcess);
let mainWindow: BrowserWindow | null = null;
let recoveryStore: RecoveryStore | undefined;
let recentFileStore: RecentFileStore | undefined;
let wechatApiConfigStore: WechatApiConfigStore | undefined;
const wechatDraftConnector = new WechatDraftConnector();
const wechatPublishRecords = new Map<string, { status: "processing" | "published"; draftMediaId: string; publishId: string }>();
const pendingExternalOpens = new Map<string, { path: string; displayName: string; announced: boolean; queuedAt: number }>();
const EXTERNAL_OPEN_TTL_MS = 60_000;
const singleInstanceAcquired = app.requestSingleInstanceLock();

function queueExternalOpenArgs(args: readonly string[]): void {
  for (const item of parseMarkdownOpenArgs(args)) {
    const exists = [...pendingExternalOpens.values()].some((entry) => entry.path.toLocaleLowerCase() === item.path.toLocaleLowerCase());
    if (exists || pendingExternalOpens.size >= 20) continue;
    pendingExternalOpens.set(randomUUID(), { ...item, announced: false, queuedAt: Date.now() });
  }
}

if (singleInstanceAcquired) {
  queueExternalOpenArgs(process.argv.slice(1));
  app.on("second-instance", (_event, commandLine) => {
    queueExternalOpenArgs(commandLine.slice(1));
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
} else {
  app.quit();
}

async function resolvedWechatApiConfig() {
  const stored = await wechatApiConfigStore?.connectorConfig() ?? null;
  const environment = configFromEnvironment();
  return {
    appId: stored?.appId || environment.appId,
    appSecret: stored?.appSecret || environment.appSecret,
    coverPath: stored?.coverPath || environment.coverPath,
  };
}

async function resolvedWechatApiConfigSummary(): Promise<WechatApiConfigSummary> {
  const stored = await wechatApiConfigStore?.summary() ?? {
    appId: "",
    hasAppSecret: false,
    coverPath: "",
    coverDisplayName: null,
    configured: false,
    source: "none" as const,
  };
  const environment = configFromEnvironment();
  const environmentParts = [environment.appId, environment.appSecret, environment.coverPath].filter(Boolean).length;
  const storedParts = [stored.appId, stored.hasAppSecret ? "secret" : "", stored.coverPath].filter(Boolean).length;
  const environmentUsed = Boolean(
    (!stored.appId && environment.appId)
    || (!stored.hasAppSecret && environment.appSecret)
    || (!stored.coverPath && environment.coverPath),
  );
  const appId = stored.appId || environment.appId;
  const hasAppSecret = stored.hasAppSecret || Boolean(environment.appSecret);
  const coverPath = stored.coverPath || environment.coverPath;
  const source = storedParts > 0 && environmentUsed
    ? "mixed"
    : storedParts > 0
      ? "stored"
      : environmentParts > 0
        ? "environment"
        : "none";
  return {
    appId,
    hasAppSecret,
    coverPath,
    coverDisplayName: coverPath ? basename(coverPath) : null,
    configured: Boolean(appId && hasAppSecret && coverPath),
    source,
  };
}

async function rememberRecentFile(path: string): Promise<void> {
  try {
    await recentFileStore?.remember(path);
  } catch {
    console.warn("Recent file metadata could not be updated.");
  }
}

async function finishSmoke(scenario: string, valid: boolean, diagnostics?: unknown): Promise<void> {
  const resultPath = process.env.FANTASTIC_EDITOR_SMOKE_RESULT;
  if (resultPath) {
    try {
      await writeFile(resultPath, JSON.stringify({
        schema: "fantastic-editor-smoke-result-v1",
        scenario,
        valid,
        ...(diagnostics === undefined ? {} : { diagnostics }),
        pid: process.pid,
        completedAt: new Date().toISOString(),
      }));
    } catch (error) {
      console.error("Smoke completion marker could not be written.", error);
      process.exitCode = 1;
      app.quit();
      return;
    }
  }
  process.exitCode = valid ? 0 : 1;
  if (scenario === "ui") {
    app.exit(process.exitCode);
    return;
  }
  app.quit();
}

const outputService = new OutputService(
  assetHandles,
  imageTransformProcess,
  nodeOutputProcess,
  async (suggestedName, bytes, target) => {
    const window = mainWindow;
    if (!window || window.isDestroyed()) return { status: "failed", error: "主窗口已关闭。" };
    if (target === "wechat-clipboard") {
      try {
        const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        const securityIssues = auditWechatHtmlMarkup(html);
        if (securityIssues.length > 0) {
          return { status: "failed", error: `公众号 HTML 含禁止内容（${securityIssues.join("、")}），未写入剪贴板。` };
        }
        const text = html
          .replace(/<br\s*\/?\s*>/gi, "\n")
          .replace(/<\/(?:p|h[1-6]|li|blockquote|section)>/gi, "\n")
          .replace(/<[^>]+>/g, "")
          .replaceAll("&nbsp;", " ")
          .replaceAll("&lt;", "<")
          .replaceAll("&gt;", ">")
          .replaceAll("&quot;", '"')
          .replaceAll("&#39;", "'")
          .replaceAll("&amp;", "&")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
        clipboard.write({ html, text });
        if (clipboard.readHTML().trim().length === 0) {
          return { status: "failed", error: "系统剪贴板未能读回公众号 HTML，请重新复制。" };
        }
        return { status: "saved", artifact: { kind: "clipboard", displayName: "公众号正文（方案 B）", mimeType: "text/html", byteLength: bytes.byteLength } };
      } catch {
        return { status: "failed", error: "写入系统剪贴板失败，原剪贴板内容未被确认替换。" };
      }
    }
    const isDocx = target === "docx";
    const isPdf = target === "pdf";
    const selection = await dialog.showSaveDialog(window, {
      title: isDocx ? "导出 Word 文档" : isPdf ? "导出 PDF" : target === "wechat-html" ? "导出公众号 HTML" : "导出单文件离线 HTML",
      defaultPath: suggestedName,
      filters: isDocx
        ? [{ name: "Word 文档", extensions: ["docx"] }]
        : isPdf ? [{ name: "PDF", extensions: ["pdf"] }] : [{ name: "HTML", extensions: ["html", "htm"] }],
    });
    if (selection.canceled || !selection.filePath) return { status: "cancelled" };
    try {
      await atomicWriteCandidate(selection.filePath, bytes);
      return {
        status: "saved",
        artifact: {
          kind: "file",
          displayName: basename(selection.filePath),
          mimeType: isDocx
            ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            : isPdf ? "application/pdf" : "text/html",
          byteLength: bytes.byteLength,
        },
      };
    } catch {
      return { status: "failed", error: "写入导出文件失败，原目标文件未被替换。" };
    }
  },
  formulaRenderWindow,
  pdfRenderWindow,
  mermaidRenderWindow,
  async (themeId, workspaceRoot) => new WechatThemeRepository({ globalRoot: join(app.getPath("userData"), "wechat-themes"), workspaceRoot }).resolveWechatThemeForOutput(themeId),
);

function requireTrustedRenderer(event: IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error("IPC request did not originate from the active main frame.");
  }
}

function wechatThemeRepositoryForDocument(documentId: string): WechatThemeRepository {
  const context = fileSessions.getResolutionContext(documentId);
  if (!context) throw new Error("当前文档会话不存在或已过期。");
  return new WechatThemeRepository({
    globalRoot: join(app.getPath("userData"), "wechat-themes"),
    workspaceRoot: context.authorizationRootRealPath,
  });
}

function registerSecurityPolicy(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' fantastic-asset:; font-src 'self' data:; connect-src 'self' ws:",
        ],
      },
    });
  });
}

function assetResponse(status: number): Response {
  return new Response(null, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function registerAssetProtocol(): void {
  protocol.handle(ASSET_SCHEME, async (request) => {
    const handleId = parseAssetHandleUrl(request.url);
    if (!handleId) return assetResponse(404);
    const context = fileSessions.getActiveResolutionContext();
    let result = await assetHandles.read(handleId, context);
    if (result.status === "not-found") result = previewDerivedCache.read(handleId, context);
    if (result.status === "unsupported") return assetResponse(415);
    if (result.status === "stale" || result.status === "changed") return assetResponse(409);
    if (result.status !== "ok") return assetResponse(404);
    return new Response(Buffer.from(result.bytes), {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'",
        "Content-Type": result.mimeType,
        "Cross-Origin-Resource-Policy": "cross-origin",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}

async function openWithConversionConfirmation(
  opener: (options: MarkdownOpenOptions) => Promise<FileOpenAttempt>,
): Promise<OpenFileResult> {
  const first = await opener({});
  if (first.status !== "confirmation-required") return first;
  const window = mainWindow;
  if (!window || window.isDestroyed()) return { status: "failed", error: "主窗口已关闭，无法确认文件转换。" };
  const confirmation = first.confirmation;
  const encodingPrefix = confirmation.requiresEncodingConversion ? "转为 UTF-8，" : "";
  const buttons = confirmation.hasMixedLineSeparators
    ? [`${encodingPrefix}换行统一为 LF`, `${encodingPrefix}换行统一为 CRLF`, "取消"]
    : ["转换为 UTF-8 并打开", "取消"];
  const summary = [
    confirmation.requiresEncodingConversion ? "检测结果：文件不是有效 UTF-8，可能为 GBK/GB18030。" : "",
    confirmation.hasMixedLineSeparators
      ? `换行统计：CRLF ${confirmation.crlfCount}，LF ${confirmation.lfCount}，单独 CR ${confirmation.bareCrCount}。`
      : "",
    "确认后文档会标记为未保存；首次保存将按所选规则重写为 UTF-8 文本。",
    confirmation.preview ? `\n内容预览：\n${confirmation.preview}` : "",
  ].filter(Boolean).join("\n");
  const choice = await dialog.showMessageBox(window, {
    type: "warning",
    title: "确认文本转换",
    message: `“${confirmation.displayName}”需要转换后才能编辑`,
    detail: summary,
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
    noLink: true,
  });
  if (choice.response === buttons.length - 1) return { status: "cancelled" };
  const options: MarkdownOpenOptions = {
    allowEncodingConversion: confirmation.requiresEncodingConversion,
    expectedFingerprint: confirmation.fingerprint,
    ...(confirmation.hasMixedLineSeparators ? { mixedLineSeparator: choice.response === 0 ? "lf" : "crlf" } : {}),
  };
  const opened = await opener(options);
  return opened.status === "confirmation-required"
    ? { status: "failed", error: "文件转换条件发生变化，请重新打开并确认。" }
    : opened;
}
function registerIpc(): void {
  ipcMain.handle(IPC_CHANNELS.listRecentFiles, async (event) => {
    requireTrustedRenderer(event);
    try {
      return { status: "listed", items: await recentFileStore?.list() ?? [] } as const;
    } catch {
      return { status: "failed", error: "最近文件列表暂时不可用。" } as const;
    }
  });

  ipcMain.handle(IPC_CHANNELS.openRecentFile, async (event, request: OpenRecentFileRequest) => {
    requireTrustedRenderer(event);
    if (!request || typeof request.recentId !== "string" || request.recentId.length > 200) return { status: "failed", error: "最近文件标识无效。" } as const;
    const path = await recentFileStore?.resolve(request.recentId);
    if (!path) return { status: "failed", error: "最近文件记录已失效。" } as const;
    const opened = await openWithConversionConfirmation((options) => fileSessions.openPath(path, options));
    if (opened.status === "opened") {
      await rememberRecentFile(path);
      parseCommits.clear();
      resourceResolver.revokeAllHandles();
      previewDerivedCache.revokeAll();
      outputService.clear();
    } else if (opened.status === "failed") {
      await recentFileStore?.forget(request.recentId);
    }
    return opened;
  });

  ipcMain.handle(IPC_CHANNELS.createUntitledFile, async (event) => {
    requireTrustedRenderer(event);
    const opened = await fileSessions.createUntitled();
    if (opened.status === "opened") {
      parseCommits.clear();
      resourceResolver.revokeAllHandles();
      previewDerivedCache.revokeAll();
      outputService.clear();
    }
    return opened;
  });

  ipcMain.handle(IPC_CHANNELS.openDroppedMarkdownFile, async (event, path: unknown) => {
    requireTrustedRenderer(event);
    if (typeof path !== "string" || path.length === 0 || path.length > 32_768) return { status: "failed", error: "拖入文件路径无效。" } as const;
    const opened = await openWithConversionConfirmation((options) => fileSessions.openPath(path, options));
    if (opened.status === "opened") {
      await rememberRecentFile(path);
      parseCommits.clear();
      resourceResolver.revokeAllHandles();
      previewDerivedCache.revokeAll();
      outputService.clear();
    }
    return opened;
  });

  ipcMain.handle(IPC_CHANNELS.listExternalOpenRequests, (event) => {
    requireTrustedRenderer(event);
    const now = Date.now();
    for (const [requestId, entry] of pendingExternalOpens) {
      if (now - entry.queuedAt > EXTERNAL_OPEN_TTL_MS) pendingExternalOpens.delete(requestId);
    }
    const requests = [...pendingExternalOpens.entries()]
      .filter(([, entry]) => !entry.announced)
      .map(([requestId, entry]) => {
        entry.announced = true;
        return { requestId, displayName: entry.displayName };
      });
    return requests;
  });

  ipcMain.handle(IPC_CHANNELS.discardExternalOpenRequest, (event, request: { requestId?: unknown }) => {
    requireTrustedRenderer(event);
    if (!request || typeof request.requestId !== "string") return { status: "missing" } as const;
    return { status: pendingExternalOpens.delete(request.requestId) ? "discarded" : "missing" } as const;
  });

  ipcMain.handle(IPC_CHANNELS.openExternalFile, async (event, request: { requestId?: unknown }) => {
    requireTrustedRenderer(event);
    if (!request || typeof request.requestId !== "string" || request.requestId.length > 100) return { status: "failed", error: "外部 Markdown 打开请求无效。" } as const;
    const pending = pendingExternalOpens.get(request.requestId);
    if (!pending) return { status: "failed", error: "外部文件打开请求已过期。" } as const;
    pendingExternalOpens.delete(request.requestId);
    const opened = await openWithConversionConfirmation((options) => fileSessions.openPath(pending.path, options));
    if (opened.status === "opened") {
      await rememberRecentFile(pending.path);
      parseCommits.clear();
      resourceResolver.revokeAllHandles();
      previewDerivedCache.revokeAll();
      outputService.clear();
    }
    return opened;
  });

  ipcMain.handle(IPC_CHANNELS.activateFileSession, (event, request: FileSessionRequest) => {
    requireTrustedRenderer(event);
    const result = fileSessions.activateSession(request.sessionId);
    if (result.status === "activated") {
      parseCommits.clear();
      resourceResolver.revokeAllHandles();
      previewDerivedCache.revokeAll();
      outputService.clear();
    }
    return result;
  });

  ipcMain.handle(IPC_CHANNELS.closeFileSession, async (event, request: FileSessionRequest) => {
    requireTrustedRenderer(event);
    const result = await fileSessions.closeSession(request.sessionId);
    if (result.status === "closed") {
      parseCommits.clear();
      resourceResolver.revokeAllHandles();
      previewDerivedCache.revokeAll();
      outputService.clear();
    }
    return result;
  });
  ipcMain.handle(IPC_CHANNELS.persistRecoverySession, async (event, request: PersistRecoveryRequest) => {
    requireTrustedRenderer(event);
    const store = recoveryStore;
    if (!store) return { status: "failed", error: "恢复存储尚未初始化。" } as const;
    try {
      if (!request.tabs.length) {
        await store.clear();
        return { status: "cleared" } as const;
      }
      await store.write(fileSessions.createRecoverySnapshot(request));
      return { status: "persisted" } as const;
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : "写入恢复快照失败。" } as const;
    }
  });

  ipcMain.handle(IPC_CHANNELS.restoreRecoverySession, async (event) => {
    requireTrustedRenderer(event);
    const store = recoveryStore;
    if (!store) return { status: "failed", error: "恢复存储尚未初始化。" } as const;
    try {
      const snapshot = await store.readLatest();
      if (!snapshot || snapshot.entries.length === 0) return { status: "empty" } as const;
      const restored = await fileSessions.restoreRecoverySnapshot(snapshot);
      if (restored.status === "restored") {
        parseCommits.clear();
        resourceResolver.revokeAllHandles();
        previewDerivedCache.revokeAll();
        outputService.clear();
      }
      return restored;
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : "恢复上次会话失败。" } as const;
    }
  });

  ipcMain.handle(IPC_CHANNELS.openMarkdownFile, async (event) => {
    requireTrustedRenderer(event);
    const result = await dialog.showOpenDialog({
      title: "打开 Markdown 文件",
      properties: ["openFile"],
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
    });
    if (result.canceled || !result.filePaths[0]) return { status: "cancelled" } as const;
    const opened = await openWithConversionConfirmation((options) => fileSessions.openPath(result.filePaths[0]!, options));
    if (opened.status === "opened") {
      await rememberRecentFile(result.filePaths[0]!);
      parseCommits.clear();
      resourceResolver.revokeAllHandles();
      previewDerivedCache.revokeAll();
      outputService.clear();
    }
    return opened;
  });

  ipcMain.handle(IPC_CHANNELS.openWorkspaceFolder, async (event) => {
    requireTrustedRenderer(event);
    const result = await dialog.showOpenDialog({
      title: "打开 Markdown 工作区",
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return { status: "cancelled" } as const;
    const opened = await fileSessions.openFolder(result.filePaths[0]);
    if (opened.status === "opened") {
      parseCommits.clear();
      resourceResolver.revokeAllHandles();
      previewDerivedCache.revokeAll();
      outputService.clear();
    }
    return opened;
  });

  ipcMain.handle(IPC_CHANNELS.openWorkspaceFile, async (event, request: OpenWorkspaceFileRequest) => {
    requireTrustedRenderer(event);
    const opened = await openWithConversionConfirmation((options) => fileSessions.openWorkspaceFile(request, options));
    if (opened.status === "opened") {
      parseCommits.clear();
      resourceResolver.revokeAllHandles();
      previewDerivedCache.revokeAll();
      outputService.clear();
    }
    return opened;
  });

  ipcMain.handle(IPC_CHANNELS.renameWorkspaceFile, async (event, request: RenameWorkspaceFileRequest) => {
    requireTrustedRenderer(event);
    const result = await fileSessions.renameWorkspaceFile(request);
    if (result.status === "renamed") {
      parseCommits.clear();
      resourceResolver.revokeAllHandles();
      previewDerivedCache.revokeAll();
      outputService.clear();
    }
    return result;
  });

  ipcMain.handle(IPC_CHANNELS.renameOpenFile, async (event, request: RenameOpenFileRequest) => {
    requireTrustedRenderer(event);
    const result = await fileSessions.renameOpenFile(request);
    if (result.status === "renamed") {
      parseCommits.clear();
      resourceResolver.revokeAllHandles();
      previewDerivedCache.revokeAll();
      outputService.clear();
    }
    return result;
  });

  ipcMain.handle(IPC_CHANNELS.saveCurrentFile, (event, request: SaveFileRequest) => {
    requireTrustedRenderer(event);
    return fileSessions.save(request);
  });

  ipcMain.handle(IPC_CHANNELS.saveCurrentFileAs, async (event, request: SaveFileRequest) => {
    requireTrustedRenderer(event);
    const result = await dialog.showSaveDialog({
      title: "另存为 Markdown",
      defaultPath: "document.md",
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
    });
    if (result.canceled || !result.filePath) return { status: "cancelled" } as const;
    const saved = await fileSessions.save(request, result.filePath);
    if (saved.status === "saved") {
      await rememberRecentFile(result.filePath);
      parseCommits.clear();
      resourceResolver.revokeAllHandles();
      previewDerivedCache.revokeAll();
      outputService.clear();
    }
    return saved;
  });

  ipcMain.handle(IPC_CHANNELS.selectAndImportImages, async (event, request: ImageImportSessionRequest) => {
    requireTrustedRenderer(event);
    const result = await dialog.showOpenDialog({
      title: "插入图片",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"] }],
    });
    if (result.canceled || result.filePaths.length === 0) return { status: "cancelled" } as const;
    const imported = await imageImportService.importSelectedPaths(request, result.filePaths);
    if (imported.status === "imported") {
      parseCommits.clear();
      resourceResolver.revokeAllHandles();
      previewDerivedCache.revokeAll();
      outputService.clear();
    }
    return imported;
  });

  ipcMain.handle(IPC_CHANNELS.importDroppedImages, async (event, request: ImportDroppedImagesRequest) => {
    requireTrustedRenderer(event);
    const imported = await imageImportService.importDroppedFiles(request, request?.files ?? []);
    if (imported.status === "imported") {
      parseCommits.clear();
      resourceResolver.revokeAllHandles();
      previewDerivedCache.revokeAll();
      outputService.clear();
    }
    return imported;
  });
  ipcMain.handle(IPC_CHANNELS.commitParse, (event, request: ParseCommitRequest) => {
    requireTrustedRenderer(event);
    return parseCommits.commit(request, fileSessions.getResolutionContext(request.documentId));
  });

  ipcMain.handle(IPC_CHANNELS.resolveResources, async (event, request: ResolveRequest) => {
    requireTrustedRenderer(event);
    const context = fileSessions.getResolutionContext(request.documentId);
    const result = await resourceResolver.resolve(
      request,
      context,
      () => fileSessions.getResolutionContext(request.documentId),
    );
    if (result.status === "resolved" && result.resolutionSnapshot && context) {
      outputService.rememberResolution(request.parseCommitId, result.resolutionSnapshot);
      void svgPreviewCoordinator.schedule(
        request,
        result,
        context,
        () => parseCommits.acceptsResolve(request, fileSessions.getResolutionContext(request.documentId)),
        (update) => {
          const window = mainWindow;
          if (!window || window.isDestroyed()) return;
          window.webContents.send(IPC_CHANNELS.previewDerivedUpdate, update);
        },
      ).catch(() => undefined);
    }
    return result;
  });

  ipcMain.handle(IPC_CHANNELS.listWechatThemes, async (event, request: ListWechatThemesRequest) => {
    requireTrustedRenderer(event);
    if (!request || typeof request.documentId !== "string" || request.documentId.length > 200) return { status: "failed", error: "主题列表请求无效。" } as const;
    try {
      return { status: "listed", themes: await wechatThemeRepositoryForDocument(request.documentId).list() } as const;
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : "读取公众号主题失败。" } as const;
    }
  });

  ipcMain.handle(IPC_CHANNELS.resolveWechatThemeForPreview, async (event, request: ResolveWechatThemeForPreviewRequest) => {
    requireTrustedRenderer(event);
    if (!request || typeof request.documentId !== "string" || typeof request.themeId !== "string" || request.themeId.length > 200) return { status: "failed", error: "主题预览请求无效。" } as const;
    try {
      return { status: "resolved", theme: await wechatThemeRepositoryForDocument(request.documentId).resolveWechatThemeForOutput(request.themeId) } as const;
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : "解析公众号主题失败。" } as const;
    }
  });

  ipcMain.handle(IPC_CHANNELS.saveWechatThemeAsCustom, async (event, request: SaveWechatThemeAsCustomRequest) => {
    requireTrustedRenderer(event);
    if (!request || typeof request.documentId !== "string" || !request.input || typeof request.input !== "object") return { status: "failed", error: "自定义主题请求无效。" } as const;
    try {
      const repository = wechatThemeRepositoryForDocument(request.documentId);
      return { status: "saved", theme: await repository.save(request.input, "workspace") } as const;
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : "保存自定义主题失败。" } as const;
    }
  });

  ipcMain.handle(IPC_CHANNELS.deleteWechatTheme, async (event, request: DeleteWechatThemeRequest) => {
    requireTrustedRenderer(event);
    if (!request || typeof request.documentId !== "string" || typeof request.themeId !== "string") return { status: "failed", error: "删除主题请求无效。" } as const;
    try {
      await wechatThemeRepositoryForDocument(request.documentId).delete(request.themeId, request.currentThemeId);
      return { status: "deleted" } as const;
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : "删除自定义主题失败。" } as const;
    }
  });

  ipcMain.handle(IPC_CHANNELS.exportWechatTheme, async (event, request: ExportWechatThemeRequest) => {
    requireTrustedRenderer(event);
    if (!request || typeof request.documentId !== "string" || typeof request.themeId !== "string") return { status: "failed", error: "导出主题请求无效。" } as const;
    try {
      const file = await wechatThemeRepositoryForDocument(request.documentId).export(request.themeId);
      const window = mainWindow;
      if (!window || window.isDestroyed()) return { status: "failed", error: "主窗口已关闭。" } as const;
      const selection = await dialog.showSaveDialog(window, {
        title: "导出公众号自定义主题",
        defaultPath: `${request.themeId.split("+")[0]}-theme.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (selection.canceled || !selection.filePath) return { status: "cancelled" } as const;
      await atomicWriteCandidate(selection.filePath, new TextEncoder().encode(JSON.stringify(file, null, 2) + "\n"));
      return { status: "exported", file } as const;
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : "导出自定义主题失败。" } as const;
    }
  });

  ipcMain.handle(IPC_CHANNELS.importWechatTheme, async (event, request: ImportWechatThemeRequest) => {
    requireTrustedRenderer(event);
    if (!request || typeof request.documentId !== "string") return { status: "failed", error: "导入主题请求无效。" } as const;
    const window = mainWindow;
    if (!window || window.isDestroyed()) return { status: "failed", error: "主窗口已关闭。" } as const;
    const selection = await dialog.showOpenDialog(window, {
      title: "导入公众号自定义主题",
      properties: ["openFile"],
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (selection.canceled || !selection.filePaths[0]) return { status: "cancelled" } as const;
    try {
      const storage = request.storage === "global" ? "global" : "workspace";
      return { status: "imported", theme: await wechatThemeRepositoryForDocument(request.documentId).importFile(selection.filePaths[0]!, storage) } as const;
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : "导入自定义主题失败。" } as const;
    }
  });

  ipcMain.handle(IPC_CHANNELS.beginOutput, (event, request: BeginOutputRequest) => {
    requireTrustedRenderer(event);
    const context = fileSessions.getResolutionContext(request.documentId);
    const resolveIdentity: ResolveRequest = {
      documentId: request.documentId,
      sourceHash: request.sourceHash,
      parserProfile: request.parserProfile,
      taskSequence: request.taskSequence,
      parseCommitId: request.parseCommitId,
      workspaceRevision: request.workspaceRevision,
      resourceReferences: request.parsedDocument.resourceReferences,
    };
    return outputService.begin(
      request,
      context,
      () => parseCommits.acceptsResolve(resolveIdentity, fileSessions.getResolutionContext(request.documentId)),
    );
  });

  ipcMain.handle(IPC_CHANNELS.approveOutputOmissions, (event, request: ApproveOmissions) => {
    requireTrustedRenderer(event);
    return outputService.approve(request);
  });

  ipcMain.handle(IPC_CHANNELS.cancelOutput, (event, request: CancelOutputRequest) => {
    requireTrustedRenderer(event);
    return outputService.cancel(request.jobId);
  });

  ipcMain.handle(IPC_CHANNELS.copyWechatReplacement, (event, request: CopyWechatReplacementRequest) => {
    requireTrustedRenderer(event);
    const replacement = outputService.getWechatReplacement(request.jobId, request.itemId);
    if (!replacement) return { status: "failed", error: "替换图片不存在、已过期或不属于当前公众号任务。" } as const;
    try {
      const image = nativeImage.createFromBuffer(Buffer.from(replacement.bytes));
      if (image.isEmpty()) return { status: "failed", error: "该图片格式无法写入系统位图剪贴板。" } as const;
      clipboard.writeImage(image);
      const copiedImage = clipboard.readImage();
      const expectedSize = image.getSize();
      const copiedSize = copiedImage.getSize();
      if (copiedImage.isEmpty() || copiedSize.width !== expectedSize.width || copiedSize.height !== expectedSize.height) {
        return { status: "failed", error: "系统剪贴板未能确认替换图片，请重新复制。" } as const;
      }
      return { status: "copied", itemId: request.itemId } as const;
    } catch {
      return { status: "failed", error: "复制替换图片失败。" } as const;
    }
  });

  ipcMain.handle(IPC_CHANNELS.getWechatApiConfig, async (event) => {
    requireTrustedRenderer(event);
    try {
      return { status: "loaded", config: await resolvedWechatApiConfigSummary() } as const;
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : "读取公众号 API 配置失败。" } as const;
    }
  });

  ipcMain.handle(IPC_CHANNELS.testWechatApiConnection, async (event) => {
    requireTrustedRenderer(event);
    try {
      return await wechatDraftConnector.testConnection(await resolvedWechatApiConfig());
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : "公众号接口连接检测失败。" } as const;
    }
  });

  ipcMain.handle(IPC_CHANNELS.selectWechatCover, async (event) => {
    requireTrustedRenderer(event);
    const window = mainWindow;
    if (!window || window.isDestroyed()) return { status: "failed", error: "主窗口已关闭。" } as const;
    const selection = await dialog.showOpenDialog(window, {
      title: "选择公众号封面图片",
      properties: ["openFile"],
      filters: [{ name: "封面图片", extensions: ["png", "jpg", "jpeg"] }],
    });
    if (selection.canceled || !selection.filePaths[0]) return { status: "cancelled" } as const;
    return { status: "selected", path: selection.filePaths[0], displayName: basename(selection.filePaths[0]) } as const;
  });

  ipcMain.handle(IPC_CHANNELS.saveWechatApiConfig, async (event, request: SaveWechatApiConfigRequest) => {
    requireTrustedRenderer(event);
    if (!request || typeof request.appId !== "string" || typeof request.coverPath !== "string" || (request.appSecret !== undefined && typeof request.appSecret !== "string")) {
      return { status: "failed", error: "公众号 API 配置载荷无效。" } as const;
    }
    if (!wechatApiConfigStore) return { status: "failed", error: "公众号 API 配置存储尚未就绪。" } as const;
    try {
      const environment = configFromEnvironment();
      const appSecret = request.appSecret?.trim() || environment.appSecret;
      const config = await wechatApiConfigStore.save(appSecret
        ? { appId: request.appId, coverPath: request.coverPath, appSecret }
        : { appId: request.appId, coverPath: request.coverPath });
      return { status: "saved", config } as const;
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : "保存公众号 API 配置失败。" } as const;
    }
  });

  ipcMain.handle(IPC_CHANNELS.clearWechatApiConfig, async (event) => {
    requireTrustedRenderer(event);
    if (!wechatApiConfigStore) return { status: "failed", error: "公众号 API 配置存储尚未就绪。" } as const;
    try {
      await wechatApiConfigStore.clear();
      return { status: "cleared", config: await resolvedWechatApiConfigSummary() } as const;
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : "清除公众号 API 配置失败。" } as const;
    }
  });

  ipcMain.handle(IPC_CHANNELS.createWechatDraft, async (event, request: CreateWechatDraftRequest) => {
    requireTrustedRenderer(event);
    if (!request || typeof request.jobId !== "string" || !/^[A-Za-z0-9-]{1,80}$/.test(request.jobId)) {
      return { status: "failed", error: "公众号自动草稿任务身份无效。" } as const;
    }
    const payload = outputService.getWechatDraftPayload(request.jobId);
    if (!payload) return { status: "failed", error: "公众号任务不存在、已过期或尚未生成完整图片资源。" } as const;
    try {
      return await wechatDraftConnector.create({ payload, config: await resolvedWechatApiConfig() });
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : "读取公众号 API 配置失败。" } as const;
    }
  });

  ipcMain.handle(IPC_CHANNELS.publishWechatArticle, async (event, request: PublishWechatArticleRequest) => {
    requireTrustedRenderer(event);
    if (!request || typeof request.jobId !== "string" || !/^[A-Za-z0-9-]{1,80}$/.test(request.jobId)) {
      return { status: "failed", error: "公众号发布任务身份无效。" } as const;
    }
    const payload = outputService.getWechatDraftPayload(request.jobId);
    if (!payload) return { status: "failed", error: "公众号任务不存在、已过期或尚未生成完整图片资源。" } as const;
    const previous = wechatPublishRecords.get(request.jobId);
    if (previous?.status === "published") {
      return { status: "failed", error: `当前任务已经发布过，不能重复发布。发布任务 ID ${previous.publishId}。`, draftMediaId: previous.draftMediaId, publishId: previous.publishId } as const;
    }
    if (previous?.status === "processing") {
      return { status: "processing", draftMediaId: previous.draftMediaId, publishId: previous.publishId, message: "当前任务的微信发布仍在处理中，请勿重复提交。" } as const;
    }
    try {
      const config = await resolvedWechatApiConfig();
      const draft = await wechatDraftConnector.create({ payload, config });
      if (draft.status !== "created") return draft;
      const result = await wechatDraftConnector.publish(draft.draftMediaId, config);
      if (result.status === "published" || result.status === "processing") {
        wechatPublishRecords.set(request.jobId, { status: result.status, draftMediaId: result.draftMediaId, publishId: result.publishId });
      }
      return result;
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : "公众号一键发布失败。" } as const;
    }
  });

  ipcMain.handle(IPC_CHANNELS.saveWechatAcceptanceReport, async (event, request: SaveWechatAcceptanceReportRequest) => {
    requireTrustedRenderer(event);
    const window = mainWindow;
    if (!window || window.isDestroyed()) return { status: "failed", error: "主窗口已关闭。" } as const;
    if (
      !request
      || typeof request.jobId !== "string"
      || !Array.isArray(request.confirmedReplacementItemIds)
      || !request.confirmation
      || request.confirmation.bodyPasted !== true
      || request.confirmation.draftSaved !== true
      || request.confirmation.draftReopened !== true
      || request.confirmation.mobilePreviewed !== true
    ) return { status: "failed", error: "公众号验收记录请求不完整或尚未完成全部人工确认。" } as const;
    const summary = outputService.getWechatAcceptanceSummary(request.jobId);
    if (!summary) return { status: "failed", error: "公众号任务不存在、已过期或尚未完成。" } as const;
    const confirmed = [...new Set(request.confirmedReplacementItemIds)].sort();
    const expected = summary.replacementItems.map((item) => item.itemId).sort();
    if (
      confirmed.length !== request.confirmedReplacementItemIds.length
      || confirmed.length !== expected.length
      || confirmed.some((itemId, index) => itemId !== expected[index])
    ) return { status: "failed", error: "替换项确认集合与当前公众号任务不一致。" } as const;
    const report = generateWechatAcceptanceReport({
      ...summary,
      confirmation: request.confirmation,
      generatedAt: new Date().toISOString(),
      appVersion: app.getVersion(),
      platform: process.platform,
      architecture: process.arch,
    });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const selection = await dialog.showSaveDialog(window, {
      title: "保存公众号人工验收记录",
      defaultPath: "wechat-acceptance-" + timestamp + ".md",
      filters: [{ name: "Markdown 文档", extensions: ["md"] }],
    });
    if (selection.canceled || !selection.filePath) return { status: "cancelled" } as const;
    try {
      await atomicWriteCandidate(selection.filePath, new TextEncoder().encode(report));
      return { status: "saved", displayName: basename(selection.filePath) } as const;
    } catch {
      return { status: "failed", error: "公众号人工验收记录保存失败，未覆盖原文件。" } as const;
    }
  });
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 620,
    show: false,
    backgroundColor: "#f6f5f1",
    title: "fantastic-editor",
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow = window;
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
    parseCommits.clear();
    resourceResolver.revokeAllHandles();
    previewDerivedCache.revokeAll();
    outputService.clear();
    wechatPublishRecords.clear();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  if (process.env.FANTASTIC_EDITOR_UI_SMOKE_TEST === "1") {
    window.webContents.once("did-finish-load", () => {
      void (async () => {
        const uiReady = await window.webContents.executeJavaScript(`new Promise((resolve) => {
          const deadline = Date.now() + 5000;
          const check = () => {
            if (document.querySelector("[data-testid=new-document]")) resolve(true);
            else if (Date.now() >= deadline) resolve(false);
            else setTimeout(check, 50);
          };
          check();
        })`, true) as boolean;
        const before = await window.webContents.executeJavaScript(`({
          hasTabs: Boolean(document.querySelector(\"[data-testid=document-tabs]\")),
          hasDropHint: Boolean(document.querySelector(\"[data-testid=drop-hint]\")),
          hasNewButton: Boolean(document.querySelector(\"[data-testid=new-document]\"))
        })`, true) as { hasTabs: boolean; hasDropHint: boolean; hasNewButton: boolean };
        await window.webContents.executeJavaScript(`document.querySelector(".app-shell")?.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true }))`, true);
        await new Promise((resolve) => setTimeout(resolve, 100));
        const drag = await window.webContents.executeJavaScript(`({ hasDropOverlay: Boolean(document.querySelector(".drop-overlay")) })`, true) as { hasDropOverlay: boolean };
        await window.webContents.executeJavaScript(`document.querySelector(".app-shell")?.dispatchEvent(new DragEvent("dragleave", { bubbles: true, cancelable: true }))`, true);
        await window.webContents.executeJavaScript(`document.querySelector(\"[data-testid=new-document]\")?.click()`, true);
        await window.webContents.executeJavaScript(`new Promise((resolve) => {
          const deadline = Date.now() + 5000;
          const check = () => {
            if (document.querySelector(".document-tab.active") && document.querySelector(".cm-content")) resolve(true);
            else if (Date.now() >= deadline) resolve(false);
            else setTimeout(check, 50);
          };
          check();
        })`, true);
        await window.webContents.executeJavaScript(`document.querySelector("[data-testid=editor-mode-switch] button:first-child")?.click()`, true);
        await new Promise((resolve) => setTimeout(resolve, 150));
        const after = await window.webContents.executeJavaScript(`({
          tabText: document.querySelector(\".document-tab.active .tab-select span\")?.textContent ?? \"\",
          tabCount: document.querySelectorAll(\".document-tab\").length,
          editorText: document.querySelector(\".cm-content\")?.textContent ?? \"\",
          brandText: document.querySelector(\".brand-lockup\")?.textContent ?? \"\",
          hasSidebar: Boolean(document.querySelector(\".explorer-panel\")),
          hasSplitHandle: Boolean(document.querySelector(".split-handle")),
          hasInsertImageButton: Boolean(document.querySelector(".insert-image-button")),
          hasSyncScrollButton: Boolean(document.querySelector("[data-testid=sync-scroll-toggle]")),
          saveEnabled: !(document.querySelector('button[aria-label="保存"]')?.hasAttribute("disabled") ?? true),
          hasUnsavedIndicator: Boolean(document.querySelector(".document-tab.active .dirty-dot, .document-tab.active i[aria-label=未保存]")),
          statusText: document.querySelector(".status-message")?.textContent ?? "",
          viewportFits: document.documentElement.scrollWidth === document.documentElement.clientWidth
        })`, true) as { tabText: string; tabCount: number; editorText: string; brandText: string; hasSidebar: boolean; hasSplitHandle: boolean; hasInsertImageButton: boolean; hasSyncScrollButton: boolean; saveEnabled: boolean; hasUnsavedIndicator: boolean; statusText: string; viewportFits: boolean };
        const accessibility = await window.webContents.executeJavaScript(`(async () => {
          const separator = document.querySelector('.split-handle');
          const selectedTab = document.querySelector('.document-tab.active .tab-select');
          const status = document.querySelector('.status-message');
          if (!(separator instanceof HTMLElement)) return { keyboardSeparator: false, selectedTab: false, liveStatus: false };
          const before = Number(separator.getAttribute('aria-valuenow'));
          separator.focus();
          separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
          await new Promise((resolve) => setTimeout(resolve, 50));
          const after = Number(separator.getAttribute('aria-valuenow'));
          return {
            keyboardSeparator: separator.tabIndex === 0 && after > before,
            selectedTab: selectedTab?.getAttribute('role') === 'tab' && selectedTab.getAttribute('aria-selected') === 'true',
            liveStatus: status?.getAttribute('role') === 'status' && status.getAttribute('aria-live') === 'polite',
          };
        })()`, true) as { keyboardSeparator: boolean; selectedTab: boolean; liveStatus: boolean };
        const recentBoundary = await window.webContents.executeJavaScript(`(async () => {
          const result = await window.fantasticEditor.listRecentFiles();
          return {
            listed: result.status === 'listed',
            opaque: result.status === 'listed' && result.items.every((item) => typeof item.recentId === 'string' && !('path' in item)),
          };
        })()`, true) as { listed: boolean; opaque: boolean };
        const tabShortcuts = await window.webContents.executeJavaScript(`(async () => {
          const waitFor = async (predicate, timeout = 5000) => {
            const deadline = Date.now() + timeout;
            while (Date.now() < deadline) {
              if (predicate()) return true;
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            return false;
          };
          document.querySelector('[data-testid=new-document]')?.click();
          const created = await waitFor(() => document.querySelectorAll('.document-tab').length === 2 && document.querySelector('.document-tab.active .tab-select')?.getAttribute('data-tab-index') === '1');
          document.querySelector('.document-tab.active .tab-select')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, shiftKey: true, bubbles: true, cancelable: true }));
          const reorderedLeft = await waitFor(() => document.querySelector('.document-tab.active .tab-select')?.getAttribute('data-tab-index') === '0');
          document.querySelector('.document-tab.active .tab-select')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, shiftKey: true, bubbles: true, cancelable: true }));
          const reorderedRight = await waitFor(() => document.querySelector('.document-tab.active .tab-select')?.getAttribute('data-tab-index') === '1');
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
          const previous = await waitFor(() => document.querySelector('.document-tab.active .tab-select')?.getAttribute('data-tab-index') === '0');
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, bubbles: true, cancelable: true }));
          const next = await waitFor(() => document.querySelector('.document-tab.active .tab-select')?.getAttribute('data-tab-index') === '1');
          const originalConfirm = window.confirm;
          window.confirm = () => true;
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true, cancelable: true }));
          const closed = await waitFor(() => document.querySelectorAll('.document-tab').length === 1 && document.querySelector('.document-tab.active .tab-select')?.getAttribute('data-tab-index') === '0');
          window.confirm = originalConfirm;
          return { created, reorderedLeft, reorderedRight, previous, next, closed };
        })()`, true) as { created: boolean; reorderedLeft: boolean; reorderedRight: boolean; previous: boolean; next: boolean; closed: boolean };
        const fontControl = await window.webContents.executeJavaScript(`(() => {
          const input = document.querySelector("[data-testid=preview-font-select]");
          if (!(input instanceof HTMLInputElement)) return { exists: false, applied: false, hasArial: false };
          const presets = document.querySelector("#preview-font-presets");
          const hasArial = presets instanceof HTMLDataListElement && Array.from(presets.options).some((option) => option.value === "Arial");
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
          setter?.call(input, "KaiTi");
          input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
          input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
          return { exists: true, applied: true, hasArial };
        })()`, true) as { exists: boolean; applied: boolean; hasArial: boolean };
        await new Promise((resolve) => setTimeout(resolve, 100));
        const fontApplied = await window.webContents.executeJavaScript(`document.querySelector(".markdown-preview")?.getAttribute("style")?.includes("KaiTi") ?? false`, true) as boolean;
        window.show();
        window.focus();
        window.webContents.focus();
        await window.webContents.executeJavaScript(`document.querySelector(".cm-content")?.focus()`, true);
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
        await new Promise((resolve) => setTimeout(resolve, 120));
        await window.webContents.insertText("# Mermaid smoke\n\n剪贴板 HTML 测试\n\n跨块格式甲\n\n跨块格式乙\n\n跨块粘贴甲\n\n跨块粘贴乙\n\n混合前 [链接](https://example.com) 与 `代码`、$a+b$、![inline image](missing.png) 混合后\n\n下表为**中性情景**下的工作假设：\n\n| 期间 | 情景 |\n| --- | --- |\n| 2026Q3 | 预测 |\n\n> 引用原文\n\n- 列表原项\n- [ ] 待完成\n- 嵌套父项\n  - 嵌套子项\n  - [ ] 嵌套任务\n- 嵌套后项\n\n![smoke image](missing.png)\n\n$$\nx + y\n$$\n\n```ts\nconst value = 1;\n```\n\n```mermaid\ngraph TD\n  A --> B\n```\n");
        await new Promise((resolve) => setTimeout(resolve, 250));
        const mermaidRendered = await window.webContents.executeJavaScript(`new Promise((resolve) => {
          const deadline = Date.now() + 8000;
          const check = () => {
            if (document.querySelector(".mermaid-diagram svg")) resolve(true);
            else if (Date.now() >= deadline) resolve(false);
            else setTimeout(check, 50);
          };
          check();
        })`, true) as boolean;
        const performanceMetric = await window.webContents.executeJavaScript(`(() => {
          const metric = document.querySelector('.performance-metric');
          return {
            exists: metric instanceof HTMLElement,
            text: metric?.textContent ?? '',
            accessible: (metric?.getAttribute('aria-label') ?? '').includes('字符') && (metric?.getAttribute('aria-label') ?? '').includes('资源解析'),
          };
        })()`, true) as { exists: boolean; text: string; accessible: boolean };
        const mermaidEditorText = await window.webContents.executeJavaScript(`document.querySelector(".cm-content")?.textContent ?? ""`, true) as string;
        const mermaidDebug = await window.webContents.executeJavaScript(`({ errorText: document.querySelector(".mermaid-error")?.textContent ?? "", renderError: document.querySelector(".preview-content")?.getAttribute("data-mermaid-error") ?? "", started: document.querySelector(".preview-content")?.getAttribute("data-mermaid-started") ?? "" })`, true) as { errorText: string; renderError: string; started: string };
        const wechatThemePreview = await window.webContents.executeJavaScript(`(async () => {
          const waitFor = async (predicate, timeout = 15000) => {
            const deadline = Date.now() + timeout;
            while (Date.now() < deadline) {
              if (predicate()) return true;
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            return false;
          };
          const button = document.querySelector(".wechat-layout-entry");
          if (!(button instanceof HTMLButtonElement)) return { opened: false, completed: false, widthCount: 0, hasHeadingAuditCopy: false, keyboardDialog: false, focusRestored: false };
          const ready = await waitFor(() => !button.disabled);
          if (!ready) return { opened: false, completed: false, widthCount: 0, hasHeadingAuditCopy: false, keyboardDialog: false, focusRestored: false };
          button.click();
          const opened = await waitFor(() => Boolean(document.querySelector(".wechat-preview-dialog")));
          const completed = opened && await waitFor(() => document.querySelectorAll(".viewport-buttons button:not(.running)").length === 3);
          const widthCount = document.querySelectorAll(".viewport-buttons button").length;
          const hasHeadingAuditCopy = document.querySelector(".wechat-audit-panel")?.textContent?.includes("三档宽度") ?? false;
          const dialog = document.querySelector('.wechat-preview-overlay');
          const closeButton = document.querySelector('button[aria-label="关闭公众号主题预览"]');
          const keyboardDialog = dialog?.getAttribute('aria-modal') === 'true'
            && Boolean(dialog.getAttribute('aria-labelledby'))
            && closeButton === document.activeElement;
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
          const closed = await waitFor(() => !document.querySelector('.wechat-preview-dialog'));
          await new Promise((resolve) => setTimeout(resolve, 50));
          const focusRestored = closed && document.activeElement === button;
          return { opened, completed, widthCount, hasHeadingAuditCopy, keyboardDialog, focusRestored };
        })()`, true) as { opened: boolean; completed: boolean; widthCount: number; hasHeadingAuditCopy: boolean; keyboardDialog: boolean; focusRestored: boolean };
        const syncTextBefore = await window.webContents.executeJavaScript(`document.querySelector("[data-testid=sync-scroll-toggle]")?.textContent ?? ""`, true) as string;        const syncBefore = await window.webContents.executeJavaScript(`document.querySelector("[data-testid=sync-scroll-toggle]")?.getAttribute("aria-pressed") ?? "missing"`, true) as string;
        await window.webContents.executeJavaScript(`document.querySelector("[data-testid=sync-scroll-toggle]")?.click()`, true);
        await new Promise((resolve) => setTimeout(resolve, 100));
        const syncAfter = await window.webContents.executeJavaScript(`document.querySelector("[data-testid=sync-scroll-toggle]")?.getAttribute("aria-pressed") ?? "missing"`, true) as string;
        if (syncAfter !== "true") {
          await window.webContents.executeJavaScript(`document.querySelector("[data-testid=sync-scroll-toggle]")?.click()`, true);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const syncEnabled = await window.webContents.executeJavaScript(`document.querySelector("[data-testid=sync-scroll-toggle]")?.getAttribute("aria-pressed") ?? "missing"`, true) as string;
        await window.webContents.executeJavaScript(`new Promise((resolve) => {
          const deadline = Date.now() + 5000;
          const check = () => {
            if (document.querySelector(".preview-content [data-source-block=true]")) resolve(true);
            else if (Date.now() >= deadline) resolve(false);
            else setTimeout(check, 50);
          };
          check();
        })`, true);
        window.show();
        window.focus();
        window.webContents.focus();
        await window.webContents.executeJavaScript(`document.querySelector(".cm-content")?.focus()`, true);
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
        await new Promise((resolve) => setTimeout(resolve, 150));
        const selectionBoxCount = await window.webContents.executeJavaScript(`Number(document.querySelector(".preview-selection-layer")?.getAttribute("data-box-count") ?? 0)`, true) as number;
        const wysiwyg = await window.webContents.executeJavaScript(`(async () => {
          try {
          const switcher = document.querySelector("[data-testid=editor-mode-switch]");
          const sourceButton = switcher?.querySelector("button:first-child");
          const visualButton = switcher?.querySelector("button:last-child");
          if (!(sourceButton instanceof HTMLButtonElement) || !(visualButton instanceof HTMLButtonElement)) return { exists: false };
          visualButton.click();
          const waitFor = async (predicate, timeout = 8000) => {
            const deadline = Date.now() + timeout;
            while (Date.now() < deadline) {
              if (predicate()) return true;
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            return false;
          };
          const projectionReady = () => document.querySelector(".wysiwyg-editor-layer.active .wysiwyg-content")?.getAttribute("data-projection-ready") === "true";
          const ready = await waitFor(() => Boolean(document.querySelector(".wysiwyg-editor-layer.active .wysiwyg-content p[data-source-from]")) && Boolean(document.querySelector(".wysiwyg-editor-layer.active .mermaid-diagram svg")));
          let tableCellEdited = false;
          let tableColumnInserted = false;
          let tableAlignmentApplied = false;
          let tableRowAppended = false;
          let listItemEdited = false;
          let listDirectReady = false;
          let listBrowserInserted = false;
          let listIndented = false;
          let listOutdented = false;
          let nestedParentEdited = false;
          let nestedSubtreeIndented = false;
          let nestedSubtreeOutdented = false;
          let quoteEdited = false;
          let taskToggled = false;
          let imageAltEdited = false;
          let formulaStructuredApplied = false;
          let codeStructuredApplied = false;
          let linkStructuredApplied = false;
          let inlineCodeStructuredApplied = false;
          let mixedInlineEdited = false;
          let mixedAtomsProtected = false;
          let protectedSelectionRejected = false;
          let crossBlockFormatted = false;
          let crossBlockPasted = false;
          let crossBlockProtectedRejected = false;
          let dualFormatCopy = false;
          let selectAllCopy = false;
          let externalHtmlPaste = false;
          let imaRichPaste = false;
          let imaPasteSnapshot = "";
          let blockInserted = false;
          let blockDragged = false;
          let blockDuplicated = false;
          let blockDeleted = false;
          let blockKeyboardMoved = false;
          const selectAcrossParagraphs = (firstText, lastText) => {
            const paragraphs = [...document.querySelectorAll(".wysiwyg-editor-layer.active p[data-wysiwyg-editability=direct]")];
            const first = paragraphs.find((element) => element.textContent?.includes(firstText));
            const last = paragraphs.find((element) => element.textContent?.includes(lastText));
            if (!(first instanceof HTMLElement) || !(last instanceof HTMLElement)) return null;
            const rect = first.getBoundingClientRect();
            first.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: rect.left + 4, clientY: rect.top + rect.height / 2 }));
            const findTextNode = (root, text) => {
              const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
              let node = walker.nextNode();
              while (node && !node.textContent?.includes(text)) node = walker.nextNode();
              return node;
            };
            const firstNode = findTextNode(first, firstText);
            const lastNode = findTextNode(last, lastText);
            if (!(firstNode instanceof Text) || !(lastNode instanceof Text)) return null;
            const range = document.createRange();
            range.setStart(firstNode, firstNode.textContent?.indexOf(firstText) ?? 0);
            range.setEnd(lastNode, (lastNode.textContent?.indexOf(lastText) ?? 0) + lastText.length);
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
            return first;
          };
          const copyParagraph = [...document.querySelectorAll(".wysiwyg-editor-layer.active p[data-wysiwyg-editability=direct]")]
            .find((element) => (element.textContent ?? "").trim().length > 0);
          if (copyParagraph instanceof HTMLElement) {
            const copyRange = document.createRange();
            copyRange.selectNodeContents(copyParagraph);
            const copySelection = window.getSelection();
            copySelection?.removeAllRanges();
            copySelection?.addRange(copyRange);
            const copyData = new DataTransfer();
            const copyEvent = new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: copyData });
            copyParagraph.dispatchEvent(copyEvent);
            const copiedPlain = copyData.getData("text/plain");
            const copiedHtml = copyData.getData("text/html");
            dualFormatCopy = copiedPlain.length > 0
              && copiedHtml.includes('data-fantastic-clipboard="v1"')
              && copiedHtml.includes('data-fantastic-plain-length="' + copiedPlain.length + '"')
              && copiedHtml.includes('data-fantastic-plain-hash="fnv1a32:');
            const selectAllEvent = new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true });
            copyParagraph.dispatchEvent(selectAllEvent);
            const allSelection = window.getSelection();
            const allCopyData = new DataTransfer();
            copyParagraph.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: allCopyData }));
            const allCopiedPlain = allCopyData.getData("text/plain");
            selectAllCopy = selectAllEvent.defaultPrevented
              && Boolean(allSelection && !allSelection.isCollapsed)
              && allCopiedPlain.length > copiedPlain.length
              && allCopiedPlain.includes("跨块格式甲")
              && allCopiedPlain.includes("const value = 1;");
          }
          const formatStart = selectAcrossParagraphs("跨块格式甲", "跨块格式乙");
          if (formatStart) {
            formatStart.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true, cancelable: true }));
            crossBlockFormatted = await waitFor(() => {
              const text = document.querySelector(".cm-content")?.textContent ?? "";
              return text.includes("**跨块格式甲**") && text.includes("**跨块格式乙**");
            });
          }
          const pasteReady = await waitFor(() => [...document.querySelectorAll(".wysiwyg-editor-layer.active p")].some((element) => element.textContent?.includes("跨块粘贴甲")));
          const pasteStart = pasteReady ? selectAcrossParagraphs("跨块粘贴甲", "跨块粘贴乙") : null;
          if (pasteStart) {
            const clipboard = new DataTransfer();
            clipboard.setData("text/plain", "批量甲\\r\\n# 批量乙");
            pasteStart.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }));
            crossBlockPasted = await waitFor(() => {
              const text = document.querySelector(".cm-content")?.textContent ?? "";
              const visualParagraphs = [...document.querySelectorAll(".wysiwyg-editor-layer.active p")].map((element) => element.textContent ?? "");
              return visualParagraphs.some((value) => value.includes("批量甲")) && visualParagraphs.some((value) => value.includes("# 批量乙"))
                && !text.includes("跨块粘贴甲") && !text.includes("跨块粘贴乙");
            });
          }
          const protectedReady = await waitFor(() => [...document.querySelectorAll(".wysiwyg-editor-layer.active p")].some((element) => element.textContent?.includes("批量乙")));
          const unsafeStart = protectedReady ? selectAcrossParagraphs("批量乙", "混合后") : null;
          if (unsafeStart) {
            const beforeUnsafe = document.querySelector(".cm-content")?.textContent ?? "";
            const deleteEvent = new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true });
            const prevented = !unsafeStart.dispatchEvent(deleteEvent);
            const afterUnsafe = document.querySelector(".cm-content")?.textContent ?? "";
            crossBlockProtectedRejected = prevented && beforeUnsafe === afterUnsafe && afterUnsafe.includes("$a+b$");
          }
          const imageReady = await waitFor(() => document.querySelector(".wysiwyg-editor-layer.active [data-source-kind=image]") instanceof HTMLElement);
          const imageElement = document.querySelector(".wysiwyg-editor-layer.active [data-source-kind=image]");
          if (imageReady && imageElement instanceof HTMLElement) {
            imageElement.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
            const altReady = await waitFor(() => document.querySelector("[data-testid=wysiwyg-image-alt]") instanceof HTMLInputElement);
            const altInput = document.querySelector("[data-testid=wysiwyg-image-alt]");
            if (altReady && altInput instanceof HTMLInputElement) {
              const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
              setter?.call(altInput, "更新后的图片说明");
              altInput.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
              document.querySelector(".wysiwyg-image-card > div button:first-child")?.click();
              imageAltEdited = await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes("![更新后的图片说明](missing.png)"));
            }
          }
          const linkAtomReady = await waitFor(() => document.querySelector(".wysiwyg-editor-layer.active [data-source-kind=inline-link]") instanceof HTMLElement);
          const linkAtom = document.querySelector(".wysiwyg-editor-layer.active [data-source-kind=inline-link]");
          if (linkAtomReady && linkAtom instanceof HTMLElement) {
            linkAtom.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
            const linkPanelReady = await waitFor(() => document.querySelector("[data-testid=wysiwyg-link-label]") instanceof HTMLInputElement);
            if (linkPanelReady) {
              const setInput = (selector, value) => {
                const input = document.querySelector(selector);
                if (!(input instanceof HTMLInputElement)) return false;
                const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
                setter?.call(input, value);
                input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
                return true;
              };
              setInput("[data-testid=wysiwyg-link-label]", "新链接");
              setInput("[data-testid=wysiwyg-link-destination]", "https://openai.com/docs");
              setInput("[data-testid=wysiwyg-link-title]", "文档入口");
              document.querySelector(".wysiwyg-source-card > div button:first-child")?.click();
              linkStructuredApplied = await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes('[新链接](https://openai.com/docs "文档入口")'));
            }
          }
          const inlineCodeAtom = document.querySelector(".wysiwyg-editor-layer.active [data-source-kind=inline-code]");
          if (inlineCodeAtom instanceof HTMLElement) {
            inlineCodeAtom.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
            const inlineCodeReady = await waitFor(() => document.querySelector("[data-testid=wysiwyg-inline-code-source]") instanceof HTMLInputElement);
            const inlineCodeInput = document.querySelector("[data-testid=wysiwyg-inline-code-source]");
            if (inlineCodeReady && inlineCodeInput instanceof HTMLInputElement) {
              const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
              setter?.call(inlineCodeInput, "代码\x60片段");
              inlineCodeInput.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
              document.querySelector(".wysiwyg-source-card > div button:first-child")?.click();
              inlineCodeStructuredApplied = await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes("\\x60\\x60代码\\x60片段\\x60\\x60"));
            }
          }
          const mixedParagraphReady = await waitFor(() => [...document.querySelectorAll(".wysiwyg-editor-layer.active p")].some((element) => element.textContent?.includes("混合前") && element.textContent?.includes("混合后")));
          const mixedParagraph = [...document.querySelectorAll(".wysiwyg-editor-layer.active p")].find((element) => element.textContent?.includes("混合前") && element.textContent?.includes("混合后"));
          if (mixedParagraphReady && mixedParagraph instanceof HTMLElement) {
            const mixedRect = mixedParagraph.getBoundingClientRect();
            mixedParagraph.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: mixedRect.right - 12, clientY: mixedRect.top + mixedRect.height / 2 }));
            const atoms = [...mixedParagraph.querySelectorAll(".wysiwyg-inline-atom")];
            mixedAtomsProtected = mixedParagraph.isContentEditable && atoms.length >= 4 && atoms.every((atom) => atom.getAttribute("contenteditable") === "false");
            const selection = window.getSelection();
            const protectedRange = document.createRange();
            protectedRange.selectNodeContents(mixedParagraph);
            selection?.removeAllRanges();
            selection?.addRange(protectedRange);
            const protectedDelete = new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true });
            protectedSelectionRejected = !mixedParagraph.dispatchEvent(protectedDelete);
            const walker = document.createTreeWalker(mixedParagraph, NodeFilter.SHOW_TEXT);
            let endingNode = walker.nextNode();
            while (endingNode && !endingNode.textContent?.includes("混合后")) endingNode = walker.nextNode();
            if (endingNode?.textContent) {
              const from = endingNode.textContent.indexOf("混合后");
              const endingRange = document.createRange();
              endingRange.setStart(endingNode, from);
              endingRange.setEnd(endingNode, from + "混合后".length);
              selection?.removeAllRanges();
              selection?.addRange(endingRange);
              document.execCommand("insertText", false, "结尾已编辑");
              mixedParagraph.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
              mixedInlineEdited = await waitFor(() => {
                const text = document.querySelector(".cm-content")?.textContent ?? "";
                return text.includes("结尾已编辑")
                  && text.includes("[新链接](https://openai.com/docs \\"文档入口\\")")
                  && text.includes("\\x60\\x60代码\\x60片段\\x60\\x60")
                  && text.includes("$a+b$")
                  && text.includes("![更新后的图片说明](missing.png)");
              });
            }
          }
          const firstTableCellReady = await waitFor(() => [...document.querySelectorAll(".wysiwyg-editor-layer.active td")].some((element) => element.textContent?.includes("2026Q3")));
          const firstTableCell = [...document.querySelectorAll(".wysiwyg-editor-layer.active td")].find((element) => element.textContent?.includes("2026Q3"));
          if (firstTableCellReady && firstTableCell instanceof HTMLElement) {
            const cellRect = firstTableCell.getBoundingClientRect();
            firstTableCell.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: cellRect.left + 4, clientY: cellRect.top + cellRect.height / 2 }));
            const cellSelection = window.getSelection();
            const cellRange = document.createRange();
            cellRange.selectNodeContents(firstTableCell);
            cellSelection?.removeAllRanges();
            cellSelection?.addRange(cellRange);
            document.execCommand("insertText", false, "2026Q4");
            firstTableCell.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
            const nextTableCell = document.activeElement;
            if (nextTableCell instanceof HTMLTableCellElement) {
              const nextRange = document.createRange();
              nextRange.selectNodeContents(nextTableCell);
              cellSelection?.removeAllRanges();
              cellSelection?.addRange(nextRange);
              document.execCommand("insertText", false, "上调");
              const secondColumnToolbarReady = await waitFor(() => document.querySelector(".wysiwyg-table-toolbar > span")?.textContent?.includes("第 2 列"));
              const insertColumn = [...document.querySelectorAll(".wysiwyg-table-toolbar button")].find((button) => button.textContent === "右侧插列");
              if (secondColumnToolbarReady && insertColumn instanceof HTMLButtonElement) insertColumn.click();
            }
            tableCellEdited = await waitFor(() => {
              const text = document.querySelector(".cm-content")?.textContent ?? "";
              return text.includes("2026Q4") && text.includes("上调");
            });
            tableColumnInserted = await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes("| 期间 | 情景 |  |"));
            const alignedCellReady = await waitFor(() => [...document.querySelectorAll(".wysiwyg-editor-layer.active table tr")].every((row) => row.querySelectorAll("th, td").length === 3) && [...document.querySelectorAll(".wysiwyg-editor-layer.active td")].some((element) => element.textContent?.includes("2026Q4")));
            const alignedCell = [...document.querySelectorAll(".wysiwyg-editor-layer.active td")].find((element) => element.textContent?.includes("2026Q4"));
            if (alignedCellReady && alignedCell instanceof HTMLElement) {
              const alignedRect = alignedCell.getBoundingClientRect();
              alignedCell.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: alignedRect.left + 4, clientY: alignedRect.top + alignedRect.height / 2 }));
              const firstColumnToolbarReady = await waitFor(() => document.querySelector(".wysiwyg-table-toolbar > span")?.textContent?.includes("第 1 列"));
              const centerButton = [...document.querySelectorAll(".wysiwyg-table-toolbar button")].find((button) => button.textContent === "居中");
              if (firstColumnToolbarReady && centerButton instanceof HTMLButtonElement) centerButton.click();
              tableAlignmentApplied = await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes("| :---: | --- | --- |"));
            }
            const lastCellReady = await waitFor(() => {
              const rows = document.querySelectorAll(".wysiwyg-editor-layer.active table tbody tr");
              return rows.length > 0 && rows[rows.length - 1]?.querySelectorAll("td").length === 3;
            });
            const bodyRows = document.querySelectorAll(".wysiwyg-editor-layer.active table tbody tr");
            const lastCell = bodyRows[bodyRows.length - 1]?.querySelector("td:last-child");
            if (lastCellReady && lastCell instanceof HTMLElement) {
              const lastRect = lastCell.getBoundingClientRect();
              lastCell.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: lastRect.left + 4, clientY: lastRect.top + lastRect.height / 2 }));
              const lastColumnToolbarReady = await waitFor(() => document.querySelector(".wysiwyg-table-toolbar > span")?.textContent?.includes("第 3 列"));
              if (lastColumnToolbarReady) {
                lastCell.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
                tableRowAppended = await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes("|  |  |  |"));
              }
            }
          }
          const listReady = await waitFor(() => [...document.querySelectorAll(".wysiwyg-editor-layer.active li")].some((element) => element.textContent?.includes("列表原项")));
          const listItem = [...document.querySelectorAll(".wysiwyg-editor-layer.active li")].find((element) => element.textContent?.includes("列表原项"));
          if (listReady && listItem instanceof HTMLElement) {
            const itemRect = listItem.getBoundingClientRect();
            listItem.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: itemRect.left + 8, clientY: itemRect.top + itemRect.height / 2 }));
            const itemSelection = window.getSelection();
            const itemRange = document.createRange();
            itemRange.selectNodeContents(listItem);
            itemSelection?.removeAllRanges();
            itemSelection?.addRange(itemRange);
            listDirectReady = listItem.isContentEditable && document.activeElement === listItem;
            listBrowserInserted = document.execCommand("insertText", false, "列表已编辑");
            listItem.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
            listBrowserInserted = document.execCommand("insertText", false, "列表第二项") && listBrowserInserted;
            listItem.blur();
            listItemEdited = await waitFor(() => {
              const text = document.querySelector(".cm-content")?.textContent ?? "";
              return text.includes("列表已编辑") && text.includes("列表第二项");
            });
          }
          const secondListReady = await waitFor(() => [...document.querySelectorAll(".wysiwyg-editor-layer.active li")].some((element) => element.textContent?.trim() === "列表第二项"));
          const secondListItem = [...document.querySelectorAll(".wysiwyg-editor-layer.active li")].find((element) => element.textContent?.trim() === "列表第二项");
          if (secondListReady && secondListItem instanceof HTMLElement) {
            const secondRect = secondListItem.getBoundingClientRect();
            secondListItem.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: secondRect.left + 8, clientY: secondRect.top + secondRect.height / 2 }));
            secondListItem.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
            listIndented = await waitFor(() => [...document.querySelectorAll(".wysiwyg-editor-layer.active li li")].some((element) => element.textContent?.trim() === "列表第二项"));
            const nestedItem = [...document.querySelectorAll(".wysiwyg-editor-layer.active li li")].find((element) => element.textContent?.trim() === "列表第二项");
            if (nestedItem instanceof HTMLElement) {
              const nestedRect = nestedItem.getBoundingClientRect();
              nestedItem.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: nestedRect.left + 8, clientY: nestedRect.top + nestedRect.height / 2 }));
              nestedItem.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
              listOutdented = await waitFor(() => [...document.querySelectorAll(".wysiwyg-editor-layer.active .wysiwyg-content > ul > li")].some((element) => element.textContent?.trim() === "列表第二项"));
            }
          }
          const nestedParentReady = await waitFor(() => [...document.querySelectorAll(".wysiwyg-editor-layer.active [data-wysiwyg-list-own-content]")].some((element) => element.textContent?.trim() === "嵌套父项"));
          const nestedParent = [...document.querySelectorAll(".wysiwyg-editor-layer.active [data-wysiwyg-list-own-content]")].find((element) => element.textContent?.trim() === "嵌套父项");
          if (nestedParentReady && nestedParent instanceof HTMLElement) {
            const parentRect = nestedParent.getBoundingClientRect();
            nestedParent.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: parentRect.left + 8, clientY: parentRect.top + parentRect.height / 2 }));
            const parentSelection = window.getSelection();
            const parentRange = document.createRange();
            parentRange.selectNodeContents(nestedParent);
            parentSelection?.removeAllRanges();
            parentSelection?.addRange(parentRange);
            document.execCommand("insertText", false, "嵌套父项已编辑");
            nestedParent.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
            nestedParentEdited = await waitFor(() => {
              const own = [...document.querySelectorAll(".wysiwyg-editor-layer.active [data-wysiwyg-list-own-content]")].find((element) => element.textContent?.trim() === "嵌套父项已编辑");
              const item = own?.closest("li");
              return Boolean(item && [...item.querySelectorAll(":scope > ul > li")].some((child) => child.textContent?.includes("嵌套子项"))
                && [...item.querySelectorAll(":scope > ul > li")].some((child) => child.textContent?.includes("嵌套任务")));
            });
          }
          const parentForIndent = [...document.querySelectorAll(".wysiwyg-editor-layer.active [data-wysiwyg-list-own-content]")].find((element) => element.textContent?.trim() === "嵌套父项已编辑");
          if (parentForIndent instanceof HTMLElement) {
            const parentRect = parentForIndent.getBoundingClientRect();
            parentForIndent.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: parentRect.left + 8, clientY: parentRect.top + parentRect.height / 2 }));
            parentForIndent.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
            nestedSubtreeIndented = await waitFor(() => {
              const own = [...document.querySelectorAll(".wysiwyg-editor-layer.active [data-wysiwyg-list-own-content]")].find((element) => element.textContent?.trim() === "嵌套父项已编辑");
              const item = own?.closest("li");
              return Boolean(item?.parentElement?.closest("li")
                && [...(item?.querySelectorAll(":scope > ul > li") ?? [])].some((child) => child.textContent?.includes("嵌套子项")));
            });
            const parentForOutdent = [...document.querySelectorAll(".wysiwyg-editor-layer.active [data-wysiwyg-list-own-content]")].find((element) => element.textContent?.trim() === "嵌套父项已编辑");
            if (parentForOutdent instanceof HTMLElement) {
              const outdentRect = parentForOutdent.getBoundingClientRect();
              parentForOutdent.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: outdentRect.left + 8, clientY: outdentRect.top + outdentRect.height / 2 }));
              parentForOutdent.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
              nestedSubtreeOutdented = await waitFor(() => {
                const own = [...document.querySelectorAll(".wysiwyg-editor-layer.active [data-wysiwyg-list-own-content]")].find((element) => element.textContent?.trim() === "嵌套父项已编辑");
                const item = own?.closest("li");
                return Boolean(item && !item.parentElement?.closest("li")
                  && [...item.querySelectorAll(":scope > ul > li")].some((child) => child.textContent?.includes("嵌套任务")));
              });
            }
          }
          const quoteReady = await waitFor(() => [...document.querySelectorAll(".wysiwyg-editor-layer.active blockquote p")].some((element) => element.textContent?.includes("引用原文")));
          const quote = [...document.querySelectorAll(".wysiwyg-editor-layer.active blockquote p")].find((element) => element.textContent?.includes("引用原文"));
          if (quoteReady && quote instanceof HTMLElement) {
            const quoteRect = quote.getBoundingClientRect();
            quote.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: quoteRect.left + 8, clientY: quoteRect.top + quoteRect.height / 2 }));
            const quoteSelection = window.getSelection();
            const quoteRange = document.createRange();
            quoteRange.selectNodeContents(quote);
            quoteSelection?.removeAllRanges();
            quoteSelection?.addRange(quoteRange);
            document.execCommand("insertText", false, "引用已编辑");
            quote.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
            quoteEdited = await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes("引用已编辑"));
          }
          const taskReady = await waitFor(() => document.querySelector(".wysiwyg-editor-layer.active li input[type=checkbox]") instanceof HTMLInputElement);
          const task = document.querySelector(".wysiwyg-editor-layer.active li input[type=checkbox]");
          if (taskReady && task instanceof HTMLInputElement) {
            task.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
            taskToggled = await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes("[x] 待完成"));
          }
          const paragraph = [...document.querySelectorAll(".wysiwyg-editor-layer.active .wysiwyg-content p[data-source-from]")].find((element) => element.textContent?.includes("下表为"));
          if (!(paragraph instanceof HTMLElement)) return { exists: true, ready, edited: false };
          const paragraphRect = paragraph.getBoundingClientRect();
          paragraph.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: paragraphRect.left + paragraphRect.width / 2, clientY: paragraphRect.top + paragraphRect.height / 2 }));
          const initialSelection = window.getSelection();
          const caretInside = Boolean(initialSelection?.anchorNode && paragraph.contains(initialSelection.anchorNode));
          const directInputReady = paragraph.isContentEditable && document.activeElement === paragraph && caretInside;
          const replacementRange = document.createRange();
          replacementRange.selectNodeContents(paragraph);
          initialSelection?.removeAllRanges();
          initialSelection?.addRange(replacementRange);
          const browserInserted = document.execCommand("insertText", false, "可视编辑已写回");
          const formatRange = document.createRange();
          formatRange.selectNodeContents(paragraph);
          initialSelection?.removeAllRanges();
          initialSelection?.addRange(formatRange);
          paragraph.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true, cancelable: true }));
          paragraph.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
          const edited = await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes("可视编辑已写回"));
          const formatted = await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes("**可视编辑已写回**"));
          const afterEdit = document.querySelector(".cm-content")?.textContent ?? "";
          window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
          const undone = await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes("中性情景"));
          const afterUndo = document.querySelector(".cm-content")?.textContent ?? "";
          window.dispatchEvent(new KeyboardEvent("keydown", { key: "y", ctrlKey: true, bubbles: true, cancelable: true }));
          const redone = await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes("可视编辑已写回"));
          const afterRedo = document.querySelector(".cm-content")?.textContent ?? "";
          const paragraphAfterRedoReady = await waitFor(() => Boolean([...document.querySelectorAll(".wysiwyg-editor-layer.active .wysiwyg-content > p")].find((element) => element.textContent?.includes("可视编辑已写回"))));
          const paragraphAfterRedo = [...document.querySelectorAll(".wysiwyg-editor-layer.active .wysiwyg-content > p")].find((element) => element.textContent?.includes("可视编辑已写回"));
          let paragraphBreaks = false;
          let mergedParagraphs = false;
          if (paragraphAfterRedoReady && paragraphAfterRedo instanceof HTMLElement) {
            const redoRect = paragraphAfterRedo.getBoundingClientRect();
            paragraphAfterRedo.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: redoRect.right - 4, clientY: redoRect.top + redoRect.height / 2 }));
            const endRange = document.createRange();
            endRange.selectNodeContents(paragraphAfterRedo);
            endRange.collapse(false);
            const endSelection = window.getSelection();
            endSelection?.removeAllRanges();
            endSelection?.addRange(endRange);
            paragraphAfterRedo.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
            document.execCommand("insertText", false, "第二段");
            paragraphAfterRedo.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
            document.execCommand("insertText", false, "软换行");
            paragraphAfterRedo.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
            paragraphBreaks = await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes("第二段") && (document.querySelector(".cm-content")?.textContent ?? "").includes("软换行"));
            const secondParagraphReady = await waitFor(() => Boolean([...document.querySelectorAll(".wysiwyg-editor-layer.active .wysiwyg-content > p")].find((element) => element.textContent?.includes("第二段"))));
            const secondParagraph = [...document.querySelectorAll(".wysiwyg-editor-layer.active .wysiwyg-content > p")].find((element) => element.textContent?.includes("第二段"));
            if (secondParagraphReady && secondParagraph instanceof HTMLElement) {
              const secondRect = secondParagraph.getBoundingClientRect();
              secondParagraph.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: secondRect.left + 3, clientY: secondRect.top + secondRect.height / 2 }));
              const startRange = document.createRange();
              startRange.selectNodeContents(secondParagraph);
              startRange.collapse(true);
              const startSelection = window.getSelection();
              startSelection?.removeAllRanges();
              startSelection?.addRange(startRange);
              secondParagraph.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
              mergedParagraphs = await waitFor(() => ![...document.querySelectorAll(".wysiwyg-editor-layer.active .wysiwyg-content > p")].some((element) => element.textContent === "第二段软换行"));
            }
          }
          const visualContent = document.querySelector(".wysiwyg-editor-layer.active .wysiwyg-content");
          let compositionDeferred = false;
          let blankParagraphAdded = false;
          let blankParagraphDeduplicated = false;
          let blankParagraphDeleted = false;
          if (visualContent instanceof HTMLElement) {
            const contentRect = visualContent.getBoundingClientRect();
            visualContent.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: contentRect.left + contentRect.width / 2, clientY: contentRect.bottom - 8 }));
            const firstBlankParagraph = visualContent.querySelector("[data-wysiwyg-new-block=true]");
            visualContent.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: contentRect.left + contentRect.width / 2, clientY: contentRect.bottom - 18 }));
            blankParagraphDeduplicated = visualContent.querySelectorAll("[data-wysiwyg-new-block=true]").length === 1;
            if (firstBlankParagraph instanceof HTMLElement) {
              firstBlankParagraph.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
              blankParagraphDeleted = await waitFor(() => visualContent.querySelectorAll("[data-wysiwyg-new-block=true]").length === 0);
            }
            visualContent.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: contentRect.left + contentRect.width / 2, clientY: contentRect.bottom - 8 }));
            const blankParagraph = visualContent.querySelector("[data-wysiwyg-new-block=true]");
            if (blankParagraph instanceof HTMLElement) {
              blankParagraph.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "shuru" }));
              document.execCommand("insertText", false, "输入法新增");
              await new Promise((resolve) => setTimeout(resolve, 850));
              compositionDeferred = !(document.querySelector(".cm-content")?.textContent ?? "").includes("输入法新增");
              blankParagraph.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "输入法新增" }));
              blankParagraph.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
              blankParagraphAdded = await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes("输入法新增"));
            }
          }
          let multilinePasteHandled = false;
          let multilinePasteError = "";
          try {
          const pasteContent = document.querySelector(".wysiwyg-editor-layer.active .wysiwyg-content");
          if (pasteContent instanceof HTMLElement) {
            const pasteRect = pasteContent.getBoundingClientRect();
            pasteContent.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: pasteRect.left + pasteRect.width / 2, clientY: pasteRect.bottom - 8 }));
            const pasteParagraph = pasteContent.querySelector("[data-wysiwyg-new-block=true]");
            if (pasteParagraph instanceof HTMLElement) {
              const clipboardData = new DataTransfer();
              clipboardData.setData("text/plain", "粘贴第一行\\r\\n粘贴第二行");
              pasteParagraph.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
              pasteParagraph.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
              multilinePasteHandled = await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes("粘贴第一行") && (document.querySelector(".cm-content")?.textContent ?? "").includes("粘贴第二行"));
            }
          }
          } catch (error) {
            multilinePasteError = error instanceof Error ? error.message : String(error);
          }
          try {
            const htmlParagraph = [...document.querySelectorAll(".wysiwyg-editor-layer.active p[data-wysiwyg-editability=direct]")]
              .find((element) => element.textContent?.includes("剪贴板 HTML 测试"));
            if (htmlParagraph instanceof HTMLElement) {
              const htmlRect = htmlParagraph.getBoundingClientRect();
              htmlParagraph.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: htmlRect.left + 8, clientY: htmlRect.top + htmlRect.height / 2 }));
              const htmlRange = document.createRange();
              htmlRange.selectNodeContents(htmlParagraph);
              const htmlSelection = window.getSelection();
              htmlSelection?.removeAllRanges();
              htmlSelection?.addRange(htmlRange);
              const clipboardData = new DataTransfer();
              clipboardData.setData("text/plain", "外部加粗\\n外部图");
              clipboardData.setData("text/html", '<p><strong>外部加粗</strong></p><p><img src="file:///secret.png" alt="外部图"></p>');
              htmlParagraph.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
              htmlParagraph.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
              externalHtmlPaste = await waitFor(() => {
                const text = document.querySelector(".cm-content")?.textContent ?? "";
                return text.includes("**外部加粗**") && text.includes("![外部图]（图片未包含）");
              });
              await waitFor(() => [...document.querySelectorAll(".wysiwyg-editor-layer.active p[data-wysiwyg-editability=direct]")]
                .some((element) => element.textContent?.includes("外部加粗")));
              const richTarget = [...document.querySelectorAll(".wysiwyg-editor-layer.active p[data-wysiwyg-editability=direct]")]
                .find((element) => element.textContent?.includes("外部加粗"));
              if (richTarget instanceof HTMLElement) {
                const richRange = document.createRange();
                richRange.selectNodeContents(richTarget);
                htmlSelection?.removeAllRanges();
                htmlSelection?.addRange(richRange);
                const richData = new DataTransfer();
                richData.setData("text/plain", "\\\\# IMA 标题\\n\\\\- 一级\\n  \\\\- 二级\\n3\\\\. 第三项");
                richData.setData("text/html", "<h1>IMA 标题</h1><ul><li><strong>一级</strong><ul><li>二级</li></ul></li></ul><ol start=3><li>第三项</li></ol>");
                richTarget.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: richData }));
                richTarget.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
                imaRichPaste = await waitFor(() => {
                  const text = document.querySelector(".cm-content")?.textContent ?? "";
                  imaPasteSnapshot = text;
                  return text.includes("# IMA 标题") && text.includes("- **一级**") && text.includes("  - 二级") && text.includes("3. 第三项") && !text.includes("\\\\# IMA 标题");
                });
              }
            }
          } catch (error) {
            multilinePasteError = [multilinePasteError, error instanceof Error ? error.message : String(error)].filter(Boolean).join(" | ");
          }
          const diagramReady = await waitFor(() => {
            const content = document.querySelector(".wysiwyg-editor-layer.active .wysiwyg-content");
            const candidate = content?.querySelector(".mermaid-diagram");
            return projectionReady() && Boolean(candidate && content) && Number(candidate?.getAttribute("data-source-to")) <= Number(content?.getAttribute("data-document-length"));
          });
          const diagram = diagramReady ? document.querySelector(".wysiwyg-editor-layer.active .mermaid-diagram") : null;
          diagram?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
          const sourceAreaReady = await waitFor(() => document.querySelector(".wysiwyg-source-card textarea") instanceof HTMLTextAreaElement);
          const sourceArea = document.querySelector(".wysiwyg-source-card textarea");
          if (sourceArea instanceof HTMLTextAreaElement) {
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
            setter?.call(sourceArea, sourceArea.value.replace("A --> B", "A --> C"));
            sourceArea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
            document.querySelector(".wysiwyg-source-card > div button:first-child")?.click();
          }
          const sourceCardApplied = sourceAreaReady && await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes("A --> C"));
          document.querySelector(".wysiwyg-source-card > div button:last-child")?.click();

          const formulaReady = await waitFor(() => projectionReady() && document.querySelector(".wysiwyg-editor-layer.active .preview-formula-block") instanceof HTMLElement);
          const formulaBlock = document.querySelector(".wysiwyg-editor-layer.active .preview-formula-block");
          if (formulaReady && formulaBlock instanceof HTMLElement) {
            formulaBlock.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
            const formulaInputReady = await waitFor(() => document.querySelector("[data-testid=wysiwyg-formula-source]") instanceof HTMLTextAreaElement);
            const formulaInput = document.querySelector("[data-testid=wysiwyg-formula-source]");
            if (formulaInputReady && formulaInput instanceof HTMLTextAreaElement) {
              const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
              setter?.call(formulaInput, "x^2 + y^2");
              formulaInput.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
              document.querySelector(".wysiwyg-source-card > div button:first-child")?.click();
              formulaStructuredApplied = await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes("x^2 + y^2"));
              document.querySelector(".wysiwyg-source-card > div button:last-child")?.click();
            }
          }

          const codeReady = await waitFor(() => projectionReady() && document.querySelector(".wysiwyg-editor-layer.active pre > code.language-ts") instanceof HTMLElement);
          const codeBlock = document.querySelector(".wysiwyg-editor-layer.active pre > code.language-ts")?.closest("pre");
          if (codeReady && codeBlock instanceof HTMLElement) {
            codeBlock.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
            const codeInputReady = await waitFor(() => document.querySelector("[data-testid=wysiwyg-code-source]") instanceof HTMLTextAreaElement);
            const codeInput = document.querySelector("[data-testid=wysiwyg-code-source]");
            const languageInput = document.querySelector("[data-testid=wysiwyg-code-language]");
            if (codeInputReady && codeInput instanceof HTMLTextAreaElement && languageInput instanceof HTMLInputElement) {
              const textSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
              textSetter?.call(codeInput, "const value = 2;");
              codeInput.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
              const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
              inputSetter?.call(languageInput, "javascript");
              languageInput.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
              document.querySelector(".wysiwyg-source-card > div button:first-child")?.click();
              codeStructuredApplied = await waitFor(() => {
                const text = document.querySelector(".cm-content")?.textContent ?? "";
                return text.includes("const value = 2;") && text.includes("javascript");
              });
              document.querySelector(".wysiwyg-source-card > div button:last-child")?.click();
            }
          }
          const headingForBlocks = [...document.querySelectorAll(".wysiwyg-editor-layer.active h1")].find((element) => element.textContent?.includes("Mermaid smoke"));
          if (headingForBlocks instanceof HTMLElement) {
            const rect = headingForBlocks.getBoundingClientRect();
            headingForBlocks.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: rect.left + 8, clientY: rect.top + rect.height / 2 }));
            const blockToolbarReady = await waitFor(() => document.querySelector(".wysiwyg-block-toolbar select") instanceof HTMLSelectElement);
            const insertSelect = document.querySelector(".wysiwyg-block-toolbar select");
            if (blockToolbarReady && insertSelect instanceof HTMLSelectElement) {
              const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
              setter?.call(insertSelect, "quote");
              insertSelect.dispatchEvent(new Event("change", { bubbles: true }));
              [...document.querySelectorAll(".wysiwyg-block-toolbar button")].find((button) => button.textContent?.includes("下方插入"))?.click();
              blockInserted = await waitFor(() => [...document.querySelectorAll(".wysiwyg-editor-layer.active blockquote")].some((element) => element.textContent?.includes("新引用")));
            }
          }
          const insertedQuote = [...document.querySelectorAll(".wysiwyg-editor-layer.active blockquote")].find((element) => element.textContent?.includes("新引用"));
          if (insertedQuote instanceof HTMLElement) {
            const rect = insertedQuote.getBoundingClientRect();
            insertedQuote.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: rect.left + 8, clientY: rect.top + rect.height / 2 }));
            const gripReady = await waitFor(() => document.querySelector(".wysiwyg-block-grip") instanceof HTMLButtonElement);
            const grip = document.querySelector(".wysiwyg-block-grip");
            const targetHeading = document.querySelector(".wysiwyg-editor-layer.active h1");
            if (gripReady && grip instanceof HTMLButtonElement && targetHeading instanceof HTMLElement) {
              const transfer = new DataTransfer();
              grip.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: transfer }));
              const targetRect = targetHeading.getBoundingClientRect();
              targetHeading.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, clientY: targetRect.top + 1, dataTransfer: transfer }));
              targetHeading.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, clientY: targetRect.top + 1, dataTransfer: transfer }));
              blockDragged = await waitFor(() => document.querySelector(".wysiwyg-editor-layer.active .wysiwyg-content > blockquote")?.textContent?.includes("新引用") ?? false);
            }
          }
          await waitFor(() => [...document.querySelectorAll(".wysiwyg-editor-layer.active blockquote")].filter((element) => element.textContent?.includes("新引用")).length === 1);
          const quoteForKeyboard = [...document.querySelectorAll(".wysiwyg-editor-layer.active blockquote")].find((element) => element.textContent?.includes("新引用"));
          if (quoteForKeyboard instanceof HTMLElement) {
            const rect = quoteForKeyboard.getBoundingClientRect();
            const paragraph = quoteForKeyboard.querySelector("p") ?? quoteForKeyboard;
            paragraph.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: rect.left + 8, clientY: rect.top + rect.height / 2 }));
            paragraph.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true, cancelable: true }));
            blockKeyboardMoved = await waitFor(() => {
              const first = document.querySelector(".wysiwyg-editor-layer.active .wysiwyg-content > :first-child");
              return !(first instanceof HTMLQuoteElement) && [...document.querySelectorAll(".wysiwyg-editor-layer.active blockquote")].filter((element) => element.textContent?.includes("新引用")).length === 1;
            });
          }
          await waitFor(() => [...document.querySelectorAll(".wysiwyg-editor-layer.active blockquote")].filter((element) => element.textContent?.includes("新引用")).length === 1);
          const quoteForDuplicate = [...document.querySelectorAll(".wysiwyg-editor-layer.active blockquote")].find((element) => element.textContent?.includes("新引用"));
          if (quoteForDuplicate instanceof HTMLElement) {
            const rect = quoteForDuplicate.getBoundingClientRect();
            quoteForDuplicate.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: rect.left + 8, clientY: rect.top + rect.height / 2 }));
            await waitFor(() => [...document.querySelectorAll(".wysiwyg-block-toolbar button")].some((button) => button.textContent?.trim() === "复制"));
            [...document.querySelectorAll(".wysiwyg-block-toolbar button")].find((button) => button.textContent?.trim() === "复制")?.click();
            blockDuplicated = await waitFor(() => [...document.querySelectorAll(".wysiwyg-editor-layer.active blockquote")].filter((element) => element.textContent?.includes("新引用")).length === 2);
          }
          await waitFor(() => [...document.querySelectorAll(".wysiwyg-editor-layer.active blockquote")].filter((element) => element.textContent?.includes("新引用")).length === 2);
          const quoteForDelete = [...document.querySelectorAll(".wysiwyg-editor-layer.active blockquote")].find((element) => element.textContent?.includes("新引用"));
          if (quoteForDelete instanceof HTMLElement) {
            const rect = quoteForDelete.getBoundingClientRect();
            quoteForDelete.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: rect.left + 8, clientY: rect.top + rect.height / 2 }));
            await waitFor(() => [...document.querySelectorAll(".wysiwyg-block-toolbar button")].some((button) => button.textContent?.trim() === "删除"));
            const originalConfirm = window.confirm;
            window.confirm = () => true;
            [...document.querySelectorAll(".wysiwyg-block-toolbar button")].find((button) => button.textContent?.trim() === "删除")?.click();
            window.confirm = originalConfirm;
            blockDeleted = await waitFor(() => [...document.querySelectorAll(".wysiwyg-editor-layer.active blockquote")].filter((element) => element.textContent?.includes("新引用")).length === 1);
          }          sourceButton.click();
          await new Promise((resolve) => setTimeout(resolve, 150));
          return {
            exists: true,
            ready,
            edited,
            directInputReady,
            caretInside,
            browserInserted,
            formatted,
            paragraphBreaks,
            mergedParagraphs,
            compositionDeferred,
            blankParagraphAdded,
            blankParagraphDeduplicated,
            blankParagraphDeleted,
            multilinePasteHandled,
            imageAltEdited,
            formulaStructuredApplied,
            codeStructuredApplied,
            linkStructuredApplied,
            inlineCodeStructuredApplied,
            mixedInlineEdited,
            mixedAtomsProtected,
            protectedSelectionRejected,
            crossBlockFormatted,
            crossBlockPasted,
            crossBlockProtectedRejected,
            dualFormatCopy,
            selectAllCopy,
            externalHtmlPaste,
            imaRichPaste,
            imaPasteSnapshot,
            blockInserted,
            blockDragged,
            blockDuplicated,
            blockDeleted,
            blockKeyboardMoved,
            tableCellEdited,
            tableColumnInserted,
            tableAlignmentApplied,
            tableRowAppended,
            listItemEdited,
            listDirectReady,
            listBrowserInserted,
            listIndented,
            listOutdented,
            nestedParentEdited,
            nestedSubtreeIndented,
            nestedSubtreeOutdented,
            quoteEdited,
            taskToggled,
            multilinePasteError,
            undone,
            redone,
            sourceCardApplied,
            sourceAreaReady,
            sourceAreaValue: sourceArea instanceof HTMLTextAreaElement ? sourceArea.value : "",
            sourceCardLabel: document.querySelector(".wysiwyg-source-card")?.getAttribute("aria-label") ?? "",
            visualWasActive: visualButton.getAttribute("aria-pressed") === "false",
            sourceRestored: sourceButton.getAttribute("aria-pressed") === "true" && Boolean(document.querySelector(".source-editor-layer.active")) && Boolean(document.querySelector(".split-handle")),
            afterEdit,
            afterUndo,
            afterRedo
          };
          } catch (error) {
            return { exists: true, testError: error instanceof Error ? error.name + ": " + error.message + "\\n" + (error.stack ?? "") : String(error) };
          }
        })()`, true) as { exists: boolean; ready?: boolean; edited?: boolean; directInputReady?: boolean; caretInside?: boolean; browserInserted?: boolean; formatted?: boolean; paragraphBreaks?: boolean; mergedParagraphs?: boolean; compositionDeferred?: boolean; blankParagraphAdded?: boolean; blankParagraphDeduplicated?: boolean; blankParagraphDeleted?: boolean; multilinePasteHandled?: boolean; imageAltEdited?: boolean; formulaStructuredApplied?: boolean; codeStructuredApplied?: boolean; linkStructuredApplied?: boolean; inlineCodeStructuredApplied?: boolean; mixedInlineEdited?: boolean; mixedAtomsProtected?: boolean; protectedSelectionRejected?: boolean; crossBlockFormatted?: boolean; crossBlockPasted?: boolean; crossBlockProtectedRejected?: boolean; dualFormatCopy?: boolean; selectAllCopy?: boolean; externalHtmlPaste?: boolean; imaRichPaste?: boolean; blockInserted?: boolean; blockDragged?: boolean; blockDuplicated?: boolean; blockDeleted?: boolean; blockKeyboardMoved?: boolean; tableCellEdited?: boolean; tableColumnInserted?: boolean; tableAlignmentApplied?: boolean; tableRowAppended?: boolean; listItemEdited?: boolean; listDirectReady?: boolean; listBrowserInserted?: boolean; listIndented?: boolean; listOutdented?: boolean; nestedParentEdited?: boolean; nestedSubtreeIndented?: boolean; nestedSubtreeOutdented?: boolean; quoteEdited?: boolean; taskToggled?: boolean; undone?: boolean; redone?: boolean; sourceCardApplied?: boolean; visualWasActive?: boolean; sourceRestored?: boolean; afterEdit?: string; afterUndo?: string; afterRedo?: string };
        const viewWorkflow = await window.webContents.executeJavaScript(`(async () => {
          try {
          const waitFor = async (predicate, timeout = 8000) => {
            const deadline = Date.now() + timeout;
            while (Date.now() < deadline) {
              if (predicate()) return true;
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            return false;
          };
          const visualButton = document.querySelector("[data-testid=editor-mode-switch] button:last-child");
          const sourceButton = document.querySelector("[data-testid=editor-mode-switch] button:first-child");
          if (!(visualButton instanceof HTMLButtonElement) || !(sourceButton instanceof HTMLButtonElement)) return { fontControl: false, scrollPreserved: false, directPreview: false, previewMermaid: false, inlineOutline: false, outlineButtonRemoved: false, repairButton: false, searchButton: false };
          visualButton.click();
          await waitFor(() => Boolean(document.querySelector(".wysiwyg-editor-layer.active .wysiwyg-content")));
          const container = document.querySelector(".wysiwyg-editor-layer.active .wysiwyg-editor");
          const font = document.querySelector("[data-testid=wysiwyg-font-select]");
          let scrollPreserved = false;
          if (container instanceof HTMLElement && font instanceof HTMLInputElement) {
            container.scrollTop = Math.min(700, Math.max(1, container.scrollHeight - container.clientHeight));
            const before = container.scrollTop;
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
            setter?.call(font, font.value === "KaiTi" ? "Arial" : "KaiTi");
            font.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
            font.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
            await new Promise((resolve) => setTimeout(resolve, 500));
            scrollPreserved = before > 0 && container.scrollTop > 0;
          }
          document.querySelector('button[aria-label="仅预览"]')?.click();
          const directPreview = await waitFor(() => Boolean(document.querySelector(".document-stage.view-preview .preview-pane")));
          const previewMermaid = directPreview && await waitFor(() => Boolean(document.querySelector(".document-stage.view-preview .mermaid-diagram svg")));
          const outlineButtonRemoved = ![...document.querySelectorAll(".header-nav-button")].some((button) => button.textContent?.includes("目录"));
          const openEditorButton = document.querySelector(".open-editor-select");
          openEditorButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          const inlineOutline = await waitFor(() => Boolean(document.querySelector(".open-editor-entry .inline-outline .document-outline")));
          const repairButton = [...document.querySelectorAll(".header-nav-button")].some((button) => button.textContent?.includes("修复网页 Markdown") && button instanceof HTMLButtonElement && !button.disabled);
          const searchButton = [...document.querySelectorAll(".header-nav-button")].some((button) => button.textContent?.includes("查找/替换"));
          document.querySelector('button[aria-label="仅编辑"]')?.click();
          sourceButton.click();
          await waitFor(() => Boolean(document.querySelector(".source-editor-layer.active")));
          return { fontControl: font instanceof HTMLInputElement, scrollPreserved, directPreview, previewMermaid, inlineOutline, outlineButtonRemoved, repairButton, searchButton };
          } catch (error) {
            return { fontControl: false, scrollPreserved: false, directPreview: false, previewMermaid: false, inlineOutline: false, outlineButtonRemoved: false, repairButton: false, searchButton: false, testError: error instanceof Error ? error.name + ": " + error.message + "\\n" + (error.stack ?? "") : String(error) };
          }
        })()`, true) as { fontControl: boolean; scrollPreserved: boolean; directPreview: boolean; previewMermaid: boolean; inlineOutline: boolean; outlineButtonRemoved: boolean; repairButton: boolean; searchButton: boolean };
        const imageBridge = await window.webContents.executeJavaScript(`(async () => {
          const binary = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII="), character => character.charCodeAt(0));
          const file = new File([binary], "smoke.png", { type: "image/png" });
          const result = await window.fantasticEditor.importDroppedImages({ importRequestId: "image-import-smoke", sessionId: "smoke-session", documentId: "smoke-document", workspaceRevision: 1 }, [file]);
          return { status: result.status, error: result.error ?? "" };
        })()`, true) as { status: string; error: string };
        const themeBefore = await window.webContents.executeJavaScript(`document.querySelector(\".app-shell\")?.classList.contains(\"theme-dark\") ?? false`, true) as boolean;
        await window.webContents.executeJavaScript(`document.querySelector(\".theme-toggle\")?.click()`, true);
        await new Promise((resolve) => setTimeout(resolve, 100));
        const themeAfter = await window.webContents.executeJavaScript(`document.querySelector(\".app-shell\")?.classList.contains(\"theme-dark\") ?? false`, true) as boolean;
        await window.webContents.executeJavaScript(`document.querySelector("[data-testid=editor-mode-switch] button:last-child")?.click()`, true);
        await new Promise((resolve) => setTimeout(resolve, 300));
        window.show();
        await new Promise((resolve) => setTimeout(resolve, 250));
        const image = await window.webContents.capturePage();
        await writeFile(join(process.cwd(), "fantastic-editor-ui-smoke.png"), image.toPNG());
        await window.webContents.executeJavaScript(`document.querySelector(\".theme-toggle\")?.click()`, true);
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (syncEnabled !== syncBefore) await window.webContents.executeJavaScript(`document.querySelector("[data-testid=sync-scroll-toggle]")?.click()`, true);
          const valid = uiReady && before.hasTabs && before.hasDropHint && before.hasNewButton && drag.hasDropOverlay && after.tabCount === 1 && after.tabText === "未命名" && after.editorText === "" && after.saveEnabled && after.hasUnsavedIndicator && after.brandText.includes("fantasticeditor") && after.hasSidebar && after.hasSplitHandle && after.hasInsertImageButton && after.hasSyncScrollButton && after.viewportFits && accessibility.keyboardSeparator && accessibility.selectedTab && accessibility.liveStatus && recentBoundary.listed && recentBoundary.opaque && tabShortcuts.created && tabShortcuts.reorderedLeft && tabShortcuts.reorderedRight && tabShortcuts.previous && tabShortcuts.next && tabShortcuts.closed && fontControl.exists && fontControl.applied && fontControl.hasArial && fontApplied && mermaidRendered && performanceMetric.exists && performanceMetric.text.includes("解析") && performanceMetric.accessible && wechatThemePreview.opened && wechatThemePreview.completed && wechatThemePreview.widthCount === 3 && wechatThemePreview.hasHeadingAuditCopy && wechatThemePreview.keyboardDialog && wechatThemePreview.focusRestored && /ON|OFF/.test(syncTextBefore) && syncBefore !== "missing" && syncAfter !== syncBefore && syncEnabled === "true" && selectionBoxCount > 0 && wysiwyg.exists && wysiwyg.ready && wysiwyg.edited && wysiwyg.directInputReady && wysiwyg.caretInside && wysiwyg.browserInserted && wysiwyg.formatted && wysiwyg.paragraphBreaks && wysiwyg.mergedParagraphs && wysiwyg.compositionDeferred && wysiwyg.blankParagraphAdded && wysiwyg.blankParagraphDeduplicated && wysiwyg.blankParagraphDeleted && wysiwyg.multilinePasteHandled && wysiwyg.imageAltEdited && wysiwyg.formulaStructuredApplied && wysiwyg.codeStructuredApplied && wysiwyg.linkStructuredApplied && wysiwyg.inlineCodeStructuredApplied && wysiwyg.mixedInlineEdited && wysiwyg.mixedAtomsProtected && wysiwyg.protectedSelectionRejected && wysiwyg.crossBlockFormatted && wysiwyg.crossBlockPasted && wysiwyg.crossBlockProtectedRejected && wysiwyg.dualFormatCopy && wysiwyg.selectAllCopy && wysiwyg.externalHtmlPaste && wysiwyg.imaRichPaste && wysiwyg.blockInserted && wysiwyg.blockDragged && wysiwyg.blockDuplicated && wysiwyg.blockDeleted && wysiwyg.blockKeyboardMoved && wysiwyg.tableCellEdited && wysiwyg.tableColumnInserted && wysiwyg.tableAlignmentApplied && wysiwyg.tableRowAppended && wysiwyg.listItemEdited && wysiwyg.listDirectReady && wysiwyg.listBrowserInserted && wysiwyg.listIndented && wysiwyg.listOutdented && wysiwyg.nestedParentEdited && wysiwyg.nestedSubtreeIndented && wysiwyg.nestedSubtreeOutdented && wysiwyg.quoteEdited && wysiwyg.taskToggled && wysiwyg.undone && wysiwyg.redone && wysiwyg.sourceCardApplied && wysiwyg.sourceRestored && viewWorkflow.fontControl && viewWorkflow.scrollPreserved && viewWorkflow.directPreview && viewWorkflow.previewMermaid && viewWorkflow.inlineOutline && viewWorkflow.outlineButtonRemoved && viewWorkflow.repairButton && viewWorkflow.searchButton && imageBridge.status === "failed" && imageBridge.error.includes("会话") && themeAfter !== themeBefore;
        console.log(JSON.stringify({ uiReady, before, drag, after, accessibility, recentBoundary, tabShortcuts, fontControl, fontApplied, mermaidEditorText, mermaidDebug, mermaidRendered, performanceMetric, wechatThemePreview, syncScroll: { before: syncBefore, after: syncAfter, enabled: syncEnabled, selectionBoxCount }, wysiwyg, viewWorkflow, imageBridge, theme: { before: themeBefore, after: themeAfter }, screenshot: "fantastic-editor-ui-smoke.png", valid }));
      await finishSmoke("ui", valid === true, { uiReady, before, drag, after, accessibility, recentBoundary, tabShortcuts, fontControl, fontApplied, mermaidEditorText, mermaidDebug, mermaidRendered, performanceMetric, wechatThemePreview, syncScroll: { before: syncBefore, after: syncAfter, enabled: syncEnabled, selectionBoxCount }, wysiwyg, viewWorkflow, imageBridge, theme: { before: themeBefore, after: themeAfter } });
      })().catch((error: unknown) => {
        const diagnostic = error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack ?? "" }
          : { message: String(error) };
        console.error(error);
        void finishSmoke("ui", false, { error: diagnostic });
      });
    });
    window.webContents.once("did-fail-load", (_event, code, description) => { console.error(`Renderer load failed (${code}): ${description}`); void finishSmoke("ui", false); });
  } else if (process.env.FANTASTIC_EDITOR_SMOKE_TEST === "1") {
    window.webContents.once("did-finish-load", () => { void finishSmoke("basic", true); });
    window.webContents.once("did-fail-load", (_event, code, description) => {
      console.error(`Renderer load failed (${code}): ${description}`);
      void finishSmoke("basic", false);
    });
  } else {
    window.once("ready-to-show", () => window.show());
  }
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void window.loadFile(join(__dirname, "../renderer/index.html"));
  return window;
}

if (singleInstanceAcquired) app.whenReady().then(() => {
  registerSecurityPolicy();
  registerAssetProtocol();
  const sessionTemporaryDirectory = join(app.getPath("userData"), "untitled-sessions");
  fileSessions.setTemporaryBaseDirectory(sessionTemporaryDirectory);
  const recoveryDirectory = process.env.FANTASTIC_EDITOR_UI_SMOKE_TEST === "1"
    ? join(app.getPath("userData"), `recovery-smoke-${process.pid}`)
    : join(app.getPath("userData"), "recovery-v1");
  recoveryStore = new RecoveryStore(recoveryDirectory);
  recentFileStore = new RecentFileStore(join(app.getPath("userData"), "recent-files-v1.json"));
  wechatApiConfigStore = new WechatApiConfigStore(
    join(app.getPath("userData"), "wechat-api-config-v1.json"),
    {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (value) => safeStorage.encryptString(value).toString("base64"),
      decrypt: (value) => safeStorage.decryptString(Buffer.from(value, "base64")),
    },
  );
  registerIpc();
  if (process.env.FANTASTIC_EDITOR_WECHAT_SMOKE_TEST === "1") {
    void (async () => {
      const parsedDocument = await parseDocument({ documentId: "wechat-smoke-document", editorText: "# 公众号 smoke\n\n正文 **加粗**。\n" });
      const context: OutputContext = {
        jobId: "wechat-smoke-job",
        documentId: parsedDocument.documentId,
        target: "wechat-clipboard",
        sourceHash: parsedDocument.sourceHash,
        workspaceRevision: 1,
        preflightId: "wechat-smoke-preflight",
        parsedDocument,
        resolutionSnapshot: {
          schema: "fantastic-editor-resolution-snapshot",
          documentId: parsedDocument.documentId,
          sourceHash: parsedDocument.sourceHash,
          workspaceId: "wechat-smoke-workspace",
          workspaceRevision: 1,
          resolverProfile: "wechat-smoke",
          records: {},
          diagnostics: [],
          createdAt: new Date().toISOString(),
        },
        derivedAssetManifest: {
          schema: "fantastic-editor-derived-asset-manifest",
          jobId: "wechat-smoke-job",
          sourceHash: parsedDocument.sourceHash,
          workspaceRevision: 1,
          entries: {},
        },
        theme: { id: "wechat-green", tokens: {} },
        locale: "zh-CN",
        options: { imageStrategy: "wechat-image-strategy/1-B" },
        approvedOmittedReferenceKeys: [],
      };
      const result = await nodeOutputProcess.generateWechatHtml(context, [], []);
      const html = result.bytes ? new TextDecoder().decode(result.bytes) : "";
      const safe = result.status === "completed"
        && result.suggestedTitle === "公众号 smoke"
        && !html.includes("公众号 smoke")
        && html.includes("正文")
        && auditWechatHtmlMarkup(html).length === 0;
      if (safe) clipboard.write({ html, text: "正文 加粗。" });
      const clipboardHtml = clipboard.readHTML();
      const clipboardValid = safe && clipboardHtml.includes("正文") && !clipboardHtml.includes("公众号 smoke");
      if (!clipboardValid) console.error(result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n") || "WeChat clipboard validation failed.");
      await finishSmoke("wechat", clipboardValid);
    })().catch((error: unknown) => {
      console.error(error);
      void finishSmoke("wechat", false);
    });
  } else if (process.env.FANTASTIC_EDITOR_PDF_SMOKE_TEST === "1") {
    void (async () => {
      const pdfSmokeParagraphs = Array.from({ length: 48 }, (_, index) => "第 " + (index + 1) + " 段：中文分页验证正文，用于确认多页内容不会被截断，并保持孤行和寡行控制。");
      const pdfSmokeRows = Array.from({ length: 16 }, (_, index) => "| " + (index + 1) + " | 表格跨页内容 " + (index + 1) + " |").join("\n");
      const pdfSmokeSource = [
        "# PDF smoke",
        "中文与公式：$x^2 + 1$。",
        "## 长文分页",
        ...pdfSmokeParagraphs,
        "## 表格跨页",
        "| 序号 | 内容 |",
        "| ---: | --- |",
        pdfSmokeRows,
        "## 长代码块",
        "~~~text\n" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".repeat(8) + "\n第二行中文长代码，必须换行且不能横向裁切。\n~~~",
      ].join("\n\n");
      const parsedDocument = await parseDocument({ documentId: "pdf-smoke-document", editorText: pdfSmokeSource });
      const context: OutputContext = {
        jobId: "pdf-smoke-job",
        documentId: parsedDocument.documentId,
        target: "pdf",
        sourceHash: parsedDocument.sourceHash,
        workspaceRevision: 1,
        preflightId: "pdf-smoke-preflight",
        parsedDocument,
        resolutionSnapshot: {
          schema: "fantastic-editor-resolution-snapshot",
          documentId: parsedDocument.documentId,
          sourceHash: parsedDocument.sourceHash,
          workspaceId: "pdf-smoke-workspace",
          workspaceRevision: 1,
          resolverProfile: "pdf-smoke",
          records: {},
          diagnostics: [],
          createdAt: new Date().toISOString(),
        },
        derivedAssetManifest: {
          schema: "fantastic-editor-derived-asset-manifest",
          jobId: "pdf-smoke-job",
          sourceHash: parsedDocument.sourceHash,
          workspaceRevision: 1,
          entries: {},
        },
        theme: { id: "default", tokens: {} },
        locale: "zh-CN",
        options: {},
        approvedOmittedReferenceKeys: [],
      };
      const result = await pdfRenderWindow.generatePdf(context, []);
      const validPdf = result.status === "completed"
        && result.bytes !== null
        && result.bytes.byteLength > 500
        && result.bytes[0] === 0x25
        && result.bytes[1] === 0x50
        && result.bytes[2] === 0x44
        && result.bytes[3] === 0x46
        && (result.pageCount ?? 0) >= 2;
      const outputPath = process.env.FANTASTIC_EDITOR_PDF_SMOKE_OUTPUT;
      if (validPdf && outputPath && result.bytes) await writeFile(outputPath, result.bytes);
      if (!validPdf) console.error(result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n") || "PDF validation failed.");
      await finishSmoke("pdf", validPdf);
    })().catch((error: unknown) => {
      console.error(error);
      void finishSmoke("pdf", false);
    });
  } else if (process.env.FANTASTIC_EDITOR_OFFLINE_HTML_SMOKE_TEST === "1") {
    void (async () => {
      const parsedDocument = await parseDocument({
        documentId: "offline-html-smoke-document",
        editorText: "# 离线 HTML smoke\n\n正文与 $x^2 + 1$。\n\n| 项目 | 结果 |\n| --- | --- |\n| 自包含 | 通过 |\n",
      });
      const context: OutputContext = {
        jobId: "offline-html-smoke-job",
        documentId: parsedDocument.documentId,
        target: "offline-html",
        sourceHash: parsedDocument.sourceHash,
        workspaceRevision: 1,
        preflightId: "offline-html-smoke-preflight",
        parsedDocument,
        resolutionSnapshot: {
          schema: "fantastic-editor-resolution-snapshot",
          documentId: parsedDocument.documentId,
          sourceHash: parsedDocument.sourceHash,
          workspaceId: "offline-html-smoke-workspace",
          workspaceRevision: 1,
          resolverProfile: "offline-html-smoke",
          records: {},
          diagnostics: [],
          createdAt: new Date().toISOString(),
        },
        derivedAssetManifest: {
          schema: "fantastic-editor-derived-asset-manifest",
          jobId: "offline-html-smoke-job",
          sourceHash: parsedDocument.sourceHash,
          workspaceRevision: 1,
          entries: {},
        },
        theme: { id: "smoke-dark", tokens: { colorScheme: "dark", "typography.body.fontFamily": "Arial" } },
        locale: "zh-CN",
        options: {},
        approvedOmittedReferenceKeys: [],
      };
      const result = await nodeOutputProcess.generateOfflineHtml(context, []);
      const html = result.bytes ? new TextDecoder().decode(result.bytes) : "";
      const validHtml = result.status === "completed"
        && html.includes("<title>离线 HTML smoke</title>")
        && html.includes("color-scheme:dark")
        && html.includes("data:font/woff2;base64,")
        && !/<script\b|\son[a-z]+\s*=|(?:file|blob|app|fantastic-asset):/i.test(html);
      const outputPath = process.env.FANTASTIC_EDITOR_OFFLINE_HTML_SMOKE_OUTPUT;
      if (validHtml && outputPath && result.bytes) await writeFile(outputPath, result.bytes);
      if (!validHtml) console.error(result.diagnostics.map((item) => item.code + ": " + item.message).join("\n") || "Offline HTML validation failed.");
      await finishSmoke("offline-html", validHtml);
    })().catch((error: unknown) => {
      console.error(error);
      void finishSmoke("offline-html", false);
    });
  } else if (process.env.FANTASTIC_EDITOR_DOCX_SMOKE_TEST === "1") {
    void (async () => {
      const docxSmokeParagraphs = Array.from({ length: 28 }, (_, index) => "第 " + (index + 1) + " 段：中文 Word 分页与字体验证正文。");
      const docxSmokeRows = Array.from({ length: 18 }, (_, index) => "| " + (index + 1) + " | 跨页表格内容 " + (index + 1) + " |").join("\n");
      const docxSmokeSource = [
        "# DOCX smoke",
        "Utility Process 真实生成验证。",
        "## 列表与任务",
        "- 普通项目",
        "- [x] 已完成任务",
        "- [ ] 未完成任务",
        "1. 有序第一项",
        "2. 有序第二项",
        "> 引用内容不得重复。",
        "## 多页正文",
        ...docxSmokeParagraphs,
        "## 跨页表格",
        "| 序号 | 内容 |",
        "| ---: | --- |",
        docxSmokeRows,
        "## 长代码",
        "~~~text\n第一行代码\n" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".repeat(5) + "\n第三行代码\n~~~",
      ].join("\n\n");
      const parsedDocument = await parseDocument({ documentId: "docx-smoke-document", editorText: docxSmokeSource });
      const context: OutputContext = {
        jobId: "docx-smoke-job",
        documentId: parsedDocument.documentId,
        target: "docx",
        sourceHash: parsedDocument.sourceHash,
        workspaceRevision: 1,
        preflightId: "docx-smoke-preflight",
        parsedDocument,
        resolutionSnapshot: {
          schema: "fantastic-editor-resolution-snapshot",
          documentId: parsedDocument.documentId,
          sourceHash: parsedDocument.sourceHash,
          workspaceId: "docx-smoke-workspace",
          workspaceRevision: 1,
          resolverProfile: "docx-smoke",
          records: {},
          diagnostics: [],
          createdAt: new Date().toISOString(),
        },
        derivedAssetManifest: {
          schema: "fantastic-editor-derived-asset-manifest",
          jobId: "docx-smoke-job",
          sourceHash: parsedDocument.sourceHash,
          workspaceRevision: 1,
          entries: {},
        },
        theme: { id: "default", tokens: {} },
        locale: "zh-CN",
        options: {},
        approvedOmittedReferenceKeys: [],
      };
      const result = await nodeOutputProcess.generateDocx(context, [], []);
      const validDocx = result.status === "completed"
        && result.bytes !== null
        && result.bytes.byteLength > 500
        && result.bytes[0] === 0x50
        && result.bytes[1] === 0x4b;
      const outputPath = process.env.FANTASTIC_EDITOR_DOCX_SMOKE_OUTPUT;
      if (validDocx && outputPath && result.bytes) await writeFile(outputPath, result.bytes);
      if (!validDocx) console.error(result.diagnostics.map((item) => item.code + ": " + item.message).join("\n") || "DOCX validation failed.");
      await finishSmoke("docx", validDocx);
    })().catch((error: unknown) => {
      console.error(error);
      void finishSmoke("docx", false);
    });
  } else if (process.env.FANTASTIC_EDITOR_MERMAID_SMOKE_TEST === "1") {
    void mermaidRenderWindow.renderDiagram("graph TD\n  A --> B", false, "Microsoft YaHei UI").then(async (result) => {
      const validPng = result.status === "completed"
        && result.png.byteLength > 8
        && result.png[0] === 0x89
        && result.png[1] === 0x50
        && result.width > 32
        && result.height > 32;
      if (!validPng) console.error(result.status === "failed" ? `${result.code}: ${result.message}` : "Mermaid PNG validation failed.");
      await finishSmoke("mermaid", validPng);
    }).catch((error: unknown) => {
      console.error(error);
      void finishSmoke("mermaid", false);
    });  } else if (process.env.FANTASTIC_EDITOR_FORMULA_SMOKE_TEST === "1") {
    void formulaRenderWindow.renderFormula("\\frac{1}{2} + \\sqrt{x^2+1}", true).then(async (result) => {
      const validPng = result.status === "completed"
        && result.png.byteLength > 8
        && result.png[0] === 0x89
        && result.png[1] === 0x50
        && result.width > 32
        && result.height > 32;
      if (!validPng) console.error(result.status === "failed" ? `${result.code}: ${result.message}` : "Formula PNG validation failed.");
      await finishSmoke("formula", validPng);
    }).catch((error: unknown) => {
      console.error(error);
      void finishSmoke("formula", false);
    });
  } else {
    createMainWindow();
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("before-quit", () => {
  outputService.clear();
  formulaRenderWindow.dispose();
  mermaidRenderWindow.dispose();
  pdfRenderWindow.dispose();
  nodeOutputProcess.dispose();
  imageTransformProcess.dispose();
  void fileSessions.dispose();
  if (process.env.FANTASTIC_EDITOR_UI_SMOKE_TEST === "1") void recoveryStore?.clear();
});

app.on("window-all-closed", () => {
  // Hidden export/render windows are the only windows in packaged smoke runs.
  // Their normal cleanup must not terminate Electron before the smoke result
  // marker has been flushed by finishSmoke().
  if (process.platform !== "darwin" && !process.env.FANTASTIC_EDITOR_SMOKE_RESULT) app.quit();
});
