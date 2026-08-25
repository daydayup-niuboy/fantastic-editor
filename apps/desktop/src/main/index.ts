import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  protocol,
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
  type FileSessionRequest,
  type ImageImportSessionRequest,
  type ImportDroppedImagesRequest,
  type OpenWorkspaceFileRequest,
  type OpenFileResult,
  type OutputContext,
  type ParseCommitRequest,
  type PersistRecoveryRequest,
  type ResolveRequest,
  type SaveFileRequest,
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
import { PdfRenderWindow } from "./pdf-render-window.js";
import { RecoveryStore } from "./recovery-store.js";
import { ImageImportService } from "./image-import-service.js";


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
const pdfRenderWindow = new PdfRenderWindow();
const resourceResolver = new SingleFileResourceResolver(parseCommits, assetHandles);
const svgPreviewCoordinator = new SvgPreviewCoordinator(assetHandles, previewDerivedCache, imageTransformProcess);
let mainWindow: BrowserWindow | null = null;
let recoveryStore: RecoveryStore | undefined;
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
        if (/\b(?:file:|blob:|https?:\/\/localhost|fantastic-asset:)|<script\b|\son\w+\s*=/i.test(html)) {
          return { status: "failed", error: "公众号 HTML 含禁止的本地、临时、脚本或事件内容，未写入剪贴板。" };
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
);

function requireTrustedRenderer(event: IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error("IPC request did not originate from the active main frame.");
  }
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
      return { status: "copied", itemId: request.itemId } as const;
    } catch {
      return { status: "failed", error: "复制替换图片失败。" } as const;
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
        const after = await window.webContents.executeJavaScript(`({
          tabText: document.querySelector(\".document-tab.active .tab-select span\")?.textContent ?? \"\",
          tabCount: document.querySelectorAll(\".document-tab\").length,
          editorText: document.querySelector(\".cm-content\")?.textContent ?? \"\",
          brandText: document.querySelector(\".brand-lockup\")?.textContent ?? \"\",
          hasSidebar: Boolean(document.querySelector(\".explorer-panel\")),
          hasSplitHandle: Boolean(document.querySelector(".split-handle")),
          hasInsertImageButton: Boolean(document.querySelector(".insert-image-button")),
          hasSyncScrollButton: Boolean(document.querySelector("[data-testid=sync-scroll-toggle]")),
          viewportFits: document.documentElement.scrollWidth === document.documentElement.clientWidth
        })`, true) as { tabText: string; tabCount: number; editorText: string; brandText: string; hasSidebar: boolean; hasSplitHandle: boolean; hasInsertImageButton: boolean; hasSyncScrollButton: boolean; viewportFits: boolean };
        const syncBefore = await window.webContents.executeJavaScript(`document.querySelector("[data-testid=sync-scroll-toggle]")?.getAttribute("aria-pressed") ?? "missing"`, true) as string;
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
        window.show();
        await new Promise((resolve) => setTimeout(resolve, 250));
        const image = await window.webContents.capturePage();
        await writeFile(join(process.cwd(), "fantastic-editor-ui-smoke.png"), image.toPNG());
        await window.webContents.executeJavaScript(`document.querySelector(\".theme-toggle\")?.click()`, true);
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (syncEnabled !== syncBefore) await window.webContents.executeJavaScript(`document.querySelector("[data-testid=sync-scroll-toggle]")?.click()`, true);
        const valid = uiReady && before.hasTabs && before.hasDropHint && before.hasNewButton && drag.hasDropOverlay && after.tabCount === 1 && after.tabText === "未命名" && after.editorText.includes("未命名文档") && after.brandText.includes("fantasticeditor") && after.hasSidebar && after.hasSplitHandle && after.hasInsertImageButton && after.hasSyncScrollButton && after.viewportFits && syncBefore !== "missing" && syncAfter !== syncBefore && syncEnabled === "true" && selectionBoxCount > 0 && imageBridge.status === "failed" && imageBridge.error.includes("会话") && themeAfter !== themeBefore;
        console.log(JSON.stringify({ uiReady, before, drag, after, syncScroll: { before: syncBefore, after: syncAfter, enabled: syncEnabled, selectionBoxCount }, imageBridge, theme: { before: themeBefore, after: themeAfter }, screenshot: "fantastic-editor-ui-smoke.png", valid }));
        app.exit(valid ? 0 : 1);
      })().catch((error: unknown) => { console.error(error); app.exit(1); });
    });
    window.webContents.once("did-fail-load", (_event, code, description) => { console.error(`Renderer load failed (${code}): ${description}`); app.exit(1); });
  } else if (process.env.FANTASTIC_EDITOR_SMOKE_TEST === "1") {
    window.webContents.once("did-finish-load", () => app.quit());
    window.webContents.once("did-fail-load", (_event, code, description) => {
      console.error(`Renderer load failed (${code}): ${description}`);
      app.exit(1);
    });
  } else {
    window.once("ready-to-show", () => window.show());
  }
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void window.loadFile(join(__dirname, "../renderer/index.html"));
  return window;
}

app.whenReady().then(() => {
  registerSecurityPolicy();
  registerAssetProtocol();
  const recoveryDirectory = process.env.FANTASTIC_EDITOR_UI_SMOKE_TEST === "1"
    ? join(app.getPath("temp"), `fantastic-editor-recovery-smoke-${process.pid}`)
    : join(app.getPath("userData"), "recovery-v1");
  recoveryStore = new RecoveryStore(recoveryDirectory);
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
        && html.includes("公众号 smoke")
        && html.includes("border-bottom:2px solid #2f8f63")
        && !/\b(?:file:|blob:|https?:\/\/localhost|fantastic-asset:)|<script\b|\son\w+\s*=/i.test(html);
      if (safe) clipboard.write({ html, text: "公众号 smoke\n\n正文 加粗。" });
      const clipboardValid = safe && clipboard.readHTML().includes("公众号 smoke");
      if (!clipboardValid) console.error(result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n") || "WeChat clipboard validation failed.");
      app.exit(clipboardValid ? 0 : 1);
    })().catch((error: unknown) => {
      console.error(error);
      app.exit(1);
    });
  } else if (process.env.FANTASTIC_EDITOR_PDF_SMOKE_TEST === "1") {
    void (async () => {
      const parsedDocument = await parseDocument({ documentId: "pdf-smoke-document", editorText: "# PDF smoke\n\n中文与公式：$x^2 + 1$。\n" });
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
        && result.bytes[3] === 0x46;
      if (!validPdf) console.error(result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n") || "PDF validation failed.");
      app.exit(validPdf ? 0 : 1);
    })().catch((error: unknown) => {
      console.error(error);
      app.exit(1);
    });
  } else if (process.env.FANTASTIC_EDITOR_DOCX_SMOKE_TEST === "1") {
    void (async () => {
      const parsedDocument = await parseDocument({ documentId: "docx-smoke-document", editorText: "# DOCX smoke\n\nUtility Process 真实生成验证。\n" });
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
      if (!validDocx) console.error(result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n") || "DOCX validation failed.");
      app.exit(validDocx ? 0 : 1);
    })().catch((error: unknown) => {
      console.error(error);
      app.exit(1);
    });
  } else if (process.env.FANTASTIC_EDITOR_FORMULA_SMOKE_TEST === "1") {
    void formulaRenderWindow.renderFormula("\\frac{1}{2} + \\sqrt{x^2+1}", true).then((result) => {
      const validPng = result.status === "completed"
        && result.png.byteLength > 8
        && result.png[0] === 0x89
        && result.png[1] === 0x50
        && result.width > 32
        && result.height > 32;
      if (!validPng) console.error(result.status === "failed" ? `${result.code}: ${result.message}` : "Formula PNG validation failed.");
      app.exit(validPng ? 0 : 1);
    }).catch((error: unknown) => {
      console.error(error);
      app.exit(1);
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
  pdfRenderWindow.dispose();
  nodeOutputProcess.dispose();
  imageTransformProcess.dispose();
  void fileSessions.dispose();
  if (process.env.FANTASTIC_EDITOR_UI_SMOKE_TEST === "1") void recoveryStore?.clear();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});








