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
  type AiWechatThemeSuggestionRequest,
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
import { buildWechatThemeSuggestionPrompt, parseWechatThemeSuggestion, validateWechatThemeSuggestionRequest } from "./ai-wechat-theme.js";
import { DeepSeekApi } from "./deepseek-api.js";
import { GeminiApi } from "./gemini-api.js";
import { DocumentHistoryStore } from "./document-history-store.js";
import { installRendererSmokeTests } from "./renderer-smoke-tests.js";


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
  // Vite's React refresh preamble is an inline module in development. The
  // packaged renderer keeps the stricter policy below.
  const scriptPolicy = process.env.ELECTRON_RENDERER_URL ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'";
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          `default-src 'self'; ${scriptPolicy}; style-src 'self' 'unsafe-inline'; img-src 'self' fantastic-asset:; font-src 'self' data:; connect-src 'self' ws:`,
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
  ipcMain.handle(IPC_CHANNELS.suggestWechatTheme, async (event, request: AiWechatThemeSuggestionRequest) => {
    requireTrustedRenderer(event);
    if (!validateWechatThemeSuggestionRequest(request)) return { status: "failed", code: "INVALID_REQUEST", error: "AI 排版请求无效或超过长度上限。" } as const;
    const result = await aiCliService.invokePrompt(request, buildWechatThemeSuggestionPrompt(request));
    if (result.status !== "completed") return result;
    try { return { status: "completed", suggestion: parseWechatThemeSuggestion(result.result) } as const; }
    catch (error) { return { status: "failed", code: "INVALID_THEME_SUGGESTION", error: error instanceof Error ? error.message : "AI 主题建议无效。" } as const; }
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
    const opened = await openWithConversionConfirmation((options) => /\.(?:md|markdown)$/i.test(path)
      ? fileSessions.openPath(path, options)
      : fileSessions.importStructuredText(path, options));
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
    if (fileSessions.isImportedStructured(request.sessionId)) {
      const owner = BrowserWindow.fromWebContents(event.sender);
      const options: MessageBoxOptions = {
        type: "question",
        title: "保存导入的配置文件",
        message: "请选择保存方式",
        detail: "“按原格式保存”会移除 Markdown 围栏，并使用原文件的 UTF-8/GB18030 编码和换行格式覆盖原文件；“另存为 Markdown”会保留围栏和结构化显示。",
        buttons: ["按原格式保存", "另存为 Markdown", "取消"],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      };
      const choice = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
      if (choice.response === 2) return { status: "cancelled" } as const;
      if (choice.response === 0) return await fileSessions.saveImportedStructured(request);
      const saveOptions = {
        title: "另存为 Markdown",
        defaultPath: fileSessions.getSuggestedSaveName(request.sessionId),
        filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
      };
      const result = owner ? await dialog.showSaveDialog(owner, saveOptions) : await dialog.showSaveDialog(saveOptions);
      if (result.canceled || !result.filePath) return { status: "cancelled" } as const;
      const savedAsMarkdown = await fileSessions.save(request, result.filePath);
      if (savedAsMarkdown.status !== "saved") return savedAsMarkdown;
      const path = fileSessions.getSavedPath(request.sessionId);
      if (path) await documentHistoryStore?.record(path, request.editorText);
      await rememberRecentFile(result.filePath);
      parseCommits.clear(); resourceResolver.revokeAllHandles(); previewDerivedCache.revokeAll(); outputService.clear();
      return { ...savedAsMarkdown, saveMode: "markdown" } as const;
    }
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
  const showWhenLoaded = !installRendererSmokeTests(window, finishSmoke);
  let loadPromise: Promise<void>;
  if (process.env.ELECTRON_RENDERER_URL) {
    const rendererUrl = new URL(process.env.ELECTRON_RENDERER_URL);
    loadPromise = window.loadURL(rendererUrl.toString());
  } else {
    loadPromise = window.loadFile(join(__dirname, "../renderer/index.html"));
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
