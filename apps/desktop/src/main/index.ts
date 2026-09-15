import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  protocol,
  safeStorage,
  session,
  shell,
  type IpcMainInvokeEvent,
  type MessageBoxOptions,
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
  type AiInvocationRequest,
  type WorkspaceFileEntry,
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
import { installFontForCurrentUser } from "./font-installer.js";
import { AiCliService, validateAiCancelRequest } from "./ai-cli-service.js";
import { DeepSeekApi } from "./deepseek-api.js";
import { GeminiApi } from "./gemini-api.js";
import { DocumentHistoryStore } from "./document-history-store.js";


// Some Windows graphics drivers crash Chromium during startup with a native
// breakpoint exception (0x80000003). This editor does not require GPU-only
// rendering, so prefer a stable software compositor for the packaged build.
// Electron requires this to run before the app is ready.
app.disableHardwareAcceleration();
// A few Windows environments still start a broken out-of-process GPU helper
// even after hardware acceleration is disabled. Keeping the helper in-process
// avoids the native startup crash without weakening the renderer sandbox.
if (process.platform === "win32") app.commandLine.appendSwitch("in-process-gpu");
if (process.env.FANTASTIC_EDITOR_AI_SMOKE_TEST === "1" && process.env.FANTASTIC_EDITOR_AI_SMOKE_USER_DATA) {
  app.setName("fantastic-editor-ai-smoke");
  app.setPath("userData", process.env.FANTASTIC_EDITOR_AI_SMOKE_USER_DATA);
}

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
let documentHistoryStore: DocumentHistoryStore | undefined;
const wechatDraftConnector = new WechatDraftConnector();
const aiSmokeNode = process.env.FANTASTIC_EDITOR_AI_SMOKE_TEST === "1" ? process.env.FANTASTIC_EDITOR_AI_SMOKE_NODE : undefined;
const aiSmokeScript = process.env.FANTASTIC_EDITOR_AI_SMOKE_TEST === "1" ? process.env.FANTASTIC_EDITOR_AI_SMOKE_SCRIPT : undefined;
const deepSeekApi = new DeepSeekApi(join(app.getPath("userData"), "deepseek-api-config-v1.json"), {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (value) => safeStorage.encryptString(value).toString("base64"),
  decrypt: (value) => safeStorage.decryptString(Buffer.from(value, "base64")),
});
const geminiApi = new GeminiApi(join(app.getPath("userData"), "gemini-api-config-v1.json"), {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (value) => safeStorage.encryptString(value).toString("base64"),
  decrypt: (value) => safeStorage.decryptString(Buffer.from(value, "base64")),
});
const aiCliService = aiSmokeNode && aiSmokeScript
  ? new AiCliService({ spawnSpec: { executable: aiSmokeNode, argsPrefix: [aiSmokeScript, "ui"] }, timeoutMs: 10_000 })
  : new AiCliService({ deepSeek: deepSeekApi, gemini: geminiApi });
app.on("before-quit", () => aiCliService.dispose());
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
  if (scenario === "ui" || scenario === "live-preview" || scenario === "ai") {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.destroy();
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
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
  ipcMain.handle(IPC_CHANNELS.detectAiProvider, async (event) => {
    requireTrustedRenderer(event);
    return aiCliService.detect();
  });
  ipcMain.handle(IPC_CHANNELS.invokeAi, async (event, request: AiInvocationRequest) => {
    requireTrustedRenderer(event);
    return aiCliService.invoke(request, (update) => {
      if (!event.sender.isDestroyed()) event.sender.send(IPC_CHANNELS.aiInvocationEvent, update);
    });
  });
  ipcMain.handle(IPC_CHANNELS.cancelAi, (event, request: { requestId?: unknown }) => {
    requireTrustedRenderer(event);
    if (!validateAiCancelRequest(request)) return { status: "missing" } as const;
    return { status: aiCliService.cancel(request.requestId) ? "cancelled" : "missing" } as const;
  });
  ipcMain.handle(IPC_CHANNELS.getDeepSeekConfig, async (event) => { requireTrustedRenderer(event); return { status: "loaded", configured: await deepSeekApi.configured() } as const; });
  ipcMain.handle(IPC_CHANNELS.saveDeepSeekConfig, async (event, request: { apiKey?: unknown }) => {
    requireTrustedRenderer(event);
    if (!request || Object.keys(request).length !== 1 || typeof request.apiKey !== "string") return { status: "failed", error: "API Key 格式无效。" } as const;
    return await deepSeekApi.save(request.apiKey) ? { status: "saved", configured: true } as const : { status: "failed", error: "API Key 格式无效，或系统加密不可用。" } as const;
  });
  ipcMain.handle(IPC_CHANNELS.clearDeepSeekConfig, async (event) => { requireTrustedRenderer(event); await deepSeekApi.clear(); return { status: "cleared", configured: false } as const; });
  ipcMain.handle(IPC_CHANNELS.testDeepSeekConnection, async (event) => { requireTrustedRenderer(event); return await deepSeekApi.test() ? { status: "connected" } as const : { status: "failed", error: "连接失败，请检查 API Key 和网络。" } as const; });
  ipcMain.handle(IPC_CHANNELS.getGeminiConfig, async (event) => { requireTrustedRenderer(event); return { status: "loaded", configured: await geminiApi.configured() } as const; });
  ipcMain.handle(IPC_CHANNELS.saveGeminiConfig, async (event, request: { apiKey?: unknown }) => {
    requireTrustedRenderer(event);
    if (!request || Object.keys(request).length !== 1 || typeof request.apiKey !== "string") return { status: "failed", error: "API Key 格式无效。" } as const;
    return await geminiApi.save(request.apiKey) ? { status: "saved", configured: true } as const : { status: "failed", error: "API Key 格式无效，或系统加密不可用。" } as const;
  });
  ipcMain.handle(IPC_CHANNELS.clearGeminiConfig, async (event) => { requireTrustedRenderer(event); await geminiApi.clear(); return { status: "cleared", configured: false } as const; });
  ipcMain.handle(IPC_CHANNELS.testGeminiConnection, async (event) => { requireTrustedRenderer(event); return await geminiApi.test() ? { status: "connected" } as const : { status: "failed", error: "连接失败，请检查 API Key、模型权限和网络。" } as const; });
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

  ipcMain.handle(IPC_CHANNELS.saveCurrentFile, async (event, request: SaveFileRequest) => {
    requireTrustedRenderer(event);
    const saved = await fileSessions.save(request);
    const path = fileSessions.getSavedPath(request.sessionId);
    if (saved.status === "saved" && path) await documentHistoryStore?.record(path, request.editorText);
    return saved;
  });

  ipcMain.handle(IPC_CHANNELS.saveCurrentFileAs, async (event, request: SaveFileRequest) => {
    requireTrustedRenderer(event);
    const result = await dialog.showSaveDialog({
      title: "另存为 Markdown",
      defaultPath: fileSessions.getSuggestedSaveName(request.sessionId),
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
    });
    if (result.canceled || !result.filePath) return { status: "cancelled" } as const;
    const saved = await fileSessions.save(request, result.filePath);
    if (saved.status === "saved") {
      const path = fileSessions.getSavedPath(request.sessionId);
      if (path) await documentHistoryStore?.record(path, request.editorText);
      await rememberRecentFile(result.filePath);
      parseCommits.clear();
      resourceResolver.revokeAllHandles();
      previewDerivedCache.revokeAll();
      outputService.clear();
    }
    return saved;
  });
  ipcMain.handle(IPC_CHANNELS.checkExternalFileChange, async (event, request: { sessionId?: unknown }) => {
    requireTrustedRenderer(event);
    if (typeof request?.sessionId !== "string") return { status: "failed", error: "文件会话无效。" } as const;
    const changed = await fileSessions.checkExternalChange(request.sessionId);
    if (changed === "unchanged") return { status: "unchanged" } as const;
    if (changed === "missing") return { status: "missing" } as const;
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: MessageBoxOptions = {
      type: "warning",
      title: "文件已被其他程序修改",
      message: "磁盘上的 Markdown 文件已经变化。",
      detail: "请选择如何处理。重新加载会用磁盘版本替换当前编辑区；保留当前内容不会覆盖磁盘；另存为可把当前内容保存到新文件。",
      buttons: ["重新加载", "保留当前内容", "另存为", "取消"],
      defaultId: 1,
      cancelId: 3,
      noLink: true,
    };
    const choice = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
    if (choice.response === 0) return await fileSessions.reloadExternalChange(request.sessionId);
    if (choice.response === 1) { await fileSessions.acknowledgeExternalChange(request.sessionId); return { status: "kept" } as const; }
    if (choice.response === 2) return { status: "save-as" } as const;
    return { status: "unchanged" } as const;
  });
  ipcMain.handle(IPC_CHANNELS.showOpenFileMenu, async (event, request: { sessionId?: unknown }) => {
    requireTrustedRenderer(event);
    if (typeof request?.sessionId !== "string") return { action: "none" } as const;
    const path = fileSessions.getSavedPath(request.sessionId);
    return await new Promise<{ action: "activate" | "history" | "rename" | "none" }>((resolve) => {
      let settled = false;
      const choose = (action: "activate" | "history" | "rename") => { settled = true; resolve({ action }); };
      const owner = BrowserWindow.fromWebContents(event.sender);
      Menu.buildFromTemplate([
        { label: "打开", click: () => choose("activate") },
        { type: "separator" },
        { label: "复制路径", enabled: Boolean(path), click: () => { if (path) clipboard.writeText(path); settled = true; resolve({ action: "none" }); } },
        { label: "在系统资源管理器中显示", enabled: Boolean(path), click: () => { if (path) shell.showItemInFolder(path); settled = true; resolve({ action: "none" }); } },
        { label: "打开版本历史", enabled: Boolean(path), click: () => choose("history") },
        { type: "separator" },
        { label: "重命名", click: () => choose("rename") },
      ]).popup({ ...(owner ? { window: owner } : {}), callback: () => { if (!settled) resolve({ action: "none" }); } });
    });
  });
  ipcMain.handle(IPC_CHANNELS.showWorkspaceFileMenu, async (event, request: OpenWorkspaceFileRequest) => {
    requireTrustedRenderer(event);
    const path = await fileSessions.getWorkspaceFilePath(request);
    if (!path) return { action: "none" } as const;
    return await new Promise<{ action: "open" | "open-new-tab" | "duplicate" | "move" | "history" | "rename" | "delete" | "none"; workspace?: { workspaceRevision: number; files: WorkspaceFileEntry[]; removedSessionIds: string[] } }>((resolve) => {
      let settled = false;
      const choose = (action: "open" | "open-new-tab" | "history" | "rename") => { settled = true; resolve({ action }); };
      const mutate = async (action: "duplicate" | "move" | "delete") => {
        settled = true;
        let targetDirectory: string | undefined;
        if (action === "move") {
          const selected = await dialog.showOpenDialog({ title: "将 Markdown 文件移动到工作区文件夹", properties: ["openDirectory"] });
          if (selected.canceled || !selected.filePaths[0]) { resolve({ action: "none" }); return; }
          targetDirectory = selected.filePaths[0];
        }
        if (action === "delete") {
          const confirmed = await dialog.showMessageBox({ type: "warning", title: "删除 Markdown 文件", message: `确定删除“${basename(path)}”吗？`, detail: "文件将从磁盘永久删除，此操作不能撤销。", buttons: ["取消", "删除"], defaultId: 0, cancelId: 0, noLink: true });
          if (confirmed.response !== 1) { resolve({ action: "none" }); return; }
        }
        const workspace = await fileSessions.mutateWorkspaceFile(request, action, targetDirectory);
        resolve(workspace ? { action, workspace } : { action: "none" });
      };
      const owner = BrowserWindow.fromWebContents(event.sender);
      Menu.buildFromTemplate([
        { label: "打开", click: () => choose("open") },
        { label: "在新标签页中打开", click: () => choose("open-new-tab") },
        { label: "创建副本", click: () => void mutate("duplicate") },
        { label: "将文件移动到…", click: () => void mutate("move") },
        { type: "separator" },
        { label: "复制路径", click: () => { clipboard.writeText(path); settled = true; resolve({ action: "none" }); } },
        { label: "在系统资源管理器中显示", click: () => { shell.showItemInFolder(path); settled = true; resolve({ action: "none" }); } },
        { label: "打开版本历史", click: () => choose("history") },
        { type: "separator" },
        { label: "重命名", click: () => choose("rename") },
        { label: "删除", click: () => void mutate("delete") },
      ]).popup({ ...(owner ? { window: owner } : {}), callback: () => { if (!settled) resolve({ action: "none" }); } });
    });
  });
  ipcMain.handle(IPC_CHANNELS.listDocumentHistory, async (event, request: { sessionId?: unknown }) => {
    requireTrustedRenderer(event);
    const path = typeof request?.sessionId === "string" ? fileSessions.getSavedPath(request.sessionId) : null;
    return path ? { status: "listed", items: await documentHistoryStore?.list(path) ?? [] } as const : { status: "failed", error: "请先保存文档。" } as const;
  });
  ipcMain.handle(IPC_CHANNELS.restoreDocumentHistory, async (event, request: { sessionId?: unknown; snapshotId?: unknown; currentText?: unknown }) => {
    requireTrustedRenderer(event);
    if (!request || Object.keys(request).length !== 3 || typeof request.sessionId !== "string" || typeof request.snapshotId !== "string" || typeof request.currentText !== "string" || request.currentText.length > 10_000_000) return { status: "failed", error: "历史恢复请求无效。" } as const;
    const path = fileSessions.getSavedPath(request.sessionId); if (!path) return { status: "failed", error: "请先保存文档。" } as const;
    const editorText = await documentHistoryStore?.read(path, request.snapshotId); if (editorText === null || editorText === undefined) return { status: "failed", error: "历史版本不存在或已清理。" } as const;
    await documentHistoryStore?.record(path, request.currentText);
    return { status: "restored", editorText } as const;
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
  ipcMain.handle(IPC_CHANNELS.selectAndInstallFont, async (event) => {
    requireTrustedRenderer(event);
    if (process.platform !== "win32") return { status: "failed", error: "当前版本只支持在 Windows 安装自定义字体。" } as const;
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return { status: "failed", error: "主窗口已关闭，无法选择字体。" } as const;
    const selection = await dialog.showOpenDialog(window, {
      title: "选择并安装字体",
      properties: ["openFile"],
      filters: [{ name: "字体文件", extensions: ["ttf", "otf"] }],
    });
    if (selection.canceled || !selection.filePaths[0]) return { status: "cancelled" } as const;
    try {
      const installed = await installFontForCurrentUser(selection.filePaths[0], join(app.getPath("userData"), "fonts"));
      return { status: "installed", ...installed } as const;
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : "安装字体失败。" } as const;
    }
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
    autoHideMenuBar: true,
    backgroundColor: "#f4f1ec",
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
  let showWhenLoaded = false;
  if (process.env.FANTASTIC_EDITOR_AI_SMOKE_TEST === "1") {
    window.webContents.once("did-finish-load", () => {
      void (async () => {
        const ready = await window.webContents.executeJavaScript(`(async () => {
          document.querySelector("[data-testid=new-document]")?.click();
          const deadline = Date.now() + 10000;
          while (Date.now() < deadline) {
            const editor = document.querySelector(".cm-content");
            if (editor) { editor.focus(); localStorage.setItem("fantastic-editor-ai-disclosure-accepted:codex-cli", "true"); return true; }
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          return false;
        })()`, true);
        if (!ready) throw new Error("AI smoke editor did not become ready.");
        await window.webContents.insertText("需要润色的正文");
        const applied = await window.webContents.executeJavaScript(`(async () => {
          const waitFor = async (test) => { const deadline = Date.now() + 10000; while (Date.now() < deadline) { const value = test(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 50)); } return null; };
          document.querySelector('[aria-label="AI 写作助手"]')?.click();
          const generate = await waitFor(() => document.querySelector(".ai-generate:not(:disabled)"));
          const providers = [...document.querySelectorAll('[aria-label="AI 提供商"] option')].map((option) => option.textContent);
          if (providers.length !== 4 || !providers.some((label) => label?.includes("Codex CLI")) || !providers.some((label) => label?.includes("Claude CLI")) || !providers.some((label) => label?.includes("DeepSeek API")) || !providers.some((label) => label?.includes("Gemini API"))) return false;
          if (!document.querySelector(".ai-action-help")?.textContent?.includes("改善表达和语气")) return false;
          generate?.click();
          const preview = await waitFor(() => document.querySelector('[aria-label="AI 建议预览"]'));
          if (preview?.value !== "处理结果" || document.querySelector('[aria-label="AI 原文预览"]')?.value !== "需要润色的正文") return false;
          [...document.querySelectorAll("button")].find((button) => button.textContent === "应用到正文")?.click();
          return Boolean(await waitFor(() => document.querySelector(".cm-content")?.textContent?.includes("处理结果")));
        })()`, true);
        if (!applied) throw new Error("AI suggestion was not previewed and applied.");
        await window.webContents.executeJavaScript(`document.querySelector(".cm-content")?.focus()`, true);
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Z", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Z", modifiers: ["control"] });
        await new Promise((resolve) => setTimeout(resolve, 150));
        const undone = await window.webContents.executeJavaScript(`document.querySelector(".cm-content")?.textContent?.includes("需要润色的正文")`, true);
        if (!undone) throw new Error("AI suggestion was not undone in one step.");

        await window.webContents.executeJavaScript(`document.querySelector(".cm-content")?.focus()`, true);
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
        await window.webContents.insertText("陈旧测试");
        await window.webContents.executeJavaScript(`document.querySelector(".ai-generate:not(:disabled)")?.click()`, true);
        await new Promise((resolve) => setTimeout(resolve, 100));
        await window.webContents.executeJavaScript(`document.querySelector(".cm-content")?.focus()`, true);
        await window.webContents.insertText("已变化");
        const stale = await window.webContents.executeJavaScript(`(async () => {
          const deadline = Date.now() + 10000;
          while (Date.now() < deadline && !document.querySelector('[aria-label="AI 建议预览"]')) await new Promise((resolve) => setTimeout(resolve, 50));
          [...document.querySelectorAll("button")].find((button) => button.textContent === "应用到正文")?.click();
          await new Promise((resolve) => setTimeout(resolve, 100));
          return document.querySelector(".ai-result .error")?.textContent?.includes("旧建议不能应用") === true;
        })()`, true);
        if (!stale) throw new Error("Stale AI suggestion was not rejected.");

        await window.webContents.executeJavaScript(`document.querySelector(".cm-content")?.focus()`, true);
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
        await window.webContents.insertText("取消测试");
        const cancelled = await window.webContents.executeJavaScript(`(async () => {
          document.querySelector(".ai-generate:not(:disabled)")?.click();
          const deadline = Date.now() + 10000;
          while (Date.now() < deadline && ![...document.querySelectorAll("button")].some((button) => button.textContent === "停止")) await new Promise((resolve) => setTimeout(resolve, 50));
          [...document.querySelectorAll("button")].find((button) => button.textContent === "停止")?.click();
          while (Date.now() < deadline) { if (document.querySelector(".ai-result")?.textContent?.includes("选择文字或把光标")) return true; await new Promise((resolve) => setTimeout(resolve, 50)); }
          return false;
        })()`, true);
        await finishSmoke("ai", Boolean(cancelled), { applied, undone, stale, cancelled });
      })().catch((error) => void finishSmoke("ai", false, { error: error instanceof Error ? error.message : String(error) }));
    });
  } else if (process.env.FANTASTIC_EDITOR_LIVE_PREVIEW_SMOKE_TEST === "1") {
    window.webContents.once("did-finish-load", () => {
      void (async () => {
        const ready = await window.webContents.executeJavaScript(`(async () => {
          const deadline = Date.now() + 10000;
          let clicked = false;
          while (Date.now() < deadline) {
            const newButton = document.querySelector("[data-testid=new-document]");
            if (newButton instanceof HTMLButtonElement) {
              newButton.click();
              clicked = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          while (Date.now() < deadline) {
            if (document.querySelector(".cm-content") && document.querySelector('button[aria-label="写作模式"]') && document.querySelector('button[aria-label="源码模式"]')) return "ready";
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          return clicked ? "editor-missing" : "new-button-missing";
        })()`, true) as string;
        if (ready !== "ready") {
          const rendererState = await window.webContents.executeJavaScript(`({ title: document.title, body: document.body?.innerText?.slice(0, 500) ?? "", html: document.body?.innerHTML?.slice(0, 500) ?? "" })`, true);
          throw new Error(`Live Preview smoke could not create an editable document: ${ready}. ${JSON.stringify(rendererState)}`);
        }

        window.show();
        window.focus();
        window.webContents.focus();
        await window.webContents.executeJavaScript(`document.querySelector(".cm-content")?.focus()`, true);
        const tabCases: Array<{ mode: string; pair: string; text: string; valid: boolean; before: unknown; after: unknown }> = [];
        for (const mode of ["源码模式", "写作模式"]) {
          await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="${mode}"]')?.click()`, true);
          await new Promise((resolve) => setTimeout(resolve, 200));
          for (const pair of ["()", "（）"]) {
            await window.webContents.executeJavaScript(`document.querySelector('.cm-content')?.focus()`, true);
            window.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] });
            window.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
            await new Promise((resolve) => setTimeout(resolve, 100));
            await window.webContents.insertText(pair);
            await new Promise((resolve) => setTimeout(resolve, 150));
            window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Home" });
            window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Home" });
            await new Promise((resolve) => setTimeout(resolve, 100));
            window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
            window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
            await new Promise((resolve) => setTimeout(resolve, 100));
            await window.webContents.insertText("I");
            await new Promise((resolve) => setTimeout(resolve, 100));
            const entered = await window.webContents.executeJavaScript(`document.querySelector('.cm-content')?.textContent ?? ''`, true) as string;
            if (entered !== pair[0] + "I" + pair[1]) throw new Error(`Tab entry regression: ${mode} ${entered}`);
            const before = await window.webContents.executeJavaScript(`({focus: document.activeElement?.outerHTML?.slice(0,200), offset: document.getSelection()?.anchorOffset})`, true);
            window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
            window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
            await new Promise((resolve) => setTimeout(resolve, 100));
            const after = await window.webContents.executeJavaScript(`({focus: document.activeElement?.outerHTML?.slice(0,200), offset: document.getSelection()?.anchorOffset})`, true);
            await window.webContents.insertText("X");
            await new Promise((resolve) => setTimeout(resolve, 100));
            const text = await window.webContents.executeJavaScript(`document.querySelector('.cm-content')?.textContent ?? ''`, true) as string;
            tabCases.push({ mode, pair, text, valid: text === pair[0] + "I" + pair[1] + "X", before, after });
          }
        }
        const tabSkippedClosing = tabCases.every((item) => item.valid);
        if (!tabSkippedClosing) throw new Error(`Tab cursor regression: ${JSON.stringify(tabCases)}`);

        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
        await new Promise((resolve) => setTimeout(resolve, 100));
        await window.webContents.insertText("Turns\n\nTurns\n\nTurns");
        await new Promise((resolve) => setTimeout(resolve, 200));
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "f", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "f", modifiers: ["control"] });
        await new Promise((resolve) => setTimeout(resolve, 100));
        await window.webContents.insertText("Turns");
        for (let index = 1; index <= 3; index++) {
          window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
          window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
          await new Promise((resolve) => setTimeout(resolve, 100));
          const result = await window.webContents.executeJavaScript(`({ count: document.querySelector('.search-count')?.textContent, focused: document.activeElement?.getAttribute('aria-label') === '查找文本', marks: document.querySelectorAll('.cm-searchMatch').length, current: document.querySelectorAll('.cm-searchMatch-selected').length })`, true) as { count: string; focused: boolean; marks: number; current: number };
          if (result.count !== `${index}/3` || !result.focused || result.marks !== 3 || result.current !== 1) throw new Error(`Search regression: ${JSON.stringify(result)}`);
        }
        await window.webContents.executeJavaScript(`document.querySelector('[aria-label="关闭查找"]')?.click(); document.querySelector('.cm-content')?.focus()`, true);
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
        window.webContents.insertText("测试粗体\n\n# 标题\n\n- 第一项\n- \n- ");
        await new Promise((resolve) => setTimeout(resolve, 800));
        await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="写作模式"]')?.click()`, true);
        await new Promise((resolve) => setTimeout(resolve, 200));
        window.webContents.sendInputEvent({ type: "char", keyCode: "y" });
        await new Promise((resolve) => setTimeout(resolve, 150));
        const liveTyped = await window.webContents.executeJavaScript(`[...document.querySelectorAll(".cm-line")].some((line) => line.textContent?.includes("y"))`, true) as boolean;
        await new Promise((resolve) => setTimeout(resolve, 700));
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Z", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Z", modifiers: ["control"] });
        await new Promise((resolve) => setTimeout(resolve, 150));
        const liveUndo = await window.webContents.executeJavaScript(`({ articlePresent: document.querySelector(".cm-content")?.textContent?.includes("测试粗体") === true, typedRemoved: ![...document.querySelectorAll(".cm-line")].some((line) => line.textContent?.includes("y")), focused: document.activeElement?.classList.contains("cm-content") === true })`, true) as { articlePresent: boolean; typedRemoved: boolean; focused: boolean };
        await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="源码模式"]')?.click()`, true);
        await new Promise((resolve) => setTimeout(resolve, 150));
        window.webContents.sendInputEvent({ type: "char", keyCode: "x" });
        await new Promise((resolve) => setTimeout(resolve, 100));
        const sourceTyped = await window.webContents.executeJavaScript(`document.querySelector(".cm-content")?.textContent?.includes("x") === true`, true) as boolean;
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Backspace" });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Backspace" });
        await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="写作模式"]')?.click()`, true);
        await new Promise((resolve) => setTimeout(resolve, 200));

        const initial = await window.webContents.executeJavaScript(`(() => {
          const lines = [...document.querySelectorAll(".cm-line")];
          const emptyLine = [...lines].reverse().find((line) => (line.textContent ?? "").trim() === "-" || (line.textContent ?? "").trim() === "•");
          const rect = emptyLine?.getBoundingClientRect();
          return {
            singleEditor: document.querySelectorAll(".cm-editor").length === 1,
            liveClass: document.querySelector(".cm-editor")?.classList.contains("cm-live-preview") === true,
            headingStyled: Boolean(document.querySelector(".cm-live-heading-1")),
            fontOptions: document.querySelector("[data-testid=wysiwyg-font-preset]")?.querySelectorAll("option").length ?? 0,
            toolbarButtons: [...document.querySelectorAll(".live-preview-format-toolbar button")].map((button) => button.textContent?.trim() ?? ""),
            emptyLine: rect ? { x: rect.left + 18, y: rect.top + rect.height / 2 } : null,
            lineText: lines.map((line) => line.textContent ?? "")
          };
        })()`, true) as { singleEditor: boolean; liveClass: boolean; headingStyled: boolean; fontOptions: number; toolbarButtons: string[]; emptyLine: { x: number; y: number } | null; lineText: string[] };
        if (!initial.emptyLine) throw new Error("Live Preview smoke could not locate the empty list item.");

        window.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(initial.emptyLine.x), y: Math.round(initial.emptyLine.y), button: "left", clickCount: 1 });
        window.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(initial.emptyLine.x), y: Math.round(initial.emptyLine.y), button: "left", clickCount: 1 });
        await new Promise((resolve) => setTimeout(resolve, 100));
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Backspace" });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Backspace" });
        await new Promise((resolve) => setTimeout(resolve, 100));
        const afterFirstDelete = await window.webContents.executeJavaScript(`({ text: [...document.querySelectorAll(".cm-line")].map((line) => line.textContent ?? ""), focused: document.activeElement?.classList.contains("cm-content") === true })`, true) as { text: string[]; focused: boolean };
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Backspace" });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Backspace" });
        await new Promise((resolve) => setTimeout(resolve, 100));
        const afterSecondDelete = await window.webContents.executeJavaScript(`({ text: [...document.querySelectorAll(".cm-line")].map((line) => line.textContent ?? ""), focused: document.activeElement?.classList.contains("cm-content") === true })`, true) as { text: string[]; focused: boolean };

        const selectionRect = await window.webContents.executeJavaScript(`(() => {
          const line = [...document.querySelectorAll(".cm-line")].find((item) => item.textContent?.includes("测试粗体"));
          const text = line?.firstChild;
          if (!(text instanceof Text)) return null;
          const range = document.createRange();
          range.setStart(text, 0);
          range.setEnd(text, Math.min(4, text.length));
          const rect = range.getBoundingClientRect();
          return { fromX: rect.left + 1, toX: rect.right - 1, y: rect.top + rect.height / 2 };
        })()`, true) as { fromX: number; toX: number; y: number } | null;
        if (!selectionRect) throw new Error("Live Preview smoke could not locate text for a native mouse selection.");
        window.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(selectionRect.fromX), y: Math.round(selectionRect.y) });
        await new Promise((resolve) => setTimeout(resolve, 40));
        window.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(selectionRect.fromX), y: Math.round(selectionRect.y), button: "left", clickCount: 1 });
        window.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(selectionRect.fromX), y: Math.round(selectionRect.y), button: "left", clickCount: 1 });
        await new Promise((resolve) => setTimeout(resolve, 60));
        window.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(selectionRect.toX), y: Math.round(selectionRect.y), button: "left", clickCount: 1, modifiers: ["shift"] });
        window.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(selectionRect.toX), y: Math.round(selectionRect.y), button: "left", clickCount: 1, modifiers: ["shift"] });
        await new Promise((resolve) => setTimeout(resolve, 150));
        const selectionRendering = await window.webContents.executeJavaScript(`({ native: (document.getSelection()?.toString().length ?? 0) > 0, customLayers: document.querySelectorAll(".cm-selectionBackground").length })`, true) as { native: boolean; customLayers: number };
        const selectionMade = selectionRendering.native && selectionRendering.customLayers === 0;
        const toolbarPersistent = await window.webContents.executeJavaScript(`(() => {
          const toolbar = document.querySelector(".live-preview-format-toolbar");
          if (!(toolbar instanceof HTMLElement)) return false;
          const style = getComputedStyle(toolbar);
          const rect = toolbar.getBoundingClientRect();
          return style.position !== "fixed" && style.display !== "none" && rect.width > 100 && rect.top >= 0;
        })()`, true) as boolean;
        const italicButton = await window.webContents.executeJavaScript(`(() => { const rect = document.querySelector('.live-preview-format-toolbar button[title^="切换斜体"]')?.getBoundingClientRect(); return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null; })()`, true) as { x: number; y: number } | null;
        if (!italicButton) throw new Error("Live Preview smoke could not locate the italic toolbar command.");
        window.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(italicButton.x), y: Math.round(italicButton.y), button: "left", clickCount: 1 });
        window.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(italicButton.x), y: Math.round(italicButton.y), button: "left", clickCount: 1 });
        await new Promise((resolve) => setTimeout(resolve, 150));
        const italicVisible = await window.webContents.executeJavaScript(`Boolean(document.querySelector(".cm-live-emphasis"))`, true) as boolean;
        const italicStyle = await window.webContents.executeJavaScript(`(() => { const style = getComputedStyle(document.querySelector(".cm-live-emphasis")); return { fontStyle: style.fontStyle, fontSynthesis: style.fontSynthesis }; })()`, true) as { fontStyle: string; fontSynthesis: string };
        const italicToggle = await window.webContents.executeJavaScript(`(async () => {
          const button = document.querySelector('.live-preview-format-toolbar button[title^="切换斜体"]');
          button?.click();
          await new Promise((resolve) => setTimeout(resolve, 100));
          const removed = !document.querySelector('.cm-live-emphasis');
          button?.click();
          await new Promise((resolve) => setTimeout(resolve, 100));
          return { removed, reapplied: Boolean(document.querySelector('.cm-live-emphasis')) };
        })()`, true) as { removed: boolean; reapplied: boolean };
        const kaitiBold = await window.webContents.executeJavaScript(`(async () => {
          const font = document.querySelector('[data-testid="wysiwyg-font-preset"]');
          if (!(font instanceof HTMLSelectElement)) return { applied: false, removed: false, fontFamily: '', fontWeight: '', fontSynthesis: '' };
          font.value = 'KaiTi';
          font.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 100));
          const button = document.querySelector('.live-preview-format-toolbar button[title^="切换粗体"]');
          button?.click();
          await new Promise((resolve) => setTimeout(resolve, 100));
          const strong = document.querySelector('.cm-live-strong');
          const style = strong ? getComputedStyle(strong) : null;
          const result = { applied: Boolean(strong), removed: false, fontFamily: style?.fontFamily ?? '', fontWeight: style?.fontWeight ?? '', fontSynthesis: style?.fontSynthesis ?? '' };
          button?.click();
          await new Promise((resolve) => setTimeout(resolve, 100));
          result.removed = !document.querySelector('.cm-live-strong');
          return result;
        })()`, true) as { applied: boolean; removed: boolean; fontFamily: string; fontWeight: string; fontSynthesis: string };
        const blockTypes = await window.webContents.executeJavaScript(`(async () => {
          document.querySelector('.live-preview-format-toolbar button[title="一级标题"]')?.click();
          await new Promise((resolve) => setTimeout(resolve, 100));
          const headingApplied = [...document.querySelectorAll(".cm-live-heading-1")].some((line) => line.textContent?.includes("测试粗体"));
          document.querySelector('.live-preview-format-toolbar button[title="正文"]')?.click();
          await new Promise((resolve) => setTimeout(resolve, 100));
          const normalApplied = ![...document.querySelectorAll(".cm-live-heading-1")].some((line) => line.textContent?.includes("测试粗体"));
          return { headingApplied, normalApplied };
        })()`, true) as { headingApplied: boolean; normalApplied: boolean };
        const themeApplied = await window.webContents.executeJavaScript(`(async () => {
          const toggle = document.querySelector(".wysiwyg-theme-toggle");
          if (toggle?.getAttribute("aria-pressed") !== "true") toggle?.click();
          await new Promise((resolve) => setTimeout(resolve, 100));
          return document.querySelector(".editor-host")?.classList.contains("wechat-theme-active") === true
            && [...document.querySelectorAll("style")].some((style) => style.textContent?.includes(".cm-live-heading-1"));
        })()`, true) as boolean;
        const themeEditPoint = await window.webContents.executeJavaScript(`(() => { const line = [...document.querySelectorAll('.cm-line')].at(-1); const rect = line?.getBoundingClientRect(); return rect ? { x: Math.max(rect.left + 8, rect.right - 4), y: rect.top + rect.height / 2 } : null; })()`, true) as { x: number; y: number } | null;
        if (!themeEditPoint) throw new Error("Live Preview smoke could not locate a themed edit point.");
        window.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(themeEditPoint.x), y: Math.round(themeEditPoint.y), button: "left", clickCount: 1 });
        window.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(themeEditPoint.x), y: Math.round(themeEditPoint.y), button: "left", clickCount: 1 });
        window.webContents.insertText("主题输入");
        await new Promise((resolve) => setTimeout(resolve, 150));
        const themedEditInserted = await window.webContents.executeJavaScript(`document.querySelector('.cm-content')?.textContent?.includes('主题输入') === true && document.activeElement?.classList.contains('cm-content') === true`, true) as boolean;
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Z", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Z", modifiers: ["control"] });
        await new Promise((resolve) => setTimeout(resolve, 100));
        const themedEditUndone = await window.webContents.executeJavaScript(`document.querySelector('.cm-content')?.textContent?.includes('主题输入') === false && document.querySelector('.cm-content')?.textContent?.includes('测试粗体') === true`, true) as boolean;
        await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="源码模式"]')?.click()`, true);
        await new Promise((resolve) => setTimeout(resolve, 100));
        const final = await window.webContents.executeJavaScript(`({ source: document.querySelector(".cm-content")?.textContent ?? "", singleEditor: document.querySelectorAll(".cm-editor").length === 1 })`, true) as { source: string; singleEditor: boolean };
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "K", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "K", modifiers: ["control"] });
        const commandPaletteOpened = await window.webContents.executeJavaScript(`new Promise((resolve) => {
          const deadline = Date.now() + 1000;
          const check = () => {
            if (document.querySelector('.command-palette input[aria-label="搜索命令"]') === document.activeElement) resolve(true);
            else if (Date.now() >= deadline) resolve(false);
            else setTimeout(check, 25);
          };
          check();
        })`, true) as boolean;
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });

        const firstChanged = JSON.stringify(initial.lineText) !== JSON.stringify(afterFirstDelete.text);
        await window.webContents.executeJavaScript(`document.querySelector('.cm-content')?.focus()`, true);
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
        window.webContents.insertText("![图片测试](missing-image.png)\n\n末尾");
        await new Promise((resolve) => setTimeout(resolve, 800));
        await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="写作模式"]')?.click()`, true);
        const imageWorkflow = await window.webContents.executeJavaScript(`(async () => {
          const wait = async (check) => { for (let i = 0; i < 80; i++) { if (check()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };
          const shown = await wait(() => Boolean(document.querySelector('.cm-live-image')));
          const message = document.querySelector('.cm-live-image-caption')?.textContent ?? '';
          const edit = [...document.querySelectorAll('.cm-live-image button')].find(b => b.textContent === '编辑图片引用');
          edit?.click();
          const sourceSelected = await wait(() => document.getSelection()?.toString().includes('![图片测试]'));
          return { shown, message, sourceSelected };
        })()`, true) as { shown: boolean; message: string; sourceSelected: boolean };
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Backspace" });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Backspace" });
        await new Promise((resolve) => setTimeout(resolve, 100));
        const imageDeleted = await window.webContents.executeJavaScript(`!document.querySelector('.cm-content')?.textContent?.includes('missing-image.png')`, true) as boolean;
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Z", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Z", modifiers: ["control"] });
        await new Promise((resolve) => setTimeout(resolve, 100));
        const imageRestored = await window.webContents.executeJavaScript(`document.querySelector('.cm-content')?.textContent?.includes('missing-image.png') === true`, true) as boolean;
        const secondChanged = JSON.stringify(afterFirstDelete.text) !== JSON.stringify(afterSecondDelete.text);
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
        window.webContents.insertText("| A | B |\n| --- | --- |\n| C | D |\n\n末尾");
        await new Promise((resolve) => setTimeout(resolve, 200));
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "End", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "End", modifiers: ["control"] });
        const tableInsertPoint = await window.webContents.executeJavaScript(`(async () => {
          const wait = async (fn) => { for (let i = 0; i < 80; i++) { if (fn()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };
          const shown = await wait(() => document.querySelectorAll('.cm-live-table tr').length === 2);
          if (!shown) return null;
          const rect = [...document.querySelectorAll('.cm-live-table-tools button')].find(b => b.textContent === '下方插入行')?.getBoundingClientRect();
          return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
        })()`, true) as { x: number; y: number } | null;
        if (!tableInsertPoint) throw new Error("Live Preview smoke could not locate the table row insertion button.");
        window.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(tableInsertPoint.x), y: Math.round(tableInsertPoint.y), button: "left", clickCount: 1 });
        window.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(tableInsertPoint.x), y: Math.round(tableInsertPoint.y), button: "left", clickCount: 1 });
        const tableWorkflow = await window.webContents.executeJavaScript(`(async () => {
          const wait = async (fn) => { for (let i = 0; i < 80; i++) { if (fn()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };
          const inserted = await wait(() => {
            const selection = window.getSelection();
            const node = selection?.anchorNode;
            const line = node?.parentElement?.closest('.cm-line');
            if (!selection?.isCollapsed || !node || !line?.contains(node) || line.textContent !== '|  |  |') return false;
            const range = document.createRange();
            range.selectNodeContents(line);
            range.setEnd(node, selection.anchorOffset);
            return range.toString().length === 2;
          });
          return { shown: true, inserted };
        })()`, true) as { shown: boolean; inserted: boolean };
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Z", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Z", modifiers: ["control"] });
        const tableUndoEdit = await window.webContents.executeJavaScript(`(async () => {
          for (let i = 0; i < 80 && document.querySelectorAll('.cm-live-table tr').length !== 2; i++) await new Promise(r => setTimeout(r, 50));
          const undone = document.querySelectorAll('.cm-live-table tr').length === 2;
          document.querySelector('.cm-live-table td button')?.click();
          return { undone, selected: window.getSelection()?.toString() === 'C' };
        })()`, true) as { undone: boolean; selected: boolean };
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
        window.webContents.insertText("$N = 2F + 1$\n\n$$\n\\begin{bmatrix}1 & 2 \\\\ 3 & 4\\end{bmatrix}\n$$\n\n```html\n<path />\n```\n\n末尾");
        const formulaWorkflow = await window.webContents.executeJavaScript(`(async () => {
          for (let i = 0; i < 80 && document.querySelectorAll('.cm-live-formula .katex').length !== 2; i++) await new Promise(r => setTimeout(r, 50));
          const rendered = document.querySelectorAll('.cm-live-formula .katex').length === 2;
          const code = document.querySelector('.cm-live-code-line');
          const codeStyled = Boolean(code && getComputedStyle(code).fontFamily.includes('Consolas') && getComputedStyle(code).fontSize === '14px');
          document.querySelector('.cm-live-formula')?.click();
          return { rendered, codeStyled, selected: window.getSelection()?.toString() === '$N = 2F + 1$' };
        })()`, true) as { rendered: boolean; codeStyled: boolean; selected: boolean };
        await window.webContents.executeJavaScript(`document.querySelector('.cm-content')?.focus()`, true);
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
        window.webContents.insertText("# 一级\n\n### 跳级标题");
        const markdownDiagnostics = await window.webContents.executeJavaScript(`(async () => {
          const wait = async (check) => { for (let i = 0; i < 80; i++) { if (check()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };
          const shown = await wait(() => [...document.querySelectorAll('.diagnostic-item')].some(item => item.textContent?.includes('HEADING_LEVEL_SKIPPED')));
          [...document.querySelectorAll('.diagnostic-item')].find(item => item.textContent?.includes('HEADING_LEVEL_SKIPPED'))?.click();
          const jumped = await wait(() => window.getSelection()?.toString().includes('跳级标题') === true);
          document.querySelector('.cm-content')?.focus();
          return { shown, jumped };
        })()`, true) as { shown: boolean; jumped: boolean };
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
        window.webContents.insertText("# 一级\n\n## 二级");
        const markdownDiagnosticCleared = await window.webContents.executeJavaScript(`(async () => { for (let i = 0; i < 80; i++) { if (![...document.querySelectorAll('.diagnostic-item')].some(item => item.textContent?.includes('HEADING_LEVEL_SKIPPED'))) return true; await new Promise(r => setTimeout(r, 50)); } return false; })()`, true) as boolean;
        const valid = tabSkippedClosing && markdownDiagnostics.shown && markdownDiagnostics.jumped && markdownDiagnosticCleared && formulaWorkflow.rendered && formulaWorkflow.codeStyled && formulaWorkflow.selected && tableWorkflow.shown && tableWorkflow.inserted && tableUndoEdit.undone && tableUndoEdit.selected && imageWorkflow.shown && imageWorkflow.sourceSelected && imageDeleted && imageRestored && liveTyped && liveUndo.articlePresent && liveUndo.typedRemoved && liveUndo.focused && sourceTyped
          && initial.singleEditor && initial.liveClass && initial.headingStyled && initial.fontOptions >= 7
          && ["正文", "H1", "H2", "H3", "链接"].every((label) => initial.toolbarButtons.includes(label))
          && firstChanged && secondChanged && afterFirstDelete.focused && afterSecondDelete.focused
          && selectionMade && toolbarPersistent && italicVisible && italicStyle.fontStyle === "italic" && italicStyle.fontSynthesis.includes("style") && italicToggle.removed && italicToggle.reapplied
          && kaitiBold.applied && kaitiBold.removed && kaitiBold.fontFamily.includes("KaiTi") && Number(kaitiBold.fontWeight) >= 700 && kaitiBold.fontSynthesis.includes("weight")
          && blockTypes.headingApplied && blockTypes.normalApplied && themeApplied && themedEditInserted && themedEditUndone && commandPaletteOpened
          && final.singleEditor && final.source.includes("*测试粗体*");
        await finishSmoke("live-preview", valid, { tabSkippedClosing, markdownDiagnostics, markdownDiagnosticCleared, formulaWorkflow, tableWorkflow, tableUndoEdit, imageWorkflow, imageDeleted, imageRestored, liveTyped, liveUndo, sourceTyped, initial, afterFirstDelete, afterSecondDelete, selectionMade, selectionRendering, toolbarPersistent, italicVisible, italicStyle, italicToggle, kaitiBold, blockTypes, themeApplied, themedEditInserted, themedEditUndone, commandPaletteOpened, final, firstChanged, secondChanged });
      })().catch((error: unknown) => {
        const diagnostic = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack ?? "" } : { message: String(error) };
        void finishSmoke("live-preview", false, { error: diagnostic });
      });
    });
    window.webContents.once("did-fail-load", (_event, code, description) => { console.error(`Renderer load failed (${code}): ${description}`); void finishSmoke("live-preview", false); });
  } else if (process.env.FANTASTIC_EDITOR_UI_SMOKE_TEST === "1") {
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
          hasNewButton: Boolean(document.querySelector(\"[data-testid=new-document]\")),
          uniqueFileActions: [\"新建文档\", \"打开文件\", \"保存\", \"打开文件夹\"].every((label) => document.querySelectorAll('.activity-bar button[aria-label=\"' + label + '\"]').length === 1)
            && document.querySelectorAll('.explorer-title button, .new-tab').length === 0
        })`, true) as { hasTabs: boolean; hasDropHint: boolean; hasNewButton: boolean; uniqueFileActions: boolean };
        if (!before.uniqueFileActions) throw new Error("File actions must exist exactly once in the activity bar.");
        await window.webContents.executeJavaScript(`(() => {
          const transfer = new DataTransfer();
          transfer.items.add(new File(["# smoke"], "smoke.md", { type: "text/markdown" }));
          document.querySelector(".app-shell")?.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }));
        })()`, true);
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
        await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="分栏"]')?.click()`, true);
        await new Promise((resolve) => setTimeout(resolve, 150));
        const after = await window.webContents.executeJavaScript(`({
          tabText: document.querySelector(\".document-tab.active .tab-select span\")?.textContent ?? \"\",
          tabCount: document.querySelectorAll(\".document-tab\").length,
          editorText: document.querySelector(\".cm-content\")?.textContent ?? \"\",
          brandText: document.querySelector(\".brand-lockup\")?.textContent ?? \"\",
          hasSidebar: Boolean(document.querySelector(\".explorer-panel\")),
          hasSidebarResizeHandle: Boolean(document.querySelector(".sidebar-resize-handle")),
          hasSplitHandle: Boolean(document.querySelector(".split-handle")),
          hasInsertImageButton: Boolean(document.querySelector(".insert-image-button")),
          hasSyncScrollButton: Boolean(document.querySelector("[data-testid=sync-scroll-toggle]")),
          saveEnabled: !(document.querySelector('button[aria-label="保存"]')?.hasAttribute("disabled") ?? true),
          hasUnsavedIndicator: Boolean(document.querySelector(".document-tab.active .dirty-dot, .document-tab.active i[aria-label=未保存]")),
          statusText: document.querySelector(".status-message")?.textContent ?? "",
          viewportFits: document.documentElement.scrollWidth === document.documentElement.clientWidth
        })`, true) as { tabText: string; tabCount: number; editorText: string; brandText: string; hasSidebar: boolean; hasSidebarResizeHandle: boolean; hasSplitHandle: boolean; hasInsertImageButton: boolean; hasSyncScrollButton: boolean; saveEnabled: boolean; hasUnsavedIndicator: boolean; statusText: string; viewportFits: boolean };
        const splitHeaderLayout = await window.webContents.executeJavaScript(`(() => {
          const stage = document.querySelector('.document-stage.view-split');
          if (!(stage instanceof HTMLElement)) return { contained: false, previewScrollable: false };
          const headers = [...document.querySelectorAll('.document-stage.view-split .pane-header')];
          const actions = headers.map((header) => header.querySelector('.pane-actions')).filter((item) => item instanceof HTMLElement);
          const contained = actions.length === 2 && actions.every((item) => {
            const headerRect = item.parentElement.getBoundingClientRect();
            const actionsRect = item.getBoundingClientRect();
            return actionsRect.left >= headerRect.left && actionsRect.right <= headerRect.right + 1;
          });
          const previewActions = document.querySelector('.document-stage.view-split .preview-pane .pane-actions');
          const previewScrollable = previewActions instanceof HTMLElement
            && getComputedStyle(previewActions).overflowX === 'auto'
            && [...previewActions.children].every((item) => getComputedStyle(item).flexShrink === '0');
          return { contained, previewScrollable };
        })()`, true) as { contained: boolean; previewScrollable: boolean };
        const accessibility = await window.webContents.executeJavaScript(`(async () => {
          const separator = document.querySelector('.split-handle');
          const sidebarSeparator = document.querySelector('.sidebar-resize-handle');
          const selectedTab = document.querySelector('.document-tab.active .tab-select');
          const status = document.querySelector('.status-message');
          if (!(separator instanceof HTMLElement) || !(sidebarSeparator instanceof HTMLElement)) return { keyboardSeparator: false, keyboardSidebarSeparator: false, sidebarToggle: false, selectedTab: false, liveStatus: false };
          const before = Number(separator.getAttribute('aria-valuenow'));
          separator.focus();
          separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
          await new Promise((resolve) => setTimeout(resolve, 50));
          const after = Number(separator.getAttribute('aria-valuenow'));
          const sidebarBefore = Number(sidebarSeparator.getAttribute('aria-valuenow'));
          sidebarSeparator.focus();
          sidebarSeparator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
          await new Promise((resolve) => setTimeout(resolve, 50));
          const sidebarAfter = Number(document.querySelector('.sidebar-resize-handle')?.getAttribute('aria-valuenow'));
          const sidebarToggleButton = document.querySelector('[aria-label="切换资源管理器"]');
          if (sidebarToggleButton?.getAttribute('aria-pressed') !== 'true') {
            sidebarToggleButton?.click();
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          document.querySelector('[aria-label="切换资源管理器"]')?.click();
          await new Promise((resolve) => setTimeout(resolve, 50));
          const sidebarHidden = !document.querySelector('.explorer-panel');
          document.querySelector('[aria-label="切换资源管理器"]')?.click();
          await new Promise((resolve) => setTimeout(resolve, 50));
          return {
            keyboardSeparator: separator.tabIndex === 0 && after > before,
            keyboardSidebarSeparator: sidebarSeparator.tabIndex === 0 && sidebarAfter > sidebarBefore,
            sidebarToggle: sidebarHidden && Boolean(document.querySelector('.explorer-panel')),
            selectedTab: selectedTab?.getAttribute('role') === 'tab' && selectedTab.getAttribute('aria-selected') === 'true',
            liveStatus: status?.getAttribute('role') === 'status' && status.getAttribute('aria-live') === 'polite',
          };
        })()`, true) as { keyboardSeparator: boolean; keyboardSidebarSeparator: boolean; sidebarToggle: boolean; selectedTab: boolean; liveStatus: boolean };
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
          const presets = document.querySelector("[data-testid=preview-font-preset]");
          if (!(presets instanceof HTMLSelectElement)) return { exists: false, applied: false, hasArial: false };
          const hasArial = Array.from(presets.options).some((option) => option.value === "Arial") && presets.options.length >= 7;
          const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
          setter?.call(presets, "KaiTi");
          presets.dispatchEvent(new Event("change", { bubbles: true }));
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
        await window.webContents.insertText("# Mermaid smoke\n\n剪贴板 HTML 测试\n\n跨块格式甲\n\n跨块格式乙\n\n跨块粘贴甲\n\n跨块粘贴乙\n\n***\n\n***\n\n***\n\n混合前 [链接](https://example.com) 与 `代码`、$a+b$、![inline image](missing.png) 混合后\n\n下表为**中性情景**下的工作假设：\n\n| 期间 | 情景 |\n| --- | --- |\n| 2026Q3 | 预测 |\n\n> 引用原文\n\n- 列表原项\n- [ ] 待完成\n- 嵌套父项\n  - 嵌套子项\n  - [ ] 嵌套任务\n- 嵌套后项\n\n![smoke image](missing.png)\n\n$$\nx + y\n$$\n\n```ts\nconst value = 1;\n```\n\n```mermaid\ngraph TD\n  A --> B\n```\n\n* \n* \n  * \n* \n");
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
          if (!(button instanceof HTMLButtonElement)) return { opened: false, completed: false, widthCount: 0, hasHeadingAuditCopy: false, hasActions: false, keyboardDialog: false, focusRestored: false };
          const ready = await waitFor(() => !button.disabled);
          if (!ready) return { opened: false, completed: false, widthCount: 0, hasHeadingAuditCopy: false, hasActions: false, keyboardDialog: false, focusRestored: false };
          button.click();
          const opened = await waitFor(() => Boolean(document.querySelector(".wechat-preview-dialog")));
          const completed = opened && await waitFor(() => document.querySelectorAll(".viewport-buttons button:not(.running)").length === 3);
          const widthCount = document.querySelectorAll(".viewport-buttons button").length;
          const hasHeadingAuditCopy = document.querySelector(".wechat-audit-panel")?.textContent?.includes("三档宽度") ?? false;
          const hasActions = ["接口与封面设置", "准备公众号内容", "同步到草稿箱", "发布"].every((label) => [...document.querySelectorAll(".wechat-inspector-actions button")].some((item) => item.textContent?.trim() === label));
          const dialog = document.querySelector('.wechat-preview-panel');
          const closeButton = document.querySelector('button[aria-label="关闭公众号主题预览"]');
          const keyboardDialog = dialog?.getAttribute('role') === 'region'
            && dialog?.getAttribute('aria-modal') === null
            && Boolean(dialog.getAttribute('aria-labelledby'))
            && closeButton instanceof HTMLButtonElement;
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
          const closed = await waitFor(() => !document.querySelector('.wechat-preview-dialog'));
          await new Promise((resolve) => setTimeout(resolve, 50));
          const focusRestored = closed && document.activeElement === button;
          return { opened, completed, widthCount, hasHeadingAuditCopy, hasActions, keyboardDialog, focusRestored };
        })()`, true) as { opened: boolean; completed: boolean; widthCount: number; hasHeadingAuditCopy: boolean; hasActions: boolean; keyboardDialog: boolean; focusRestored: boolean };
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
          const sourceButton = document.querySelector('button[aria-label="分栏"]');
          const visualButton = document.querySelector('button[aria-label="写作模式"]');
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
          let headingLevelsApplied = false;
          let italicChineseApplied = false;
          let italicChineseVisible = false;
          let italicToggleOff = false;
          let boldToggleOff = false;
          let formatSelectionRetained = false;
          let toolbarLinkApplied = false;
          let blockToolbarPersistent = false;
          let blockToolbarRepeatedMove = false;
          let emptyListItemDeleted = false;
          const repeatedBreaksCompacted = document.querySelector(".wysiwyg-thematic-break-group")?.textContent?.includes("×3") === true
            && document.querySelectorAll(".wysiwyg-editor-layer.active hr").length === 0;
          const headingLevelTrace = [];
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
          const applyHeadingLevel = async (level, title) => {
            const heading = [...document.querySelectorAll(".wysiwyg-editor-layer.active h1, .wysiwyg-editor-layer.active h2, .wysiwyg-editor-layer.active h3")]
              .find((element) => element.textContent?.includes("Mermaid smoke"));
            if (!(heading instanceof HTMLElement)) return false;
            const rect = heading.getBoundingClientRect();
            heading.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: rect.left + 8, clientY: rect.top + rect.height / 2 }));
            const buttonReady = await waitFor(() => [...document.querySelectorAll(".wysiwyg-toolbar button")].some((button) => button.getAttribute("title") === title));
            const button = [...document.querySelectorAll(".wysiwyg-toolbar button")].find((candidate) => candidate.getAttribute("title") === title);
            if (!buttonReady || !(button instanceof HTMLButtonElement)) return false;
            button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
            const applied = await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes("#".repeat(level) + " Mermaid smoke")
              && [...document.querySelectorAll(".wysiwyg-editor-layer.active h" + level)].some((element) => element.textContent?.includes("Mermaid smoke")));
            headingLevelTrace.push({
              level,
              applied,
              source: document.querySelector(".cm-content")?.textContent ?? "",
              renderedTag: [...document.querySelectorAll(".wysiwyg-editor-layer.active h1, .wysiwyg-editor-layer.active h2, .wysiwyg-editor-layer.active h3")]
                .find((element) => element.textContent?.includes("Mermaid smoke"))?.tagName ?? "missing",
              status: document.querySelector(".status-message")?.textContent ?? "",
            });
            return applied;
          };
          headingLevelsApplied = await applyHeadingLevel(2, "二级标题")
            && await applyHeadingLevel(3, "三级标题")
            && await applyHeadingLevel(1, "一级标题");
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
          const boldToolbarButton = document.querySelector('.wysiwyg-toolbar button[title^="粗体"]');
          if (formatStart && boldToolbarButton instanceof HTMLButtonElement) {
            boldToolbarButton.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
            boldToolbarButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
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
          const directItalicButton = document.querySelector('.wysiwyg-toolbar button[title^="斜体"]');
          if (directItalicButton instanceof HTMLButtonElement) {
            directItalicButton.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
            italicChineseApplied = await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes("*可视编辑已写回*"));
            const italicElement = paragraph.querySelector("em, i");
            italicChineseVisible = italicElement instanceof HTMLElement && getComputedStyle(italicElement).transform !== "none";
            formatSelectionRetained = Boolean(window.getSelection() && !window.getSelection().isCollapsed && paragraph.contains(window.getSelection().anchorNode));
            if (italicElement instanceof HTMLElement) {
              const legacyDuplicate = document.createElement("em");
              legacyDuplicate.className = "wysiwyg-italic-visual";
              italicElement.replaceWith(legacyDuplicate);
              legacyDuplicate.append(italicElement);
              const legacyRange = document.createRange();
              legacyRange.selectNodeContents(italicElement);
              const legacySelection = window.getSelection();
              legacySelection?.removeAllRanges();
              legacySelection?.addRange(legacyRange);
            }
            directItalicButton.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
            italicToggleOff = await waitFor(() => !paragraph.querySelector("em, i") && (document.querySelector(".cm-content")?.textContent ?? "").includes("可视编辑已写回"));
          }
          const directBoldButton = document.querySelector('.wysiwyg-toolbar button[title^="粗体"]');
          if (directBoldButton instanceof HTMLButtonElement) {
            directBoldButton.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
            await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes("**可视编辑已写回**"));
            directBoldButton.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
            boldToggleOff = await waitFor(() => !paragraph.querySelector("strong, b") && (document.querySelector(".cm-content")?.textContent ?? "").includes("可视编辑已写回"));
            directBoldButton.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
          }
          const edited = await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes("可视编辑已写回"));
          const formatted = await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes("**可视编辑已写回**"));
          const afterEdit = document.querySelector(".cm-content")?.textContent ?? "";
          const formattedParagraph = [...document.querySelectorAll(".wysiwyg-editor-layer.active .wysiwyg-content > p")].find((element) => element.textContent?.includes("可视编辑已写回"));
          if (formattedParagraph instanceof HTMLElement) {
            formattedParagraph.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
            formattedParagraph.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
            await waitFor(() => !(document.activeElement instanceof HTMLElement) || !formattedParagraph.contains(document.activeElement));
          }
          window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
          const undone = await waitFor(() => !(document.querySelector(".cm-content")?.textContent ?? "").includes("**可视编辑已写回**"));
          const afterUndo = document.querySelector(".cm-content")?.textContent ?? "";
          window.dispatchEvent(new KeyboardEvent("keydown", { key: "y", ctrlKey: true, bubbles: true, cancelable: true }));
          const redone = await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes("**可视编辑已写回**"));
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
          const toolbarLinkTargetReady = await waitFor(() => [...document.querySelectorAll(".wysiwyg-editor-layer.active h1")].some((element) => element.textContent?.includes("IMA 标题")));
          const toolbarLinkTarget = [...document.querySelectorAll(".wysiwyg-editor-layer.active h1")].find((element) => element.textContent?.includes("IMA 标题"));
          if (toolbarLinkTargetReady && toolbarLinkTarget instanceof HTMLElement) {
            const rect = toolbarLinkTarget.getBoundingClientRect();
            toolbarLinkTarget.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: rect.left + 8, clientY: rect.top + rect.height / 2 }));
            const node = toolbarLinkTarget.firstChild;
            if (node instanceof Text) {
              const from = node.textContent?.indexOf("IMA 标题") ?? -1;
              const range = document.createRange();
              range.setStart(node, from);
              range.setEnd(node, from + "IMA 标题".length);
              const selection = window.getSelection();
              selection?.removeAllRanges();
              selection?.addRange(range);
              document.querySelector('.wysiwyg-toolbar button[title^="添加链接"]')?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
              const inputReady = await waitFor(() => document.querySelector("[data-testid=wysiwyg-link-create-destination]") instanceof HTMLInputElement);
              const input = document.querySelector("[data-testid=wysiwyg-link-create-destination]");
              if (inputReady && input instanceof HTMLInputElement) {
                const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
                setter?.call(input, "https://example.com/toolbar");
                input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
                input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
                toolbarLinkApplied = await waitFor(() => (document.querySelector(".cm-content")?.textContent ?? "").includes("[IMA 标题](https://example.com/toolbar)"))
                  && Boolean(window.getSelection() && !window.getSelection().isCollapsed && toolbarLinkTarget.contains(window.getSelection().anchorNode));
              }
            }
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
            const blockToolbarReady = await waitFor(() => {
              const select = document.querySelector(".wysiwyg-block-toolbar select");
              return select instanceof HTMLSelectElement && !select.disabled;
            });
            const insertSelect = document.querySelector(".wysiwyg-block-toolbar select");
            if (blockToolbarReady && insertSelect instanceof HTMLSelectElement) {
              const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
              setter?.call(insertSelect, "quote");
              insertSelect.dispatchEvent(new Event("change", { bubbles: true }));
              [...document.querySelectorAll(".wysiwyg-block-toolbar button")].find((button) => button.textContent?.includes("下方插入"))?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
              blockInserted = await waitFor(() => [...document.querySelectorAll(".wysiwyg-editor-layer.active blockquote")].some((element) => element.textContent?.includes("新引用")));
            }
          }
          const insertedQuote = [...document.querySelectorAll(".wysiwyg-editor-layer.active blockquote")].find((element) => element.textContent?.includes("新引用"));
          if (insertedQuote instanceof HTMLElement) {
            const rect = insertedQuote.getBoundingClientRect();
            insertedQuote.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: rect.left + 8, clientY: rect.top + rect.height / 2 }));
            const gripReady = await waitFor(() => {
              const button = document.querySelector(".wysiwyg-block-grip");
              return button instanceof HTMLButtonElement && !button.disabled;
            });
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
            blockToolbarPersistent = await waitFor(() => {
              const activeBlock = document.querySelector(".wysiwyg-editor-layer.active .wysiwyg-block-active");
              const enabledMove = [...document.querySelectorAll(".wysiwyg-block-toolbar button")]
                .some((button) => (button.textContent?.trim() === "上移" || button.textContent?.trim() === "下移") && button instanceof HTMLButtonElement && !button.disabled);
              return activeBlock?.textContent?.includes("新引用") === true && enabledMove;
            });
            const activeBeforeRepeat = document.querySelector(".wysiwyg-editor-layer.active .wysiwyg-block-active");
            const beforeRepeatFrom = activeBeforeRepeat instanceof HTMLElement ? activeBeforeRepeat.dataset.sourceFrom : undefined;
            const repeatMoveButton = [...document.querySelectorAll(".wysiwyg-block-toolbar button")]
              .find((button) => (button.textContent?.trim() === "下移" || button.textContent?.trim() === "上移") && button instanceof HTMLButtonElement && !button.disabled);
            if (repeatMoveButton instanceof HTMLButtonElement) {
              repeatMoveButton.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
              blockToolbarRepeatedMove = await waitFor(() => {
                const activeAfterRepeat = document.querySelector(".wysiwyg-editor-layer.active .wysiwyg-block-active");
                return activeAfterRepeat instanceof HTMLElement
                  && activeAfterRepeat.textContent?.includes("新引用") === true
                  && activeAfterRepeat.dataset.sourceFrom !== beforeRepeatFrom
                  && [...document.querySelectorAll(".wysiwyg-block-toolbar button")].some((button) => button instanceof HTMLButtonElement && !button.disabled);
              });
            }
          }
          await waitFor(() => [...document.querySelectorAll(".wysiwyg-editor-layer.active blockquote")].filter((element) => element.textContent?.includes("新引用")).length === 1);
          const quoteForDuplicate = [...document.querySelectorAll(".wysiwyg-editor-layer.active blockquote")].find((element) => element.textContent?.includes("新引用"));
          if (quoteForDuplicate instanceof HTMLElement) {
            const rect = quoteForDuplicate.getBoundingClientRect();
            quoteForDuplicate.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: rect.left + 8, clientY: rect.top + rect.height / 2 }));
            await waitFor(() => [...document.querySelectorAll(".wysiwyg-block-toolbar button")].some((button) => button.textContent?.trim() === "复制" && button instanceof HTMLButtonElement && !button.disabled));
            [...document.querySelectorAll(".wysiwyg-block-toolbar button")].find((button) => button.textContent?.trim() === "复制")?.click();
            blockDuplicated = await waitFor(() => [...document.querySelectorAll(".wysiwyg-editor-layer.active blockquote")].filter((element) => element.textContent?.includes("新引用")).length === 2);
          }
          await waitFor(() => [...document.querySelectorAll(".wysiwyg-editor-layer.active blockquote")].filter((element) => element.textContent?.includes("新引用")).length === 2);
          const quoteForDelete = [...document.querySelectorAll(".wysiwyg-editor-layer.active blockquote")].find((element) => element.textContent?.includes("新引用"));
          if (quoteForDelete instanceof HTMLElement) {
            const rect = quoteForDelete.getBoundingClientRect();
            quoteForDelete.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: rect.left + 8, clientY: rect.top + rect.height / 2 }));
            await waitFor(() => [...document.querySelectorAll(".wysiwyg-block-toolbar button")].some((button) => button.textContent?.trim() === "删除" && button instanceof HTMLButtonElement && !button.disabled));
            const originalConfirm = window.confirm;
            window.confirm = () => true;
            [...document.querySelectorAll(".wysiwyg-block-toolbar button")].find((button) => button.textContent?.trim() === "删除")?.click();
            window.confirm = originalConfirm;
            blockDeleted = await waitFor(() => [...document.querySelectorAll(".wysiwyg-editor-layer.active blockquote")].filter((element) => element.textContent?.includes("新引用")).length === 1);
          }
          const emptyItems = [...document.querySelectorAll('.wysiwyg-editor-layer.active [data-wysiwyg-editability=direct]')]
            .filter((item) => item.closest("li") && !(item.textContent ?? "").trim());
          const emptyItem = emptyItems[0];
          if (emptyItem instanceof HTMLElement) {
            const rect = emptyItem.getBoundingClientRect();
            emptyItem.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: rect.left + 8, clientY: rect.top + rect.height / 2 }));
            if (await waitFor(() => emptyItem.isContentEditable)) {
              emptyItem.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
              const firstDeleted = await waitFor(() => [...document.querySelectorAll('.wysiwyg-editor-layer.active [data-wysiwyg-editability=direct]')]
                .filter((item) => item.closest("li") && !(item.textContent ?? "").trim()).length === emptyItems.length - 1);
              const nextItem = document.activeElement;
              if (firstDeleted && nextItem instanceof HTMLElement && nextItem.closest("li")) {
                nextItem.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true, repeat: true }));
                emptyListItemDeleted = await waitFor(() => [...document.querySelectorAll('.wysiwyg-editor-layer.active [data-wysiwyg-editability=direct]')]
                  .filter((item) => item.closest("li") && !(item.textContent ?? "").trim()).length === emptyItems.length - 2);
              }
            }
          }
          sourceButton.click();
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
            headingLevelsApplied,
            headingLevelTrace,
            italicChineseApplied,
            italicChineseVisible,
            italicToggleOff,
            boldToggleOff,
            formatSelectionRetained,
            toolbarLinkApplied,
            blockToolbarPersistent,
            blockToolbarRepeatedMove,
            repeatedBreaksCompacted,
            emptyListItemDeleted,
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
        })()`, true) as { exists: boolean; ready?: boolean; edited?: boolean; directInputReady?: boolean; caretInside?: boolean; browserInserted?: boolean; formatted?: boolean; italicChineseApplied?: boolean; italicChineseVisible?: boolean; italicToggleOff?: boolean; boldToggleOff?: boolean; formatSelectionRetained?: boolean; toolbarLinkApplied?: boolean; blockToolbarPersistent?: boolean; blockToolbarRepeatedMove?: boolean; repeatedBreaksCompacted?: boolean; emptyListItemDeleted?: boolean; paragraphBreaks?: boolean; mergedParagraphs?: boolean; compositionDeferred?: boolean; blankParagraphAdded?: boolean; blankParagraphDeduplicated?: boolean; blankParagraphDeleted?: boolean; multilinePasteHandled?: boolean; imageAltEdited?: boolean; formulaStructuredApplied?: boolean; codeStructuredApplied?: boolean; linkStructuredApplied?: boolean; inlineCodeStructuredApplied?: boolean; mixedInlineEdited?: boolean; mixedAtomsProtected?: boolean; protectedSelectionRejected?: boolean; crossBlockFormatted?: boolean; crossBlockPasted?: boolean; crossBlockProtectedRejected?: boolean; dualFormatCopy?: boolean; selectAllCopy?: boolean; externalHtmlPaste?: boolean; imaRichPaste?: boolean; blockInserted?: boolean; blockDragged?: boolean; blockDuplicated?: boolean; blockDeleted?: boolean; blockKeyboardMoved?: boolean; headingLevelsApplied?: boolean; tableCellEdited?: boolean; tableColumnInserted?: boolean; tableAlignmentApplied?: boolean; tableRowAppended?: boolean; listItemEdited?: boolean; listDirectReady?: boolean; listBrowserInserted?: boolean; listIndented?: boolean; listOutdented?: boolean; nestedParentEdited?: boolean; nestedSubtreeIndented?: boolean; nestedSubtreeOutdented?: boolean; quoteEdited?: boolean; taskToggled?: boolean; undone?: boolean; redone?: boolean; sourceCardApplied?: boolean; visualWasActive?: boolean; sourceRestored?: boolean; afterEdit?: string; afterUndo?: string; afterRedo?: string };
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
          const visualButton = document.querySelector('button[aria-label="写作模式"]');
          const sourceButton = document.querySelector('button[aria-label="源码模式"]');
          if (!(visualButton instanceof HTMLButtonElement) || !(sourceButton instanceof HTMLButtonElement)) return { fontControl: false, scrollPreserved: false, directPreview: false, previewMermaid: false, inlineOutline: false, outlineButtonRemoved: false, repairButton: false, searchButton: false };
          visualButton.click();
          await waitFor(() => Boolean(document.querySelector(".wysiwyg-editor-layer.active .wysiwyg-content")));
          const container = document.querySelector(".wysiwyg-editor-layer.active .wysiwyg-editor");
          const fontPreset = document.querySelector("[data-testid=wysiwyg-font-preset]");
          const defaultFont = document.querySelector(".wysiwyg-font-default");
          let scrollPreserved = false;
          if (container instanceof HTMLElement && fontPreset instanceof HTMLSelectElement) {
            container.scrollTop = Math.min(700, Math.max(1, container.scrollHeight - container.clientHeight));
            const before = container.scrollTop;
            const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
            setter?.call(fontPreset, fontPreset.value === "KaiTi" ? "Arial" : "KaiTi");
            fontPreset.dispatchEvent(new Event("change", { bubbles: true }));
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
          const repairControl = document.querySelector('[data-testid="repair-web-markdown"]');
          const repairButton = repairControl instanceof HTMLButtonElement && !repairControl.disabled;
          const searchButton = Boolean(document.querySelector('button[aria-label="搜索"]'));
          document.querySelector('button[aria-label="写作模式"]')?.click();
          sourceButton.click();
          await waitFor(() => Boolean(document.querySelector(".source-editor-layer.active")));
          return { fontControl: defaultFont instanceof HTMLButtonElement && fontPreset instanceof HTMLSelectElement && fontPreset.options.length >= 7, scrollPreserved, directPreview, previewMermaid, inlineOutline, outlineButtonRemoved, repairButton, searchButton };
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
        await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="写作模式"]')?.click()`, true);
        await new Promise((resolve) => setTimeout(resolve, 300));
        window.show();
        await new Promise((resolve) => setTimeout(resolve, 250));
        const image = await window.webContents.capturePage();
        await writeFile(join(process.cwd(), "fantastic-editor-ui-smoke.png"), image.toPNG());
        await window.webContents.executeJavaScript(`document.querySelector(\".theme-toggle\")?.click()`, true);
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (syncEnabled !== syncBefore) await window.webContents.executeJavaScript(`document.querySelector("[data-testid=sync-scroll-toggle]")?.click()`, true);
        if (!after.hasSidebarResizeHandle || !accessibility.keyboardSidebarSeparator || !accessibility.sidebarToggle) throw new Error(`Resource explorer resize or visibility smoke failed: ${JSON.stringify({ hasSidebarResizeHandle: after.hasSidebarResizeHandle, keyboardSidebarSeparator: accessibility.keyboardSidebarSeparator, sidebarToggle: accessibility.sidebarToggle })}`);
        const valid = uiReady && before.hasTabs && before.hasDropHint && before.hasNewButton && drag.hasDropOverlay && after.tabCount === 1 && after.tabText === "未命名" && after.editorText === "" && after.saveEnabled && after.hasUnsavedIndicator && after.brandText.includes("fantasticeditor") && after.hasSidebar && after.hasSplitHandle && after.hasInsertImageButton && after.hasSyncScrollButton && after.viewportFits && splitHeaderLayout.contained && splitHeaderLayout.previewScrollable && accessibility.keyboardSeparator && accessibility.selectedTab && accessibility.liveStatus && recentBoundary.listed && recentBoundary.opaque && tabShortcuts.created && tabShortcuts.reorderedLeft && tabShortcuts.reorderedRight && tabShortcuts.previous && tabShortcuts.next && tabShortcuts.closed && fontControl.exists && fontControl.applied && fontControl.hasArial && fontApplied && mermaidRendered && performanceMetric.exists && performanceMetric.text.includes("解析") && performanceMetric.accessible && wechatThemePreview.opened && wechatThemePreview.completed && wechatThemePreview.widthCount === 3 && wechatThemePreview.hasHeadingAuditCopy && wechatThemePreview.hasActions && wechatThemePreview.keyboardDialog && wechatThemePreview.focusRestored && /ON|OFF/.test(syncTextBefore) && syncBefore !== "missing" && syncAfter !== syncBefore && syncEnabled === "true" && selectionBoxCount > 0 && wysiwyg.exists && wysiwyg.ready && wysiwyg.edited && wysiwyg.directInputReady && wysiwyg.caretInside && wysiwyg.browserInserted && wysiwyg.formatted && wysiwyg.italicChineseApplied && wysiwyg.italicChineseVisible && wysiwyg.italicToggleOff && wysiwyg.boldToggleOff && wysiwyg.formatSelectionRetained && wysiwyg.toolbarLinkApplied && wysiwyg.headingLevelsApplied && wysiwyg.paragraphBreaks && wysiwyg.mergedParagraphs && wysiwyg.compositionDeferred && wysiwyg.blankParagraphAdded && wysiwyg.blankParagraphDeduplicated && wysiwyg.blankParagraphDeleted && wysiwyg.multilinePasteHandled && wysiwyg.imageAltEdited && wysiwyg.formulaStructuredApplied && wysiwyg.codeStructuredApplied && wysiwyg.linkStructuredApplied && wysiwyg.inlineCodeStructuredApplied && wysiwyg.mixedInlineEdited && wysiwyg.mixedAtomsProtected && wysiwyg.protectedSelectionRejected && wysiwyg.crossBlockFormatted && wysiwyg.crossBlockPasted && wysiwyg.crossBlockProtectedRejected && wysiwyg.dualFormatCopy && wysiwyg.selectAllCopy && wysiwyg.externalHtmlPaste && wysiwyg.imaRichPaste && wysiwyg.blockInserted && wysiwyg.blockDragged && wysiwyg.blockDuplicated && wysiwyg.blockDeleted && wysiwyg.blockKeyboardMoved && wysiwyg.blockToolbarPersistent && wysiwyg.blockToolbarRepeatedMove && wysiwyg.repeatedBreaksCompacted && wysiwyg.tableCellEdited && wysiwyg.tableColumnInserted && wysiwyg.tableAlignmentApplied && wysiwyg.tableRowAppended && wysiwyg.listItemEdited && wysiwyg.listDirectReady && wysiwyg.listBrowserInserted && wysiwyg.listIndented && wysiwyg.listOutdented && wysiwyg.nestedParentEdited && wysiwyg.nestedSubtreeIndented && wysiwyg.nestedSubtreeOutdented && wysiwyg.quoteEdited && wysiwyg.taskToggled && wysiwyg.undone && wysiwyg.redone && wysiwyg.sourceCardApplied && wysiwyg.sourceRestored && viewWorkflow.fontControl && viewWorkflow.scrollPreserved && viewWorkflow.directPreview && viewWorkflow.previewMermaid && viewWorkflow.inlineOutline && viewWorkflow.outlineButtonRemoved && viewWorkflow.repairButton && viewWorkflow.searchButton && imageBridge.status === "failed" && imageBridge.error.includes("会话") && themeAfter !== themeBefore;
        console.log(JSON.stringify({ uiReady, before, drag, after, splitHeaderLayout, accessibility, recentBoundary, tabShortcuts, fontControl, fontApplied, mermaidEditorText, mermaidDebug, mermaidRendered, performanceMetric, wechatThemePreview, syncScroll: { before: syncBefore, after: syncAfter, enabled: syncEnabled, selectionBoxCount }, wysiwyg, viewWorkflow, imageBridge, theme: { before: themeBefore, after: themeAfter }, screenshot: "fantastic-editor-ui-smoke.png", valid }));
      await finishSmoke("ui", valid === true, { uiReady, before, drag, after, splitHeaderLayout, accessibility, recentBoundary, tabShortcuts, fontControl, fontApplied, mermaidEditorText, mermaidDebug, mermaidRendered, performanceMetric, wechatThemePreview, syncScroll: { before: syncBefore, after: syncAfter, enabled: syncEnabled, selectionBoxCount }, wysiwyg, viewWorkflow, imageBridge, theme: { before: themeBefore, after: themeAfter } });
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
    showWhenLoaded = true;
  }
  let loadPromise: Promise<void>;
  if (process.env.ELECTRON_RENDERER_URL) {
    const rendererUrl = new URL(process.env.ELECTRON_RENDERER_URL);
    if (process.env.FANTASTIC_EDITOR_UI_SMOKE_TEST === "1") rendererUrl.searchParams.set("legacy-wysiwyg-smoke", "1");
    loadPromise = window.loadURL(rendererUrl.toString());
  } else {
    loadPromise = window.loadFile(join(__dirname, "../renderer/index.html"), process.env.FANTASTIC_EDITOR_UI_SMOKE_TEST === "1"
      ? { query: { "legacy-wysiwyg-smoke": "1" } }
      : undefined);
  }
  if (showWhenLoaded) {
    void loadPromise.then(() => {
      if (!window.isDestroyed()) window.show();
    }).catch((error: unknown) => {
      console.error("Renderer failed to load.", error);
    });
  }
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
  documentHistoryStore = new DocumentHistoryStore(join(app.getPath("userData"), "document-history-v1"));
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
