import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type SyntheticEvent } from "react";
import { OFFICIAL_WECHAT_THEME_IDS, WECHAT_CUSTOM_THEME_ID_RE, WECHAT_THEME_OPTIONS, resolveOfficialWechatTheme, type OpenFileResult, type OpenFolderResult, type OutputCommandResult, type PersistRecoveryRequest, type PreviewDerivedUpdate, type PreviewSession, type RecentFileEntry, type ResolvedWechatTheme, type WechatApiConfigSummary, type WechatReplacementItem, type WechatThemeId, type WechatThemeListItem, type WechatThemeOverlayInput, type WorkspaceFileEntry } from "@fantastic-editor/shared";
import { Icon } from "./Icon";
import { MarkdownEditor, type MarkdownEditorHandle } from "./MarkdownEditor";
import { SynchronizedPreview, type SynchronizedPreviewHandle } from "./SynchronizedPreview";
import { applyResolutionToPreviewHtml } from "./preview-assets";
import { applyPreviewDerivedUpdate, createPreviewSession } from "./preview-session";
import { ParseWorkerClient } from "./workers/parse-worker-client";
import { WelcomeScreen } from "./WelcomeScreen";
import { DEFAULT_PREVIEW_FONT, PREVIEW_FONT_PRESETS, DEFAULT_PREVIEW_FONT_SIZE, DEFAULT_READING_WIDTH, READING_WIDTH_OPTIONS, commitPreviewFontDraft, normalizePreviewFontName, normalizePreviewFontSize, normalizeReadingWidth, previewFontStack, readingWidthMaxWidth, type ReadingWidth } from "./preview-font";
import { WysiwygEditor, type WysiwygEditorHandle } from "./WysiwygEditor";
import { computeWechatAcceptanceGates, createEmptyWechatAcceptance, updateWechatAcceptance, type WechatAcceptanceProgress } from "./wechat-acceptance";
import { WechatThemePreview } from "./WechatThemePreview";
import { WechatApiConfigDialog } from "./WechatApiConfigDialog";
import { clampSplitRatio, MAX_SPLIT_RATIO, MIN_SPLIT_RATIO, splitRatioForKey } from "./accessibility";
import { adjacentTabIndex, moveTabIndexForKey, moveTabItem, tabIndexForNavigationKey } from "./tab-navigation";
import { createDocumentPerformanceSnapshot, documentPerformanceDescription, documentPerformanceLabel, type DocumentPerformanceSnapshot } from "./document-performance";
import { extractDocumentOutline, type OutlineEntry } from "./document-outline";
import { DocumentOutline } from "./DocumentOutline";
import { clearVisibleTextSearch, type SearchNavigationResult } from "./visible-text-search";
import { repairWebMarkdown } from "./web-markdown-repair";

interface ActiveDocument {
  sessionId: string;
  documentId: string;
  displayName: string;
  savedText: string;
  workspaceRevision: number;
  workspaceFileId: string | null;
  isUntitled: boolean;
  requiresSave: boolean;
}

interface DocumentTab extends ActiveDocument {
  draft: string;
}

type RenameTarget =
  | { kind: "open"; sessionId: string }
  | { kind: "workspace"; workspaceId: string; fileId: string };

type ActiveWorkspace = NonNullable<OpenFolderResult["workspace"]>;

const EMPTY_DOCUMENT = "# fantastic-editor\n\n打开一个本地 Markdown 文件，开始编辑。\n";
const EMPTY_WECHAT_API_CONFIG: WechatApiConfigSummary = {
  appId: "",
  hasAppSecret: false,
  coverPath: "",
  coverDisplayName: null,
  configured: false,
  source: "none",
};

export function App() {
  const [active, setActive] = useState<ActiveDocument | null>(null);
  const [tabs, setTabs] = useState<DocumentTab[]>([]);
  const tabsRef = useRef<DocumentTab[]>([]);
  const [workspace, setWorkspace] = useState<ActiveWorkspace | null>(null);
  const [recentFiles, setRecentFiles] = useState<RecentFileEntry[]>([]);
  const [draft, setDraft] = useState(EMPTY_DOCUMENT);
  const draftRef = useRef(EMPTY_DOCUMENT);
  const [previewHtml, setPreviewHtml] = useState("<h1>fantastic-editor</h1><p>打开一个本地 Markdown 文件，开始编辑。</p>");
  const [previewHtmlReady, setPreviewHtmlReady] = useState(false);
  const parseWorkerRef = useRef<ParseWorkerClient | null>(null);
  const markdownEditorRef = useRef<MarkdownEditorHandle | null>(null);
  const wysiwygEditorRef = useRef<WysiwygEditorHandle | null>(null);
  const synchronizedPreviewRef = useRef<SynchronizedPreviewHandle | null>(null);
  const exportMenuSummaryRef = useRef<HTMLElement | null>(null);
  const wechatThemeButtonRef = useRef<HTMLButtonElement | null>(null);
  const draggedTabSessionIdRef = useRef<string | null>(null);
  const imageImportBusyRef = useRef(false);
  const activeDocumentIdRef = useRef<string | null>(null);
  const previewSessionRef = useRef<PreviewSession | null>(null);
  const basePreviewHtmlRef = useRef(previewHtml);
  const pendingDerivedUpdateRef = useRef<PreviewDerivedUpdate | null>(null);
  const imageRefreshAttemptsRef = useRef(new Map<string, { count: number; firstAt: number }>());
  const [previewRefreshVersion, setPreviewRefreshVersion] = useState(0);
  const [outputReady, setOutputReady] = useState(false);
  const [outputBusy, setOutputBusy] = useState(false);
  const [imageImportBusy, setImageImportBusy] = useState(false);
  const [wechatReplacements, setWechatReplacements] = useState<{ jobId: string; items: WechatReplacementItem[]; omittedCount: number; themeId: WechatThemeId; suggestedTitle?: string } | null>(null);
  const [copiedReplacementIds, setCopiedReplacementIds] = useState<Set<string>>(new Set());
  const [confirmedReplacementIds, setConfirmedReplacementIds] = useState<Set<string>>(new Set());
  const [wechatAcceptance, setWechatAcceptance] = useState<WechatAcceptanceProgress>(() => createEmptyWechatAcceptance());
  const wechatAcceptanceGates = useMemo(
    () => computeWechatAcceptanceGates(wechatAcceptance, wechatReplacements?.items.length ?? 0, confirmedReplacementIds.size),
    [confirmedReplacementIds, wechatAcceptance, wechatReplacements],
  );
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [status, setStatus] = useState("准备就绪");
  const [previewRetryAvailable, setPreviewRetryAvailable] = useState(false);
  const [documentPerformance, setDocumentPerformance] = useState<DocumentPerformanceSnapshot | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [viewMode, setViewMode] = useState<"editor" | "split" | "preview">(() => window.localStorage.getItem("fantastic-editor-editor-mode") === "wysiwyg" ? "editor" : "split");
  const [editorMode, setEditorMode] = useState<"source" | "wysiwyg">(() => window.localStorage.getItem("fantastic-editor-editor-mode") === "wysiwyg" ? "wysiwyg" : "source");
  const previousSourceViewModeRef = useRef<"editor" | "split" | "preview">("split");
  const [splitRatio, setSplitRatio] = useState(50);
  const [darkMode, setDarkMode] = useState(() => window.localStorage.getItem("fantastic-editor-theme") === "dark");
  const [syncScrollEnabled, setSyncScrollEnabled] = useState(() => window.localStorage.getItem("fantastic-editor-sync-scroll") === "true");
  const [previewFontName, setPreviewFontName] = useState(() => normalizePreviewFontName(window.localStorage.getItem("fantastic-editor-preview-font") ?? DEFAULT_PREVIEW_FONT));
  const [previewFontDraft, setPreviewFontDraft] = useState(previewFontName);
  const [readingWidth, setReadingWidth] = useState<ReadingWidth>(() => normalizeReadingWidth(window.localStorage.getItem("fantastic-editor-reading-width") ?? DEFAULT_READING_WIDTH));
  const [previewFontSize, setPreviewFontSize] = useState(() => normalizePreviewFontSize(window.localStorage.getItem("fantastic-editor-preview-font-size") ?? DEFAULT_PREVIEW_FONT_SIZE));
  const [outlineDocument, setOutlineDocument] = useState<PreviewSession["parsedDocument"] | null>(null);
  const [expandedOutlineSessionId, setExpandedOutlineSessionId] = useState<string | null>(null);
  const [sidebarPanel, setSidebarPanel] = useState<"explorer" | "outline">("explorer");
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchReplaceOpen, setSearchReplaceOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [searchResult, setSearchResult] = useState<SearchNavigationResult>({ index: 0, total: 0 });
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchIndexRef = useRef(-1);
  const [wechatThemeId, setWechatThemeId] = useState<WechatThemeId>(() => {
    const stored = window.localStorage.getItem("fantastic-editor-wechat-theme");
    return stored && ((OFFICIAL_WECHAT_THEME_IDS as readonly string[]).includes(stored) || WECHAT_CUSTOM_THEME_ID_RE.test(stored)) ? stored as WechatThemeId : "wechat-native-enhanced";
  });
  const [wechatThemes, setWechatThemes] = useState<WechatThemeListItem[]>(() => WECHAT_THEME_OPTIONS.map((theme) => ({ id: theme.id, name: theme.name, baseThemeId: theme.id, source: "official" })));
  const [wechatThemeResolved, setWechatThemeResolved] = useState<ResolvedWechatTheme>(() => {
    const definition = resolveOfficialWechatTheme("wechat-native-enhanced");
    return { id: definition.id, name: "微信原生增强", source: "official", baseThemeId: definition.baseThemeId, tokens: { ...definition.tokens }, definition };
  });
  const [wechatThemeSaveOpen, setWechatThemeSaveOpen] = useState(false);
  const [wechatThemePreviewOpen, setWechatThemePreviewOpen] = useState(false);
  const [wechatThemeInWysiwyg, setWechatThemeInWysiwyg] = useState(() => window.localStorage.getItem("fantastic-editor-wechat-theme-wysiwyg") === "true");
  const [wechatApiConfig, setWechatApiConfig] = useState<WechatApiConfigSummary>(EMPTY_WECHAT_API_CONFIG);
  const [wechatApiConfigOpen, setWechatApiConfigOpen] = useState(false);
  const [wechatDraftFeedback, setWechatDraftFeedback] = useState<{ kind: "working" | "success" | "error"; message: string } | null>(null);
  const [previewSyncIdentity, setPreviewSyncIdentity] = useState<string | null>(null);
  const [recoveryReady, setRecoveryReady] = useState(false);
  const recoveryReadyRef = useRef(false);
  const recoveryWaitersRef = useRef<Array<() => void>>([]);
  const recoveryPromiseRef = useRef<ReturnType<typeof window.fantasticEditor.restoreRecoverySession> | null>(null);
  const recoveryWriteInFlightRef = useRef(false);
  const pendingRecoveryRef = useRef<PersistRecoveryRequest | null>(null);
  const updateTabs = useCallback((updater: (current: DocumentTab[]) => DocumentTab[]) => {
    setTabs((current) => {
      const next = updater(current);
      tabsRef.current = next;
      return next;
    });
  }, []);
  const waitForRecoveryReady = useCallback(() => recoveryReadyRef.current
    ? Promise.resolve()
    : new Promise<void>((resolve) => recoveryWaitersRef.current.push(resolve)), []);
  const markRecoveryReady = useCallback(() => {
    if (recoveryReadyRef.current) return;
    recoveryReadyRef.current = true;
    setRecoveryReady(true);
    for (const resolve of recoveryWaitersRef.current.splice(0)) resolve();
  }, []);
  const refreshRecentFiles = useCallback(() => {
    void window.fantasticEditor.listRecentFiles().then((result) => {
      if (result.status === "listed") setRecentFiles(result.items);
    });
  }, []);
  const refreshWechatApiConfig = useCallback(() => {
    void window.fantasticEditor.getWechatApiConfig().then((result) => {
      if (result.status === "loaded") setWechatApiConfig(result.config);
    });
  }, []);
  const closeWechatApiConfig = useCallback(() => setWechatApiConfigOpen(false), []);
  const applySavedWechatApiConfig = useCallback((config: WechatApiConfigSummary) => {
    setWechatApiConfig(config);
    const message = config.configured ? "公众号 API 配置已安全保存，可以同步草稿。" : "公众号 API 配置已清除。";
    setWechatDraftFeedback({ kind: config.configured ? "success" : "error", message });
    setStatus(message);
  }, []);

  useEffect(() => { refreshRecentFiles(); }, [refreshRecentFiles]);
  useEffect(() => { refreshWechatApiConfig(); }, [refreshWechatApiConfig]);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void window.fantasticEditor.listWechatThemes({ documentId: active.documentId }).then((result) => {
      if (cancelled) return;
      if (result.status === "listed") {
        setWechatThemes(result.themes);
        if (!result.themes.some((theme) => theme.id === wechatThemeId)) {
          setWechatThemeId("wechat-native-enhanced");
        }
      } else {
        setStatus(result.error);
      }
    }).catch((error: unknown) => { if (!cancelled) setStatus(error instanceof Error ? error.message : "读取公众号主题失败。"); });
    return () => { cancelled = true; };
  }, [active?.documentId]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void window.fantasticEditor.resolveWechatThemeForPreview({ documentId: active.documentId, themeId: wechatThemeId }).then((result) => {
      if (cancelled) return;
      if (result.status === "resolved") setWechatThemeResolved(result.theme);
      else setStatus(result.error);
    }).catch((error: unknown) => { if (!cancelled) setStatus(error instanceof Error ? error.message : "解析公众号主题失败。"); });
    return () => { cancelled = true; };
  }, [active?.documentId, wechatThemeId]);

  const saveWechatThemeAsCustom = useCallback(async (input: WechatThemeOverlayInput) => {
    if (!active) return false;
    setWechatThemeSaveOpen(true);
    try {
      const result = await window.fantasticEditor.saveWechatThemeAsCustom({
        documentId: active.documentId,
        input,
      });
      if (result.status === "saved") {
        setWechatThemeResolved(result.theme);
        setWechatThemeId(result.theme.id as WechatThemeId);
        const listed = await window.fantasticEditor.listWechatThemes({ documentId: active.documentId });
        if (listed.status === "listed") setWechatThemes(listed.themes);
        setStatus(`已保存自定义主题“${result.theme.name}”。`);
        return true;
      }
      setStatus(result.error);
      return false;
    } catch (error: unknown) {
      setStatus(error instanceof Error ? error.message : "保存自定义主题失败。");
      return false;
    } finally {
      setWechatThemeSaveOpen(false);
    }
  }, [active]);

  const deleteWechatTheme = useCallback(async (themeId: string): Promise<boolean> => {
    if (!active) return false;
    const target = wechatThemes.find((theme) => theme.id === themeId);
    if (!target || target.source === "official") return false;
    const nextThemeId = themeId === wechatThemeId ? target.baseThemeId : wechatThemeId;
    try {
      const result = await window.fantasticEditor.deleteWechatTheme({ documentId: active.documentId, themeId, currentThemeId: nextThemeId });
      if (result.status !== "deleted") {
        setStatus(result.error);
        return false;
      }
      setWechatThemes((current) => current.filter((theme) => theme.id !== themeId));
      if (themeId === wechatThemeId) setWechatThemeId(target.baseThemeId);
      setStatus(themeId === wechatThemeId ? `自定义主题已删除，已切回“${WECHAT_THEME_OPTIONS.find((theme) => theme.id === target.baseThemeId)?.name ?? target.baseThemeId}”。` : "自定义主题已删除。");
      return true;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "删除自定义主题失败。");
      return false;
    }
  }, [active, wechatThemeId, wechatThemes]);

  const exportWechatTheme = useCallback(async () => {
    if (!active || wechatThemeResolved.source === "official") return;
    const result = await window.fantasticEditor.exportWechatTheme({ documentId: active.documentId, themeId: wechatThemeResolved.id });
    if (result.status === "exported") setStatus(`已导出自定义主题“${result.file.name}”。`);
    else if (result.status === "failed") setStatus(result.error);
  }, [active, wechatThemeResolved]);

  const importWechatTheme = useCallback(async (storage: "workspace" | "global") => {
    if (!active) return;
    const result = await window.fantasticEditor.importWechatTheme({ documentId: active.documentId, storage });
    if (result.status === "imported") {
      setWechatThemeResolved(result.theme);
      setWechatThemeId(result.theme.id as WechatThemeId);
      const listed = await window.fantasticEditor.listWechatThemes({ documentId: active.documentId });
      if (listed.status === "listed") setWechatThemes(listed.themes);
      setStatus(`已导入并选中自定义主题“${result.theme.name}”。`);
    } else if (result.status === "failed") setStatus(result.error);
  }, [active]);
  const applyDraftChange = useCallback((value: string) => {
    draftRef.current = value;
    setOutputReady(false);
    setPreviewSyncIdentity(null);
    setPreviewHtmlReady(false);
    setDocumentPerformance(null);
    synchronizedPreviewRef.current?.clearTransientState();
    setWechatReplacements(null);
    setCopiedReplacementIds(new Set());
    setConfirmedReplacementIds(new Set());
    setWechatAcceptance(createEmptyWechatAcceptance());
    setDraft(value);
    if (active) updateTabs((current) => current.map((tab) => tab.sessionId === active.sessionId ? { ...tab, draft: value } : tab));
  }, [active?.sessionId, updateTabs]);
  const dirty = active ? active.requiresSave || draft !== active.savedText : false;
  const queueRecoverySnapshot = useCallback((request: PersistRecoveryRequest) => {
    pendingRecoveryRef.current = request;
    if (recoveryWriteInFlightRef.current) return;
    recoveryWriteInFlightRef.current = true;
    void (async () => {
      try {
        while (pendingRecoveryRef.current) {
          const next = pendingRecoveryRef.current;
          pendingRecoveryRef.current = null;
          try {
            const result = await window.fantasticEditor.persistRecoverySession(next);
            if (result.status === "failed") setStatus(`自动恢复快照未保存：${result.error}`);
          } catch (error: unknown) {
            setStatus(error instanceof Error ? `自动恢复快照未保存：${error.message}` : "自动恢复快照未保存。");
          }
        }
      } finally {
        recoveryWriteInFlightRef.current = false;
      }
    })();
  }, []);

  useEffect(() => {
    window.localStorage.setItem("fantastic-editor-theme", darkMode ? "dark" : "light");
  }, [darkMode]);

  useEffect(() => {
    window.localStorage.setItem("fantastic-editor-sync-scroll", String(syncScrollEnabled));
  }, [syncScrollEnabled]);

  useEffect(() => {
    window.localStorage.setItem("fantastic-editor-editor-mode", editorMode);
  }, [editorMode]);

  useEffect(() => {
    window.localStorage.setItem("fantastic-editor-preview-font", previewFontName);
    setPreviewFontDraft(previewFontName);
  }, [previewFontName]);

  useEffect(() => { window.localStorage.setItem("fantastic-editor-reading-width", readingWidth); }, [readingWidth]);
  useEffect(() => { window.localStorage.setItem("fantastic-editor-preview-font-size", String(previewFontSize)); }, [previewFontSize]);

  useEffect(() => {
    window.localStorage.setItem("fantastic-editor-wechat-theme", wechatThemeId);
  }, [wechatThemeId]);

  useEffect(() => {
    window.localStorage.setItem("fantastic-editor-wechat-theme-wysiwyg", String(wechatThemeInWysiwyg));
  }, [wechatThemeInWysiwyg]);

  useEffect(() => {
    const acceptDerivedUpdate = (update: PreviewDerivedUpdate): boolean => {
      const current = previewSessionRef.current;
      if (!current) return false;
      const merged = applyPreviewDerivedUpdate(current, update);
      if (merged.status !== "accepted") return false;
      previewSessionRef.current = merged.session;
      setPreviewHtml(applyResolutionToPreviewHtml(basePreviewHtmlRef.current, merged.session));
      setDiagnostics(merged.session.diagnostics.map((item) => `${item.code}: ${item.message}`));
      setStatus(Object.keys(update.entries).length > 0
        ? "SVG 安全转换完成，预览已更新"
        : "SVG 安全转换未完成，请查看诊断信息");
      return true;
    };
    const unsubscribeDerivedUpdates = window.fantasticEditor.onPreviewDerivedUpdate((update) => {
      if (acceptDerivedUpdate(update)) return;
      const pending = pendingDerivedUpdateRef.current;
      if (!pending || update.manifestRevision > pending.manifestRevision) pendingDerivedUpdateRef.current = update;
    });
    const client = new ParseWorkerClient({
      onResult: (response) => {
        if (response.type === "parse-failed") {
          setPreviewSyncIdentity(null);
          setOutputReady(false);
          setPreviewRetryAvailable(true);
          setDocumentPerformance(null);
          setStatus(response.error);
          return;
        }
        setPreviewRetryAvailable(false);
        if (activeDocumentIdRef.current !== response.documentId) return;
        previewSessionRef.current = null;
        setOutputReady(false);
        basePreviewHtmlRef.current = response.previewHtml;
        setPreviewHtml(response.previewHtml);
        setPreviewHtmlReady(true);
        const parseDiagnostics = response.diagnostics.map((item) => `${item.code}: ${item.message}`);
        setDiagnostics(parseDiagnostics);
        setPreviewSyncIdentity(`${response.documentId}:${response.sourceHash}:${response.parserProfile}:${response.taskSequence}`);
        void (async () => {
          const commit = await window.fantasticEditor.commitParse({
            documentId: response.documentId,
            sourceHash: response.sourceHash,
            parserProfile: response.parserProfile,
            taskSequence: response.taskSequence,
          });
          if (!client.isCurrent(response)) return;
          if (commit.status !== "committed" || !commit.parseCommitId || commit.workspaceRevision === undefined) {
            setPreviewRetryAvailable(true);
            setStatus(commit.error ?? "主进程拒绝了当前解析版本。");
            return;
          }
          const resolveStartedAt = performance.now();
          const resolved = await window.fantasticEditor.resolveResources({
            documentId: response.documentId,
            sourceHash: response.sourceHash,
            parserProfile: response.parserProfile,
            taskSequence: response.taskSequence,
            parseCommitId: commit.parseCommitId,
            workspaceRevision: commit.workspaceRevision,
            resourceReferences: response.parsedDocument.resourceReferences,
          });
          if (!client.isCurrent(response)) return;
          const resolveDurationMs = performance.now() - resolveStartedAt;
          const combined = createPreviewSession(response, resolved);
          if (combined.status !== "accepted") {
            setPreviewRetryAvailable(true);
            setStatus(combined.error);
            return;
          }
          let session = combined.session;
          const pendingUpdate = pendingDerivedUpdateRef.current;
          if (pendingUpdate) {
            const merged = applyPreviewDerivedUpdate(session, pendingUpdate);
            if (merged.status === "accepted") session = merged.session;
            pendingDerivedUpdateRef.current = null;
          }
          previewSessionRef.current = session;
          setOutlineDocument(session.parsedDocument);
          setOutputReady(true);
          setPreviewRetryAvailable(false);
          setPreviewHtml(applyResolutionToPreviewHtml(response.previewHtml, session));
          setDiagnostics(session.diagnostics.map((item) => `${item.code}: ${item.message}`));
          setDocumentPerformance(createDocumentPerformanceSnapshot({
            characterCount: response.parsedDocument.sourceLength,
            resourceCount: response.parsedDocument.resourceReferences.length,
            parseDurationMs: response.parseDurationMs,
            resolveDurationMs,
          }));
          const records = Object.values(session.resolutionSnapshot.records);
          const ready = records.filter((item) => {
            if (item.state !== "resolved") return false;
            if (item.mimeType !== "image/svg+xml") return true;
            return Boolean(session.previewDerivedManifest.entries[item.referenceKey]);
          }).length;
          const pending = records.filter((item) =>
            item.state === "resolved"
            && item.mimeType === "image/svg+xml"
            && !session.previewDerivedManifest.entries[item.referenceKey],
          ).length;
          setStatus(records.length === 0
            ? "文档解析完成"
            : `资源预览：${ready}/${records.length} 可用${pending > 0 ? `，${pending} 项等待安全转换` : ""}`);
        })().catch((error: unknown) => {
          if (client.isCurrent(response)) {
            setPreviewRetryAvailable(true);
            setStatus(error instanceof Error ? error.message : "资源解析失败。");
          }
        });
      },
      onWorkerError: (message) => {
        setPreviewRetryAvailable(true);
        setStatus(message);
      },
    });
    parseWorkerRef.current = client;
    return () => {
      unsubscribeDerivedUpdates();
      parseWorkerRef.current = null;
      client.dispose();
    };
  }, []);

  useEffect(() => {
    setOutputReady(false);
    setDocumentPerformance(null);
    setPreviewRetryAvailable(false);
    setPreviewSyncIdentity(null);
    setPreviewHtmlReady(false);
    setOutlineDocument(null);
    searchIndexRef.current = -1;
    synchronizedPreviewRef.current?.clearTransientState();
    parseWorkerRef.current?.invalidate();
    const parseDelayMs = draft.length >= 1_000_000 ? 500 : draft.length >= 250_000 ? 300 : 180;
    const timer = window.setTimeout(() => {
      void parseWorkerRef.current?.parse(active?.documentId ?? "welcome-document", draft).catch((error: unknown) => {
        setPreviewRetryAvailable(true);
        setStatus(error instanceof Error ? error.message : "无法启动解析任务。");
      });
    }, parseDelayMs);
    return () => window.clearTimeout(timer);
  }, [active?.documentId, active?.workspaceRevision, draft, previewRefreshVersion]);

  const acceptOpenedFile = useCallback((result: OpenFileResult, workspaceFileId: string | null = null) => {
    if (result.status === "cancelled") return;
    if (result.status === "failed" || !result.session) {
      setStatus(result.error ?? "打开文件失败");
      return;
    }
    const cached = tabsRef.current.find((tab) => tab.sessionId === result.session!.sessionId);
    const nextActive: ActiveDocument = cached
      ? { sessionId: cached.sessionId, documentId: cached.documentId, displayName: cached.displayName, savedText: cached.savedText, workspaceRevision: cached.workspaceRevision, workspaceFileId: cached.workspaceFileId, isUntitled: cached.isUntitled, requiresSave: cached.requiresSave }
      : {
          sessionId: result.session.sessionId,
          documentId: result.session.documentId,
          displayName: result.session.displayName,
          savedText: result.session.savedText ?? result.session.editorText,
          workspaceRevision: result.session.workspaceRevision,
          workspaceFileId,
          isUntitled: result.session.isUntitled,
          requiresSave: result.session.requiresSave ?? false,
        };
    if (!cached) updateTabs((current) => [...current, { ...nextActive, draft: result.session!.editorText }]);
    activeDocumentIdRef.current = nextActive.documentId;
    previewSessionRef.current = null;
    setOutlineDocument(null);
    setOutputReady(false);
    setWechatReplacements(null);
    setCopiedReplacementIds(new Set());
    setConfirmedReplacementIds(new Set());
    setWechatAcceptance(createEmptyWechatAcceptance());
    pendingDerivedUpdateRef.current = null;
    imageRefreshAttemptsRef.current.clear();
    setActive(nextActive);
    draftRef.current = cached?.draft ?? result.session.editorText;
    setDraft(draftRef.current);
    setStatus(result.session.isUntitled
      ? "已新建空白文档；保存时请选择文件名"
      : result.session.requiresSave
        ? `已转换 ${result.session.displayName}；首次保存将写入确认后的 UTF-8 与换行格式`
        : `已打开 ${result.session.displayName}`);
    refreshRecentFiles();
  }, [refreshRecentFiles, updateTabs]);

  const openRecentFile = useCallback(async (recentId: string) => {
    const result = await window.fantasticEditor.openRecentFile({ recentId });
    acceptOpenedFile(result);
    refreshRecentFiles();
  }, [acceptOpenedFile, refreshRecentFiles]);

  const newFile = useCallback(async () => {
    await waitForRecoveryReady();
    const result = await window.fantasticEditor.createUntitledFile();
    if (result.status === "opened") setWorkspace(null);
    acceptOpenedFile(result);
  }, [acceptOpenedFile, waitForRecoveryReady]);

  const openFile = useCallback(async () => {
    await waitForRecoveryReady();
    const result = await window.fantasticEditor.openMarkdownFile();
    if (result.status === "opened") setWorkspace(null);
    acceptOpenedFile(result);
  }, [acceptOpenedFile, waitForRecoveryReady]);

  const selectWorkspaceFile = useCallback(async (
    targetWorkspace: ActiveWorkspace,
    file: WorkspaceFileEntry,
    confirmDirty = true,
  ) => {
    if (active?.workspaceFileId === file.fileId && active.sessionId) {
      setExpandedOutlineSessionId((current) => current === active.sessionId ? null : active.sessionId);
      return;
    }
    if (confirmDirty && dirty && !window.confirm("当前修改尚未保存，仍要切换文件吗？")) return;
    const result = await window.fantasticEditor.openWorkspaceFile({
      workspaceId: targetWorkspace.workspaceId,
      workspaceRevision: targetWorkspace.workspaceRevision,
      fileId: file.fileId,
    });
    if (result.status === "opened") {
      updateTabs(() => []);
      setActive(null);
      setExpandedOutlineSessionId(result.session?.sessionId ?? null);
    }
    acceptOpenedFile(result, file.fileId);
  }, [acceptOpenedFile, active?.sessionId, active?.workspaceFileId, dirty, updateTabs]);

  const renameWorkspaceFile = useCallback(async (targetWorkspace: ActiveWorkspace, file: WorkspaceFileEntry, newName: string) => {
    const result = await window.fantasticEditor.renameWorkspaceFile({
      workspaceId: targetWorkspace.workspaceId,
      workspaceRevision: targetWorkspace.workspaceRevision,
      fileId: file.fileId,
      newName,
    });
    if (result.status !== "renamed") {
      setStatus(result.error);
      return;
    }
    setWorkspace((current) => current && current.workspaceId === targetWorkspace.workspaceId
      ? { ...current, workspaceRevision: result.workspaceRevision, files: current.files.map((item) => item.fileId === result.file.fileId ? result.file : item) }
      : current);
    updateTabs((current) => current.map((tab) => tab.workspaceFileId === result.file.fileId
      ? { ...tab, displayName: result.file.displayName, workspaceRevision: result.workspaceRevision }
      : tab));
    setActive((current) => current && current.workspaceFileId === result.file.fileId
      ? { ...current, displayName: result.file.displayName, workspaceRevision: result.workspaceRevision }
      : current);
    setStatus(`已重命名为 ${result.file.displayName}`);
  }, [updateTabs]);

  const renameOpenFile = useCallback(async (tab: DocumentTab, newName: string) => {
    if (tab.isUntitled) {
      setStatus("未命名文档请先保存，再右键重命名。");
      return;
    }
    const result = await window.fantasticEditor.renameOpenFile({ sessionId: tab.sessionId, newName });
    if (result.status !== "renamed") {
      setStatus(result.error);
      return;
    }
    updateTabs((current) => current.map((item) => item.sessionId === tab.sessionId
      ? { ...item, displayName: result.displayName, workspaceRevision: result.workspaceRevision }
      : item));
    setActive((current) => current?.sessionId === tab.sessionId
      ? { ...current, displayName: result.displayName, workspaceRevision: result.workspaceRevision }
      : current);
    if (result.file) {
      setWorkspace((current) => current
        ? { ...current, workspaceRevision: result.workspaceRevision, files: current.files.map((item) => item.fileId === result.file!.fileId ? result.file! : item) }
        : current);
    }
    setStatus(`已重命名为 ${result.displayName}`);
  }, [updateTabs]);

  const beginRenameOpenFile = useCallback((tab: DocumentTab) => {
    if (tab.isUntitled) {
      setStatus("未命名文档请先保存，再右键重命名。");
      return;
    }
    setRenameTarget({ kind: "open", sessionId: tab.sessionId });
    setRenameValue(tab.displayName);
  }, []);

  const beginRenameWorkspaceFile = useCallback((targetWorkspace: ActiveWorkspace, file: WorkspaceFileEntry) => {
    setRenameTarget({ kind: "workspace", workspaceId: targetWorkspace.workspaceId, fileId: file.fileId });
    setRenameValue(file.relativePath.split("/").at(-1) ?? file.displayName);
  }, []);

  const cancelRename = useCallback(() => {
    setRenameTarget(null);
    setRenameValue("");
  }, []);

  const submitRename = useCallback(async () => {
    const target = renameTarget;
    const value = renameValue;
    if (!target) return;
    if (!value.trim()) {
      setStatus("文件名不能为空。");
      renameInputRef.current?.focus();
      return;
    }
    cancelRename();
    if (target.kind === "open") {
      const tab = tabsRef.current.find((item) => item.sessionId === target.sessionId);
      if (tab) await renameOpenFile(tab, value);
      return;
    }
    const targetWorkspace = workspace && workspace.workspaceId === target.workspaceId ? workspace : null;
    const file = targetWorkspace?.files.find((item) => item.fileId === target.fileId);
    if (targetWorkspace && file) await renameWorkspaceFile(targetWorkspace, file, value);
  }, [cancelRename, renameOpenFile, renameTarget, renameValue, renameWorkspaceFile, workspace]);

  useEffect(() => {
    if (renameTarget) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renameTarget]);

  const openFolder = useCallback(async () => {
    await waitForRecoveryReady();
    if (dirty && !window.confirm("当前修改尚未保存，仍要打开其他工作区吗？")) return;
    const result = await window.fantasticEditor.openWorkspaceFolder();
    if (result.status === "cancelled") return;
    if (result.status === "failed" || !result.workspace) {
      setStatus(result.error ?? "打开工作区失败");
      return;
    }
    updateTabs(() => []);
    setActive(null);
    setWorkspace(result.workspace);
    setDiagnostics(result.workspace.warnings);
    const firstFile = result.workspace.files[0];
    if (firstFile) {
      await selectWorkspaceFile(result.workspace, firstFile, false);
      return;
    }
    activeDocumentIdRef.current = null;
    previewSessionRef.current = null;
    setOutputReady(false);
    setActive(null);
    draftRef.current = EMPTY_DOCUMENT;
    setDraft(EMPTY_DOCUMENT);
    setStatus(`工作区 ${result.workspace.displayName} 中没有 Markdown 文件`);
  }, [dirty, selectWorkspaceFile, updateTabs, waitForRecoveryReady]);

  const commitPendingEditor = useCallback((): boolean => {
    if (editorMode !== "wysiwyg") return true;
    const committed = wysiwygEditorRef.current?.commitPending() ?? true;
    if (!committed) setStatus("所见即所得修改基于旧文档版本，未执行保存或切换。");
    return committed;
  }, [editorMode]);

  const repairCurrentWebMarkdown = useCallback(() => {
    if (!active) {
      setStatus("请先新建或打开一个 Markdown 文件。");
      return;
    }
    if (!commitPendingEditor()) return;
    const source = draftRef.current;
    const repaired = repairWebMarkdown(source);
    if (!repaired.changed) {
      setStatus("未检测到可安全修复的网页 Markdown 结构。");
      return;
    }
    const summary = [
      `结构标记 ${repaired.repairedMarkers} 处`,
      `成对行内格式 ${repaired.repairedInlinePairs} 处`,
      `多余空行 ${repaired.removedBlankLines} 处`,
      `表格断行 ${repaired.repairedTableGaps} 处`,
    ].join("、");
    if (!window.confirm(`检测到网页复制产生的 Markdown 转义。\n\n将修复：${summary}。\n代码块内部、路径和普通反斜杠不会改动。是否继续？`)) return;
    const next = markdownEditorRef.current?.applyTextChange({
      from: 0,
      to: source.length,
      insert: repaired.markdown,
      expectedText: source,
    }) ?? null;
    setStatus(next === null ? "网页 Markdown 修复未执行：文档版本已经变化。" : `网页 Markdown 已修复：${summary}；可用一次撤销恢复。`);
  }, [active, commitPendingEditor]);

  const saveAs = useCallback(async (): Promise<ActiveDocument | null> => {
    if (!active) { setStatus("请先新建或打开一个 Markdown 文件"); return null; }
    if (!commitPendingEditor()) return null;
    const editorText = draftRef.current;
    const result = await window.fantasticEditor.saveCurrentFileAs({ sessionId: active.sessionId, editorText });
    if (result.status === "saved") {
      const next: ActiveDocument = {
        ...active,
        displayName: result.displayName ?? active.displayName,
        savedText: editorText,
        workspaceRevision: result.workspaceRevision ?? active.workspaceRevision,
        workspaceFileId: result.workspaceMode === "single-file" ? null : active.workspaceFileId,
        isUntitled: false,
        requiresSave: false,
      };
      setActive(next);
      updateTabs((current) => current.map((tab) => tab.sessionId === active.sessionId ? { ...tab, ...next, draft: editorText } : tab));
      if (result.workspaceMode === "single-file") setWorkspace(null);
      setStatus(`已另存为 ${next.displayName}`);
      return next;
    }
    if (result.status !== "cancelled") setStatus(result.error ?? "另存为未完成");
    return null;
  }, [active, commitPendingEditor, updateTabs]);

  const save = useCallback(async () => {
    if (!active) { setStatus("请先新建或打开一个 Markdown 文件"); return; }
    if (active.isUntitled) { await saveAs(); return; }
    if (!commitPendingEditor()) return;
    const editorText = draftRef.current;
    const result = await window.fantasticEditor.saveCurrentFile({ sessionId: active.sessionId, editorText });
    if (result.status === "saved") {
      const next = { ...active, savedText: editorText, requiresSave: false, workspaceRevision: result.workspaceRevision ?? active.workspaceRevision };
      setActive(next);
      updateTabs((current) => current.map((tab) => tab.sessionId === active.sessionId ? { ...tab, ...next, draft: editorText } : tab));
      setStatus(`已保存 ${result.displayName ?? active.displayName}`);
    } else setStatus(result.error ?? "保存未完成");
  }, [active, commitPendingEditor, saveAs, updateTabs]);

  const describeOutputResult = useCallback((result: OutputCommandResult) => {
    if (
      (result.status === "completed" || result.status === "completed-with-omissions")
      && result.result?.target === "wechat-clipboard"
    ) {
      const omittedCount = result.result.omittedReferenceKeys.length;
      setWechatReplacements({
        jobId: result.result.jobId,
        items: result.result.wechatReplacementItems ?? [],
        omittedCount,
        themeId: result.result.wechatThemeId ?? "wechat-native-enhanced",
        ...(result.result.wechatSuggestedTitle ? { suggestedTitle: result.result.wechatSuggestedTitle } : {}),
      });
      setCopiedReplacementIds(new Set());
      setConfirmedReplacementIds(new Set());
      setWechatAcceptance(createEmptyWechatAcceptance());
      setStatus(omittedCount > 0
        ? `公众号正文已复制，但已批准省略 ${omittedCount} 项；这是部分完成，请按验收助手逐项复核。`
        : "公众号正文与短占位标记已复制（方案 B）；请完整选中标记文字后粘贴对应图片，且不要再套用公众号一键排版。当前结果不代表已发布。");
      return;
    }
    if (result.status === "completed") {
      setStatus(`导出完成：${result.result?.artifact?.displayName ?? "导出文件"}`);
      return;
    }
    if (result.status === "completed-with-omissions") {
      const count = result.result?.omittedReferenceKeys.length ?? 0;
      setStatus(`导出完成（已批准省略 ${count} 项），这不是完整成功。`);
      return;
    }
    if (result.status === "cancelled") {
      setStatus("已取消导出，未写入目标文件。");
      return;
    }
    if (result.status === "timed-out") {
      setStatus("导出超时，迟到结果将被丢弃。");
      return;
    }
    if (result.status === "failed" && result.preflight?.status === "failed") {
      const diagnostics = result.preflight.diagnostics;
      const blocking = diagnostics.find((item) => item.severity === "blocking");
      setStatus(blocking ? `导出预检失败：${blocking.message}` : (result.error ?? "导出预检失败，请查看诊断信息。"));
      if (diagnostics.length > 0) setDiagnostics(diagnostics.map((item) => `${item.code}: ${item.message}`));
      return;
    }
    setStatus(result.error ?? "导出失败，请查看诊断信息。");
    if (result.result?.diagnostics.length) {
      setDiagnostics(result.result.diagnostics.map((item) => `${item.code}: ${item.message}`));
    }
  }, []);

  const exportDocument = useCallback(async (target: "offline-html" | "docx" | "pdf" | "wechat-clipboard") => {
    const beforeCommitText = draftRef.current;
    if (!commitPendingEditor()) return;
    if (draftRef.current !== beforeCommitText) {
      setStatus("可视修改已写回 Markdown，正在重新解析；完成后请再次导出。");
      return;
    }
    const session = previewSessionRef.current;
    if (!active || !outputReady || !session) {
      setStatus("当前草稿尚未完成解析和资源解析，请稍候再导出。");
      return;
    }
    setOutputBusy(true);
    setStatus(target === "docx" ? "正在预检 Word 导出……" : target === "pdf" ? "正在预检 PDF 导出……" : target === "wechat-clipboard" ? "正在检查公众号兼容性并生成方案 B 占位……" : "正在预检离线 HTML 导出……");
    try {
      let result = await window.fantasticEditor.beginOutput({
        documentId: session.documentId,
        target,
        sourceHash: session.sourceHash,
        parserProfile: session.previewDerivedManifest.parserProfile,
        taskSequence: session.previewDerivedManifest.taskSequence,
        parseCommitId: session.previewDerivedManifest.parseCommitId,
        workspaceRevision: session.workspaceRevision,
        parsedDocument: session.parsedDocument,
        fontFamily: previewFontName,
        darkMode,
        ...(target === "wechat-clipboard" ? { wechatThemeId } : {}),
      });
      if (result.status === "approval-required") {
        const job = result.job;
        const preflight = result.preflight;
        if (!job?.preflightId || !preflight) {
          setStatus("导出预检返回了不完整的批准身份，任务已拒绝。");
          return;
        }
        const candidates = preflight.candidateOmittedReferenceKeys;
        const detail = preflight.diagnostics
          .filter((item) => item.referenceKey && candidates.includes(item.referenceKey))
          .slice(0, 6)
          .map((item) => `• ${item.message}`)
          .join("\n");
        const confirmed = window.confirm(
          `发现 ${candidates.length} 项无法导出的资源。继续将只在本次任务中批准省略这些项目，结果会明确标记为“部分完成”。`
          + (detail ? `\n\n${detail}` : "")
          + "\n\n是否继续？",
        );
        if (!confirmed) {
          result = await window.fantasticEditor.cancelOutput({ jobId: job.jobId });
        } else {
          result = await window.fantasticEditor.approveOutputOmissions({
            preflightId: job.preflightId,
            jobId: job.jobId,
            documentId: job.documentId,
            sourceHash: job.sourceHash,
            workspaceRevision: job.workspaceRevision,
            approvedOmittedReferenceKeys: [...candidates],
          });
        }
      }
      if (result.status === "failed" && result.error === "导出请求无效、已过期或目标尚未实现。") {
        // The renderer can briefly hold the previous parse snapshot while the
        // main process has already invalidated it (for example after a file
        // session or asset change). Rebuild the snapshot once instead of
        // leaving the user with a silent dead end.
        setOutputReady(false);
        setWechatReplacements(null);
        setStatus("当前解析快照已过期，正在刷新文档和资源；完成后请再次导出。" );
        setPreviewRefreshVersion((value) => value + 1);
        return;
      }
      describeOutputResult(result);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "导出 IPC 调用失败。");
    } finally {
      setOutputBusy(false);
    }
  }, [active, commitPendingEditor, darkMode, describeOutputResult, outputReady, previewFontName, wechatThemeId]);

  const copyWechatReplacement = useCallback(async (item: WechatReplacementItem) => {
    const task = wechatReplacements;
    if (!task) return;
    const result = await window.fantasticEditor.copyWechatReplacement({ jobId: task.jobId, itemId: item.itemId });
    if (result.status === "copied") {
      setCopiedReplacementIds((current) => new Set(current).add(item.itemId));
      setStatus(item.placement === "inline"
        ? `已复制第 ${item.sequence} 项行内公式图片；在原句中完整选中占位标记后直接粘贴，不要换行。`
        : `已复制第 ${item.sequence} 项${item.kind === "formula" ? "公式图片" : item.kind === "diagram" ? "流程图图片" : "图片"}；完整选中整段占位标记后粘贴，确认标记文字已经消失。`);
    } else setStatus(result.error);
  }, [wechatReplacements]);

  const createWechatDraft = useCallback(async () => {
    const task = wechatReplacements;
    if (!task) {
      setStatus("请先生成公众号正文任务，再同步到草稿箱。");
      return;
    }
    if (!wechatApiConfig.configured) {
      const message = "请先在应用内完成公众号 AppID、AppSecret 和封面图片配置。";
      setWechatDraftFeedback({ kind: "error", message });
      setStatus(message);
      setWechatApiConfigOpen(true);
      return;
    }
    if (task.omittedCount > 0) {
      setStatus("当前任务含已批准省略项，不能自动创建完整公众号草稿。");
      return;
    }
    if (!window.confirm("将自动上传本任务中的正文图片、公式和 Mermaid 图片，并创建公众号草稿。不会直接发布或群发。是否继续？")) return;
    setOutputBusy(true);
    const workingMessage = "正在批量上传图片并创建公众号草稿……";
    setWechatDraftFeedback({ kind: "working", message: workingMessage });
    setStatus(workingMessage);
    try {
      const result = await window.fantasticEditor.createWechatDraft({ jobId: task.jobId });
      if (result.status === "created") {
        const message = `公众号草稿已创建并回读校验：${result.uploadedImageCount} 项图片，草稿 ID ${result.draftMediaId}。未发布。`;
        setWechatDraftFeedback({ kind: "success", message });
        setStatus(message);
      } else {
        setWechatDraftFeedback({ kind: "error", message: result.error });
        setStatus(result.error);
        if (result.uploadedImageCount) setDiagnostics([`已上传 ${result.uploadedImageCount} 项图片，但草稿尚未创建。`]);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "创建公众号草稿失败。";
      setWechatDraftFeedback({ kind: "error", message });
      setStatus(message);
    } finally {
      setOutputBusy(false);
    }
  }, [wechatApiConfig.configured, wechatReplacements]);

  const publishWechatArticle = useCallback(async () => {
    const task = wechatReplacements;
    if (!task) {
      setStatus("请先生成公众号正文任务，再发布文章。");
      return;
    }
    if (!wechatApiConfig.configured) {
      const message = "请先在应用内完成公众号 AppID、AppSecret 和封面图片配置。";
      setWechatDraftFeedback({ kind: "error", message });
      setStatus(message);
      setWechatApiConfigOpen(true);
      return;
    }
    if (task.omittedCount > 0) {
      setStatus("当前任务含已批准省略项，不能一键发布不完整文章。");
      return;
    }
    if (!window.confirm("将自动上传图片、创建公众号草稿并立即提交发布。发布后可能进入平台审核，操作不可撤销。确定继续吗？")) return;
    setOutputBusy(true);
    const workingMessage = "正在上传图片、创建草稿并提交公众号发布……";
    setWechatDraftFeedback({ kind: "working", message: workingMessage });
    setStatus(workingMessage);
    try {
      const result = await window.fantasticEditor.publishWechatArticle({ jobId: task.jobId });
      if (result.status === "published") {
        const suffix = result.articleUrl ? ` 文章链接：${result.articleUrl}` : "";
        const message = `公众号文章已发布，发布任务 ID ${result.publishId}。${suffix}`;
        setWechatDraftFeedback({ kind: "success", message });
        setStatus(message);
      } else if (result.status === "processing") {
        const message = `${result.message} 发布任务 ID ${result.publishId}。`;
        setWechatDraftFeedback({ kind: "working", message });
        setStatus(message);
      } else {
        const draftHint = result.draftMediaId ? ` 草稿 ID ${result.draftMediaId} 仍可在公众号后台查看。` : "";
        const message = `${result.error}${draftHint}`;
        setWechatDraftFeedback({ kind: "error", message });
        setStatus(message);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "公众号一键发布失败。";
      setWechatDraftFeedback({ kind: "error", message });
      setStatus(message);
    } finally {
      setOutputBusy(false);
    }
  }, [wechatApiConfig.configured, wechatReplacements]);

  const toggleReplacementConfirmed = useCallback((itemId: string) => {
    setConfirmedReplacementIds((current) => {
      const next = new Set(current);
      if (next.has(itemId)) {
        next.delete(itemId);
        setWechatAcceptance((progress) => ({ ...progress, draftSaved: false, draftReopened: false, mobilePreviewed: false }));
      } else {
        next.add(itemId);
      }
      return next;
    });
  }, []);

  const setWechatAcceptanceField = useCallback((field: keyof WechatAcceptanceProgress, checked: boolean) => {
    if (field === "bodyPasted" && !checked) {
      setConfirmedReplacementIds(new Set());
    }
    setWechatAcceptance((current) => updateWechatAcceptance(current, field, checked));
  }, []);
  const saveWechatAcceptanceReport = useCallback(async () => {
    const task = wechatReplacements;
    if (!task || !wechatAcceptanceGates.completed) {
      setStatus("完成全部公众号人工验收步骤后才能保存记录。");
      return;
    }
    const result = await window.fantasticEditor.saveWechatAcceptanceReport({
      jobId: task.jobId,
      confirmedReplacementItemIds: [...confirmedReplacementIds],
      confirmation: wechatAcceptance,
    });
    if (result.status === "saved") {
      setStatus("公众号人工验收记录已保存：" + result.displayName);
    } else if (result.status === "cancelled") {
      setStatus("已取消保存公众号人工验收记录。");
    } else {
      setStatus(result.error);
    }
  }, [confirmedReplacementIds, wechatAcceptance, wechatAcceptanceGates.completed, wechatReplacements]);

  const presentTab = useCallback((tab: DocumentTab) => {
    activeDocumentIdRef.current = tab.documentId;
    previewSessionRef.current = null;
    pendingDerivedUpdateRef.current = null;
    imageRefreshAttemptsRef.current.clear();
    setOutputReady(false);
    setWechatReplacements(null);
    setCopiedReplacementIds(new Set());
    setConfirmedReplacementIds(new Set());
    setWechatAcceptance(createEmptyWechatAcceptance());
    setActive({ sessionId: tab.sessionId, documentId: tab.documentId, displayName: tab.displayName, savedText: tab.savedText, workspaceRevision: tab.workspaceRevision, workspaceFileId: tab.workspaceFileId, isUntitled: tab.isUntitled, requiresSave: tab.requiresSave });
    draftRef.current = tab.draft;
    setDraft(tab.draft);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStatus("正在检查上次会话…");
    recoveryPromiseRef.current ??= window.fantasticEditor.restoreRecoverySession();
    void recoveryPromiseRef.current.then((result) => {
      if (cancelled) return;
      if (result.status === "failed") {
        setStatus(`无法恢复上次会话：${result.error}`);
        markRecoveryReady();
        return;
      }
      if (result.status === "empty") {
        setStatus("准备就绪");
        markRecoveryReady();
        return;
      }
      const restoredTabs: DocumentTab[] = result.documents.flatMap((document) => {
        if (document.status !== "opened" || !document.session) return [];
        const session = document.session;
        return [{
          sessionId: session.sessionId,
          documentId: session.documentId,
          displayName: session.displayName,
          savedText: session.savedText ?? session.editorText,
          workspaceRevision: session.workspaceRevision,
          workspaceFileId: null,
          isUntitled: session.isUntitled,
          requiresSave: session.requiresSave ?? false,
          draft: session.editorText,
        }];
      });
      updateTabs(() => restoredTabs);
      setWorkspace(null);
      const target = restoredTabs.find((tab) => tab.sessionId === result.activeSessionId) ?? restoredTabs.at(-1);
      if (target) presentTab(target);
      setDiagnostics(result.warnings);
      setStatus(`已恢复 ${restoredTabs.length} 个文档${result.warnings.length > 0 ? `，${result.warnings.length} 项需要注意` : ""}`);
      markRecoveryReady();
    }).catch((error: unknown) => {
      if (cancelled) return;
      setStatus(error instanceof Error ? `无法恢复上次会话：${error.message}` : "无法恢复上次会话。");
      markRecoveryReady();
    });
    return () => { cancelled = true; };
  }, [markRecoveryReady, presentTab, updateTabs]);

  useEffect(() => {
    if (!recoveryReady) return;
    const totalCharacters = tabs.reduce((sum, tab) => sum + tab.draft.length, 0);
    const recoveryDelayMs = totalCharacters >= 1_000_000 ? 1_500 : totalCharacters >= 250_000 ? 800 : 400;
    const timer = window.setTimeout(() => {
      queueRecoverySnapshot({
        activeSessionId: active?.sessionId ?? null,
        tabs: tabs.map((tab) => ({ sessionId: tab.sessionId, editorText: tab.draft })),
      });
    }, recoveryDelayMs);
    return () => window.clearTimeout(timer);
  }, [active?.sessionId, queueRecoverySnapshot, recoveryReady, tabs]);

  useEffect(() => {
    if (!recoveryReady) return;
    let cancelled = false;
    void window.fantasticEditor.listExternalOpenRequests().then(async (requests) => {
      for (const request of requests) {
        if (cancelled) return;
        if (dirty && !window.confirm(`当前文档尚未保存，仍要打开“${request.displayName}”吗？`)) {
          await window.fantasticEditor.discardExternalOpenRequest({ requestId: request.requestId });
          continue;
        }
        const result = await window.fantasticEditor.openExternalFile({ requestId: request.requestId });
        if (cancelled) return;
        if (result.status === "opened") {
          setWorkspace(null);
          acceptOpenedFile(result);
        } else if (result.status === "failed") setStatus(result.error ?? `打开 ${request.displayName} 失败。`);
      }
    }).catch((error: unknown) => {
      if (!cancelled) setStatus(error instanceof Error ? `外部 Markdown 打开失败：${error.message}` : "外部 Markdown 打开失败。");
    });
    return () => { cancelled = true; };
  }, [acceptOpenedFile, dirty, recoveryReady]);
  useEffect(() => {
    if (!recoveryReady) return;
    const flushRecovery = () => {
      void window.fantasticEditor.persistRecoverySession({
        activeSessionId: active?.sessionId ?? null,
        tabs: tabsRef.current.map((tab) => ({ sessionId: tab.sessionId, editorText: tab.draft })),
      });
    };
    window.addEventListener("beforeunload", flushRecovery);
    return () => window.removeEventListener("beforeunload", flushRecovery);
  }, [active?.sessionId, recoveryReady]);
  const activateTab = useCallback(async (tab: DocumentTab) => {
    if (active?.sessionId === tab.sessionId) return;
    if (!commitPendingEditor()) return;
    const result = await window.fantasticEditor.activateFileSession({ sessionId: tab.sessionId });
    if (result.status === "failed") { setStatus(result.error); return; }
    presentTab(tab);
    setStatus(`已切换到 ${tab.displayName}`);
  }, [active?.sessionId, commitPendingEditor, presentTab]);

  const toggleOutlineForTab = useCallback(async (tab: DocumentTab) => {
    if (active?.sessionId !== tab.sessionId) {
      await activateTab(tab);
      if (activeDocumentIdRef.current !== tab.documentId) return;
    }
    setExpandedOutlineSessionId((current) => current === tab.sessionId ? null : tab.sessionId);
  }, [activateTab, active?.sessionId]);

  const closeTab = useCallback(async (tab: DocumentTab) => {
    if (active?.sessionId === tab.sessionId && !commitPendingEditor()) return;
    const currentTab = tabsRef.current.find((item) => item.sessionId === tab.sessionId) ?? tab;
    if ((currentTab.requiresSave || currentTab.draft !== currentTab.savedText) && !window.confirm(`${currentTab.displayName} 尚未保存，确定关闭这个标签吗？`)) return;
    const result = await window.fantasticEditor.closeFileSession({ sessionId: tab.sessionId });
    if (result.status === "failed") { setStatus(result.error); return; }
    const currentTabs = tabsRef.current;
    const closedIndex = currentTabs.findIndex((item) => item.sessionId === tab.sessionId);
    const remaining = currentTabs.filter((item) => item.sessionId !== tab.sessionId);
    updateTabs(() => remaining);
    if (active?.sessionId !== tab.sessionId) return;
    const next = remaining[Math.min(Math.max(closedIndex, 0), remaining.length - 1)];
    if (next) {
      await window.fantasticEditor.activateFileSession({ sessionId: next.sessionId });
      presentTab(next);
      setStatus(`已关闭 ${tab.displayName}`);
    } else {
      activeDocumentIdRef.current = null;
      previewSessionRef.current = null;
      setActive(null);
      draftRef.current = EMPTY_DOCUMENT;
      setDraft(EMPTY_DOCUMENT);
      setPreviewHtml("<h1>fantastic-editor</h1><p>新建、打开或拖入一个 Markdown 文件。</p>");
      setOutputReady(false);
      setStatus("没有打开的文档");
    }
  }, [active?.sessionId, commitPendingEditor, presentTab, updateTabs]);

  const activateTabAtIndex = useCallback(async (index: number, focusTab: boolean) => {
    const tab = tabsRef.current[index];
    if (!tab) return;
    await activateTab(tab);
    if (focusTab) window.requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(`.tab-select[data-tab-index="${index}"]`)?.focus();
    });
  }, [activateTab]);

  const moveDocumentTab = useCallback((sessionId: string, targetIndex: number) => {
    const currentTabs = tabsRef.current;
    const fromIndex = currentTabs.findIndex((tab) => tab.sessionId === sessionId);
    if (fromIndex < 0 || targetIndex < 0 || targetIndex >= currentTabs.length || fromIndex === targetIndex) return false;
    updateTabs((current) => {
      const liveFromIndex = current.findIndex((tab) => tab.sessionId === sessionId);
      return moveTabItem(current, liveFromIndex, targetIndex);
    });
    setStatus(`已将 ${currentTabs[fromIndex]!.displayName} 移到第 ${targetIndex + 1} 个标签。`);
    window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`.tab-select[data-tab-index="${targetIndex}"]`)?.focus());
    return true;
  }, [updateTabs]);

  const handleTabKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>, currentIndex: number, sessionId: string) => {
    const moveIndex = moveTabIndexForKey(tabsRef.current.length, currentIndex, event.key, event.altKey, event.shiftKey);
    if (moveIndex !== null) {
      event.preventDefault();
      moveDocumentTab(sessionId, moveIndex);
      return;
    }
    const nextIndex = tabIndexForNavigationKey(tabsRef.current.length, currentIndex, event.key);
    if (nextIndex === null) return;
    event.preventDefault();
    void activateTabAtIndex(nextIndex, true);
  }, [activateTabAtIndex, moveDocumentTab]);

  const importImages = useCallback(async (files?: File[], existingAnchorId?: string) => {
    setDragActive(false);
    const insertionEditor = editorMode === "wysiwyg" ? wysiwygEditorRef.current : markdownEditorRef.current;
    if (imageImportBusyRef.current) {
      if (existingAnchorId) insertionEditor?.discardInsertionAnchor(existingAnchorId);
      setStatus("已有图片导入任务正在进行，请稍候。");
      return;
    }
    if (editorMode === "wysiwyg" && !commitPendingEditor()) return;
    imageImportBusyRef.current = true;
    setImageImportBusy(true);
    let anchorId = existingAnchorId;
    try {
      let target = active;
      if (!target) { setStatus("请先新建或打开一个 Markdown 文件。"); return; }
      if (target.isUntitled) {
        setStatus("插入图片前，请先保存 Markdown 文档。");
        const saved = await saveAs();
        if (!saved) return;
        target = saved;
      }
      anchorId ??= insertionEditor?.createInsertionAnchor() ?? undefined;
      if (!anchorId) { setStatus("无法确定图片插入位置。"); return; }
      const request = {
        importRequestId: `image-import-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        sessionId: target.sessionId,
        documentId: target.documentId,
        workspaceRevision: target.workspaceRevision,
      };
      setStatus(files ? `正在导入 ${files.length} 张图片…` : "请选择要插入的图片…");
      const result = files
        ? await window.fantasticEditor.importDroppedImages(request, files)
        : await window.fantasticEditor.selectAndImportImages(request);
      if (result.status === "cancelled") { setStatus("已取消插入图片。"); return; }
      if (result.status === "failed") { setStatus(result.error); return; }
      updateTabs((current) => current.map((tab) => tab.sessionId === target!.sessionId ? { ...tab, workspaceRevision: result.workspaceRevision } : tab));
      setActive((current) => current?.documentId === target!.documentId ? { ...current, workspaceRevision: result.workspaceRevision } : current);
      if (target.workspaceFileId) setWorkspace((current) => current ? { ...current, workspaceRevision: result.workspaceRevision } : current);
      setOutputReady(false);
      setWechatReplacements(null);
      setCopiedReplacementIds(new Set());
    setConfirmedReplacementIds(new Set());
    setWechatAcceptance(createEmptyWechatAcceptance());
      if (activeDocumentIdRef.current !== target.documentId) {
        setStatus("图片已导入 assets，但当前已切换到其他文档，未插入 Markdown 引用。");
        return;
      }
      const inserted = insertionEditor?.insertImages(anchorId, result.receipts) ?? false;
      if (!inserted) {
        setStatus("图片已导入 assets，但插入锚点已失效；请重新点击插入图片。");
        return;
      }
      anchorId = undefined;
      const reused = result.receipts.filter((item) => item.reusedExisting).length;
      setStatus(`已插入 ${result.receipts.length} 张图片${reused > 0 ? `，复用 ${reused} 个已有资源` : ""}；预览正在同步。`);
    } catch (error) {
      setStatus(error instanceof Error ? `图片导入失败：${error.message}` : "图片导入 IPC 调用失败。");
    } finally {
      if (anchorId) insertionEditor?.discardInsertionAnchor(anchorId);
      imageImportBusyRef.current = false;
      setImageImportBusy(false);
    }
  }, [active, commitPendingEditor, editorMode, saveAs, updateTabs]);
  const handleDrop = useCallback(async (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragActive(false);
    const allFiles = [...event.dataTransfer.files];
    const markdownFiles = allFiles.filter((file) => /\.(?:md|markdown)$/i.test(file.name));
    const imageFiles = allFiles.filter((file) => /\.(?:png|jpe?g|gif|webp|svg)$/i.test(file.name));
    if (markdownFiles.length > 0 && imageFiles.length > 0) { setStatus("Markdown 与图片不能混合拖入，请分开操作。"); return; }
    if (imageFiles.length > 0) { setStatus("请把图片拖到 Markdown 编辑区的具体插入位置。"); return; }
    if (markdownFiles.length === 0 || markdownFiles.length !== allFiles.length) { setStatus("只能拖入 Markdown 文档，或将图片拖到编辑区插入。"); return; }
    let opened = 0;
    for (const file of markdownFiles) {
      const result = await window.fantasticEditor.openDroppedMarkdownFile(file);
      if (result.status === "opened") {
        if (workspace && opened === 0) { updateTabs(() => []); setWorkspace(null); }
        acceptOpenedFile(result);
        opened += 1;
      } else if (result.status === "failed") setStatus(result.error ?? "拖入文件失败。");
    }
    if (opened > 0) setStatus(`已拖入 ${opened} 个 Markdown 文档`);
  }, [acceptOpenedFile, updateTabs, workspace]);

  const switchEditorMode = useCallback((nextMode: "source" | "wysiwyg") => {
    if (nextMode === editorMode) return;
    if (imageImportBusyRef.current) {
      setStatus("图片导入完成后才能切换编辑模式。");
      return;
    }
    if (editorMode === "wysiwyg" && !commitPendingEditor()) return;
    if (nextMode === "wysiwyg") {
      previousSourceViewModeRef.current = viewMode;
      synchronizedPreviewRef.current?.clearTransientState();
      setViewMode("editor");
      setStatus("已切换到所见即所得模式；Markdown 仍是唯一保存来源。");
    } else {
      setViewMode(previousSourceViewModeRef.current);
      setStatus("已切换到源代码模式。");
      window.requestAnimationFrame(() => markdownEditorRef.current?.focus());
    }
    setEditorMode(nextMode);
  }, [commitPendingEditor, editorMode, viewMode]);

  const clearSearch = useCallback(() => {
    markdownEditorRef.current?.clearSearch?.();
    wysiwygEditorRef.current?.clearSearch?.();
    synchronizedPreviewRef.current?.clearSearch?.();
    clearVisibleTextSearch();
    searchIndexRef.current = -1;
    setSearchResult({ index: 0, total: 0 });
  }, []);

  const findInCurrentView = useCallback((direction = 1) => {
    const query = searchQuery.trim();
    if (!query) { clearSearch(); return; }
    const result = viewMode === "preview"
      ? synchronizedPreviewRef.current?.find(query, direction, searchIndexRef.current)
      : editorMode === "wysiwyg"
        ? wysiwygEditorRef.current?.find(query, direction, searchIndexRef.current)
        : markdownEditorRef.current?.find(query, direction, searchIndexRef.current);
    const normalized = result ?? { index: 0, total: 0 };
    searchIndexRef.current = normalized.index > 0 ? normalized.index - 1 : -1;
    setSearchResult(normalized);
  }, [clearSearch, editorMode, searchQuery, viewMode]);

  const revealOutlineEntry = useCallback((entry: OutlineEntry) => {
    const revealed = viewMode === "preview"
      ? synchronizedPreviewRef.current?.revealSourceRange(entry.from, entry.to)
      : editorMode === "wysiwyg"
        ? wysiwygEditorRef.current?.revealSourceRange(entry.from, entry.to)
        : markdownEditorRef.current?.revealSourceRange(entry.from, entry.to);
    setStatus(revealed ? `已跳转到 ${entry.label}` : "当前视图尚未完成渲染，暂时无法跳转。请稍候再试。");
  }, [editorMode, viewMode]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && searchOpen) {
        event.preventDefault();
        setSearchOpen(false);
        clearSearch();
        return;
      }
      if (!event.ctrlKey) return;
      if (wechatThemePreviewOpen) return;
      if (event.key.toLowerCase() === "f" || event.key.toLowerCase() === "h") {
        event.preventDefault();
        setSearchOpen(true);
        setSearchReplaceOpen(event.key.toLowerCase() === "h");
        window.requestAnimationFrame(() => searchInputRef.current?.focus());
        return;
      }
      if (event.key === "Tab") {
        const currentIndex = tabsRef.current.findIndex((tab) => tab.sessionId === active?.sessionId);
        const nextIndex = adjacentTabIndex(tabsRef.current.length, currentIndex, event.shiftKey ? -1 : 1);
        if (nextIndex !== null) {
          event.preventDefault();
          void activateTabAtIndex(nextIndex, false);
        }
        return;
      }
      if (event.key.toLowerCase() === "w" && active) {
        event.preventDefault();
        const current = tabsRef.current.find((tab) => tab.sessionId === active.sessionId);
        if (current) void closeTab(current);
        return;
      }
      if (editorMode === "wysiwyg" && (event.key.toLowerCase() === "z" || event.key.toLowerCase() === "y")) {
        event.preventDefault();
        if (!commitPendingEditor()) return;
        const redoRequested = event.key.toLowerCase() === "y" || event.shiftKey;
        const changed = redoRequested ? markdownEditorRef.current?.redo() : markdownEditorRef.current?.undo();
        setStatus(changed ? (redoRequested ? "已重做上一项编辑。" : "已撤销上一项编辑。") : "没有可用的编辑历史。");
        return;
      }
      if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (event.shiftKey) void saveAs(); else void save();
      }
      if (event.key.toLowerCase() === "o") { event.preventDefault(); void openFile(); }
      if (event.key.toLowerCase() === "n") { event.preventDefault(); void newFile(); }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activateTabAtIndex, active, clearSearch, closeTab, commitPendingEditor, editorMode, newFile, openFile, save, saveAs, searchOpen, wechatThemePreviewOpen]);

  const handlePreviewImageError = useCallback((event: SyntheticEvent<HTMLElement>) => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || !image.src.startsWith("fantastic-asset://asset/")) return;
    const referenceKey = image.dataset.referenceKey;
    if (!referenceKey || !/^[a-f\d]{64}$/i.test(referenceKey)) return;
    const now = Date.now();
    const previous = imageRefreshAttemptsRef.current.get(referenceKey);
    const current = !previous || now - previous.firstAt > 15_000
      ? { count: 0, firstAt: now }
      : previous;
    if (current.count >= 2) {
      setStatus("本地图片连续加载失败；已停止自动重试，请检查图片文件是否损坏或仍在修改。");
      return;
    }
    imageRefreshAttemptsRef.current.set(referenceKey, { ...current, count: current.count + 1 });
    setStatus("本地图片加载失败，正在重新验证授权和文件内容……");
    setPreviewRefreshVersion((value) => value + 1);
  }, []);

  const handlePreviewImageLoad = useCallback((event: SyntheticEvent<HTMLElement>) => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement)) return;
    const referenceKey = image.dataset.referenceKey;
    if (referenceKey) imageRefreshAttemptsRef.current.delete(referenceKey);
  }, []);

  const startResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const stage = event.currentTarget.parentElement;
    if (!stage) return;
    event.preventDefault();
    const rect = stage.getBoundingClientRect();
    const handleMove = (moveEvent: PointerEvent) => {
      const ratio = ((moveEvent.clientX - rect.left) / rect.width) * 100;
      setSplitRatio(clampSplitRatio(ratio));
    };
    const handleUp = () => {
      document.body.classList.remove("is-resizing");
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
    document.body.classList.add("is-resizing");
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp, { once: true });
  }, []);

  const retryPreview = useCallback(() => {
    setPreviewRetryAvailable(false);
    setStatus("正在重新解析当前文档…");
    setPreviewRefreshVersion((current) => current + 1);
  }, []);

  const closeWechatThemePreview = useCallback(() => {
    setWechatThemePreviewOpen(false);
    window.requestAnimationFrame(() => wechatThemeButtonRef.current?.focus());
  }, []);

  const applyPreviewFontDraft = useCallback((value: string) => {
    const next = commitPreviewFontDraft(value, previewFontName);
    setPreviewFontDraft(next);
    setPreviewFontName(next);
    setStatus(`正文字体已切换为 ${next}。`);
  }, [previewFontName]);

  const resizeWithKeyboard = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const next = splitRatioForKey(splitRatio, event.key, event.shiftKey);
    if (next === null) return;
    event.preventDefault();
    setSplitRatio(next);
    setStatus(`编辑区宽度已调整为 ${Math.round(next)}%。`);
  }, [splitRatio]);

  const title = useMemo(() => `${active?.displayName ?? "欢迎"}${dirty ? " · 未保存" : ""}`, [active?.displayName, dirty]);

  return (
    <main className={`app-shell${darkMode ? " theme-dark" : ""}${dragActive ? " drag-active" : ""}`} onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDragActive(true); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false); }} onDrop={(event) => void handleDrop(event)}>
      <datalist id="preview-font-presets">{PREVIEW_FONT_PRESETS.map((font) => <option key={font} value={font} />)}</datalist>
      <header className="app-header">
        <div className="brand-lockup"><span className="brand-symbol">f</span><span className="brand-name">fantastic<span>editor</span></span></div>
        <div className="header-file-actions">
          <button type="button" className="icon-button" data-testid="new-document" title="新建文档 (Ctrl+N)" aria-label="新建文档" onClick={() => void newFile()}><Icon name="filePlus" /></button>
          <button type="button" className="icon-button" title="打开文件 (Ctrl+O)" aria-label="打开文件" onClick={() => void openFile()}><Icon name="folderOpen" /></button>
          <button type="button" className="icon-button" disabled={!active || !dirty} title="保存 (Ctrl+S)" aria-label="保存" onClick={() => void save()}><Icon name="save" /></button>
        </div>
        <div className="header-document"><span className={`document-state${dirty ? " dirty" : ""}`} /><span>{title}</span><small>{active ? "本地文档" : "本地优先 Markdown 编辑器"}</small></div>
        <div className="header-tools">
          <button
            type="button"
            className={`wechat-header-button${wechatApiConfig.configured ? " configured" : " needs-config"}`}
            title={wechatApiConfig.configured ? "查看公众号 AppID、AppSecret、封面与 IP 白名单状态" : "配置公众号 AppID、AppSecret、封面与 IP 白名单"}
            onClick={() => setWechatApiConfigOpen(true)}
          >
            <span className="wechat-header-dot" />
            <span>{wechatApiConfig.configured ? "公众号设置" : "公众号设置 · 待配置"}</span>
          </button>
          <button ref={wechatThemeButtonRef} type="button" className="header-nav-button wechat-layout-entry" disabled={!active || wechatThemeSaveOpen} title="选择公众号主题并查看手机宽度质量审计" onClick={() => setWechatThemePreviewOpen(true)}><Icon name="eye" size={14} /><span>公众号排版</span></button>
          <button type="button" className="header-nav-button" disabled={!active} title="修复网页复制产生的标题、列表、代码围栏、成对格式和表格断行" onClick={repairCurrentWebMarkdown}><Icon name="markdown" size={14} /><span>修复网页 Markdown</span></button>
          <button type="button" className="header-nav-button" disabled={!active} onClick={() => { setSearchOpen(true); setSearchReplaceOpen(false); window.requestAnimationFrame(() => searchInputRef.current?.focus()); }}><Icon name="search" size={14} /><span>查找/替换</span></button>
          <div className="view-switcher" role="group" aria-label="视图模式">
            <button type="button" className={viewMode === "editor" ? "active" : ""} disabled={!active} aria-label="仅编辑" aria-pressed={viewMode === "editor"} title="仅编辑" onClick={() => setViewMode("editor")}><Icon name="markdown" /></button>
            <button type="button" className={viewMode === "split" ? "active" : ""} disabled={!active || editorMode === "wysiwyg"} aria-label="分栏" aria-pressed={viewMode === "split"} title={editorMode === "wysiwyg" ? "所见即所得模式已包含渲染效果" : "编辑与预览"} onClick={() => setViewMode("split")}><Icon name="columns" /></button>
            <button type="button" className={viewMode === "preview" ? "active" : ""} disabled={!active} aria-label="仅预览" aria-pressed={viewMode === "preview"} title="查看最终只读渲染" onClick={() => { if (editorMode === "wysiwyg" && !commitPendingEditor()) return; setViewMode("preview"); }}><Icon name="eye" /></button>
          </div>
          <details className={`export-menu${!active || !outputReady || outputBusy ? " disabled" : ""}`}>
            <summary
              ref={exportMenuSummaryRef}
              title={!active ? "请先新建或打开 Markdown 文档" : outputBusy ? "导出正在处理中" : !outputReady ? "正在解析文档和资源，请稍候" : "导出与发布"}
              onClick={(event) => {
                if (active && outputReady && !outputBusy) return;
                event.preventDefault();
                setStatus(!active ? "请先新建或打开一个 Markdown 文件。" : outputBusy ? "已有导出任务正在处理，请稍候。" : "文档或资源仍在解析，请稍候再导出。" );
              }}
            ><Icon name="download" /><span>{outputBusy ? "处理中" : "导出"}</span><Icon name="chevronDown" size={14} /></summary>
            <div className="export-popover">
              <div className="menu-heading">导出与发布</div>
              <button type="button" onClick={(event) => { (event.currentTarget.closest("details") as HTMLDetailsElement).open = false; void exportDocument("pdf"); }}><span className="format-badge pdf">PDF</span><span><strong>导出 PDF</strong><small>保持当前排版和公式</small></span></button>
              <button type="button" onClick={(event) => { (event.currentTarget.closest("details") as HTMLDetailsElement).open = false; void exportDocument("docx"); }}><span className="format-badge word">W</span><span><strong>导出 Word</strong><small>生成可继续编辑的 DOCX</small></span></button>
              <button type="button" onClick={(event) => { (event.currentTarget.closest("details") as HTMLDetailsElement).open = false; void exportDocument("offline-html"); }}><span className="format-badge html">&lt;/&gt;</span><span><strong>离线 HTML</strong><small>图片与公式完全自包含</small></span></button>
              <div className="menu-separator" />
              <button type="button" onClick={(event) => { (event.currentTarget.closest("details") as HTMLDetailsElement).open = false; void exportDocument("wechat-clipboard"); }}><span className="format-badge wechat">微</span><span><strong>复制到公众号</strong><small>使用主界面当前选定的公众号主题</small></span></button>
            </div>
          </details>
          <button type="button" className="icon-button theme-toggle" aria-label={darkMode ? "切换浅色主题" : "切换深色主题"} title={darkMode ? "浅色主题" : "深色主题"} onClick={() => setDarkMode((value) => !value)}><Icon name={darkMode ? "sun" : "moon"} /></button>
        </div>
      </header>

      <div className="workbench">
        <aside className="activity-bar" aria-label="主导航">
          <button type="button" className={sidebarVisible && sidebarPanel === "explorer" ? "active" : ""} aria-label="切换资源管理器" title="资源管理器" onClick={() => { setSidebarPanel("explorer"); setSidebarVisible(true); }}><Icon name="panelLeft" /></button>
          <button type="button" className={sidebarVisible && sidebarPanel === "outline" ? "active" : ""} aria-label="切换文档大纲" title="文档大纲" onClick={() => { setSidebarPanel("outline"); setSidebarVisible(true); }}><Icon name="list" /></button>
          <button type="button" aria-label="新建文档" title="新建文档" onClick={() => void newFile()}><Icon name="filePlus" /></button>
          <button type="button" aria-label="打开文件夹" title="打开文件夹" onClick={() => void openFolder()}><Icon name="folder" /></button>
        </aside>

        {sidebarVisible && sidebarPanel === "explorer" && (
          <aside className="explorer-panel" aria-label="资源管理器">
            <div className="explorer-title"><span>资源管理器</span><button type="button" title="打开文件夹" aria-label="打开文件夹" onClick={() => void openFolder()}><Icon name="folderOpen" size={16} /></button></div>
            <section className="explorer-section">
              <div className="section-title"><span className="section-chevron">⌄</span><span>打开的编辑器</span><small>{tabs.length}</small></div>
              <div className="open-editors">
                {tabs.length === 0 && <p className="explorer-empty">尚未打开文档</p>}
                {tabs.map((tab) => (
                  <div className="open-editor-entry" key={tab.sessionId}>
                    {renameTarget?.kind === "open" && renameTarget.sessionId === tab.sessionId ? (
                      <form className="rename-inline-form" onSubmit={(event) => { event.preventDefault(); void submitRename(); }}>
                        <input ref={renameInputRef} value={renameValue} aria-label="新的 Markdown 文件名" onChange={(event) => setRenameValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); cancelRename(); } }} />
                      </form>
                    ) : (
                      <button type="button" className={`open-editor-select${active?.sessionId === tab.sessionId ? " active" : ""}`} title="点击切换文档；再次点击展开或收起目录；右键重命名" onClick={() => void toggleOutlineForTab(tab)} onContextMenu={(event) => {
                        event.preventDefault();
                        beginRenameOpenFile(tab);
                      }}>
                        <Icon name="markdown" size={15} /><span>{tab.displayName}</span>{(tab.requiresSave || tab.draft !== tab.savedText) && <i aria-label="未保存" />}
                      </button>
                    )}
                    {expandedOutlineSessionId === tab.sessionId && active?.sessionId === tab.sessionId && (
                      <div className="inline-outline">
                        <DocumentOutline entries={extractDocumentOutline(outlineDocument)} stale={Boolean(active && !outlineDocument)} onReveal={revealOutlineEntry} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
            {workspace ? (
              <section className="explorer-section workspace-tree">
                <div className="section-title"><span className="section-chevron">⌄</span><span title={workspace.displayName}>{workspace.displayName}</span><small>{workspace.files.length}</small></div>
                <div className="workspace-files">
                  {workspace.files.map((file) => (
                    <div className="workspace-file-entry" key={file.fileId}>
                      {renameTarget?.kind === "workspace" && renameTarget.workspaceId === workspace.workspaceId && renameTarget.fileId === file.fileId ? (
                        <form className="rename-inline-form" onSubmit={(event) => { event.preventDefault(); void submitRename(); }}>
                          <input ref={renameInputRef} value={renameValue} aria-label="新的 Markdown 文件名" onChange={(event) => setRenameValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); cancelRename(); } }} />
                        </form>
                      ) : (
                        <button type="button" className={`workspace-file-select${active?.workspaceFileId === file.fileId ? " active" : ""}`} title={`${file.relativePath} · 右键重命名`} onClick={() => void selectWorkspaceFile(workspace, file)} onContextMenu={(event) => { event.preventDefault(); beginRenameWorkspaceFile(workspace, file); }}><Icon name="file" size={14} /><span>{file.displayName}</span></button>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            ) : (
              <div className="explorer-onboarding"><Icon name="folder" size={28} /><strong>还没有打开文件夹</strong><span>打开工作区后，可以在这里快速切换 Markdown 文档。</span><button type="button" onClick={() => void openFolder()}>打开文件夹</button></div>
            )}
          </aside>
        )}
        {sidebarVisible && sidebarPanel === "outline" && (
          <aside className="explorer-panel outline-panel" aria-label="文档大纲">
            <div className="explorer-title"><span>文档大纲</span><small>{extractDocumentOutline(outlineDocument).length}</small></div>
            <DocumentOutline entries={extractDocumentOutline(outlineDocument)} stale={Boolean(active && !outlineDocument)} onReveal={revealOutlineEntry} />
          </aside>
        )}

        <section className="main-area">
          <nav className="document-tabs" data-testid="document-tabs" aria-label="打开的文档">
            <div className="tab-strip" role="tablist" aria-label="文档标签">
              {tabs.map((tab, tabIndex) => {
                const tabDirty = tab.requiresSave || tab.draft !== tab.savedText;
                return (
                  <div
                    className={`document-tab${active?.sessionId === tab.sessionId ? " active" : ""}`}
                    key={tab.sessionId}
                    draggable
                    onDragStart={(event) => { draggedTabSessionIdRef.current = tab.sessionId; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-fantastic-editor-tab", tab.sessionId); }}
                    onDragEnter={(event) => { event.preventDefault(); event.stopPropagation(); }}
                    onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move"; }}
                    onDrop={(event) => { event.preventDefault(); event.stopPropagation(); const sessionId = draggedTabSessionIdRef.current ?? event.dataTransfer.getData("application/x-fantastic-editor-tab"); if (sessionId) moveDocumentTab(sessionId, tabIndex); draggedTabSessionIdRef.current = null; }}
                    onDragEnd={() => { draggedTabSessionIdRef.current = null; }}
                  >
                    <button type="button" role="tab" aria-selected={active?.sessionId === tab.sessionId} tabIndex={active?.sessionId === tab.sessionId ? 0 : -1} data-tab-index={tabIndex} className="tab-select" title={`${tab.displayName} · 左右键切换，Alt+Shift+左右键移动`} onKeyDown={(event) => handleTabKeyDown(event, tabIndex, tab.sessionId)} onClick={() => void activateTab(tab)}><Icon name="markdown" size={14} /><span>{tab.displayName}</span>{tabDirty && <span className="dirty-dot" aria-label="未保存" />}</button>
                    <button type="button" className="tab-close" aria-label={`关闭 ${tab.displayName}`} title="关闭标签 (Ctrl+W)" onClick={() => void closeTab(tab)}>×</button>
                  </div>
                );
              })}
              <button type="button" className="new-tab" aria-label="新建文档" title="新建文档 (Ctrl+N)" onClick={() => void newFile()}>＋</button>
            </div>
            <span className="drop-hint" data-testid="drop-hint">拖入 Markdown 打开 · 图片拖到编辑区插入</span>
          </nav>

          {active ? (
            <section className={`document-stage view-${viewMode}`} style={viewMode === "split" ? { gridTemplateColumns: `minmax(0, ${splitRatio}fr) 6px minmax(0, ${100 - splitRatio}fr)` } : undefined}>
              <div className={`pane editor-pane editor-mode-${editorMode}`}>
                <div className="pane-header">
                  <span><Icon name={editorMode === "source" ? "markdown" : "eye"} size={15} />{editorMode === "source" ? "源代码" : "所见即所得"}</span>
                  <div className="pane-actions">
                    <div className="editor-mode-switch" role="group" aria-label="编辑模式" data-testid="editor-mode-switch">
                      <button type="button" className={editorMode === "source" ? "active" : ""} aria-pressed={editorMode === "source"} disabled={imageImportBusy} onClick={() => switchEditorMode("source")}>源代码</button>
                      <button type="button" className={editorMode === "wysiwyg" ? "active" : ""} aria-pressed={editorMode === "wysiwyg"} disabled={imageImportBusy} onClick={() => switchEditorMode("wysiwyg")}>所见即所得</button>
                    </div>
                    {editorMode === "wysiwyg" && <>
                      <button
                        type="button"
                        className={`wysiwyg-theme-toggle${wechatThemeInWysiwyg ? " active" : ""}`}
                        aria-pressed={wechatThemeInWysiwyg}
                        title={wechatThemeInWysiwyg ? "关闭所见即所得区的公众号主题显示" : `在所见即所得区实时显示“${wechatThemeResolved.name}”`}
                        onClick={() => {
                          const next = !wechatThemeInWysiwyg;
                          setWechatThemeInWysiwyg(next);
                          setStatus(next ? `已在所见即所得区启用公众号主题：${wechatThemeResolved.name}。Markdown 内容不会改变。` : "已关闭所见即所得区的公众号主题显示。");
                        }}
                      >{wechatThemeInWysiwyg ? "公众号主题 · 开" : "公众号主题 · 关"}</button>
                      <label className="preview-font-control" title="输入本机已安装的字体名称，按 Enter 或移出焦点应用"><span>字体</span><input data-testid="wysiwyg-font-select" list="preview-font-presets" value={previewFontDraft} onChange={(event) => { const value = event.target.value; setPreviewFontDraft(value); if (PREVIEW_FONT_PRESETS.includes(value as typeof PREVIEW_FONT_PRESETS[number])) applyPreviewFontDraft(value); }} onBlur={(event) => applyPreviewFontDraft(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); applyPreviewFontDraft(event.currentTarget.value); event.currentTarget.blur(); } else if (event.key === "Escape") { event.currentTarget.value = previewFontName; setPreviewFontDraft(previewFontName); event.currentTarget.blur(); } }} /></label>
                      <label className="preview-reading-control" title="调整所见即所得阅读宽度"><span>宽度</span><select aria-label="所见即所得阅读宽度" value={readingWidth} onChange={(event) => setReadingWidth(normalizeReadingWidth(event.target.value))}>{READING_WIDTH_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
                      <div className="preview-font-size-control" role="group" aria-label="所见即所得字号"><button type="button" title="减小字号" onClick={() => setPreviewFontSize((value) => normalizePreviewFontSize(value - 1))}>−</button><span>{previewFontSize}px</span><button type="button" title="增大字号" onClick={() => setPreviewFontSize((value) => normalizePreviewFontSize(value + 1))}>＋</button></div>
                    </>}
                    <small>{editorMode === "source" ? "Markdown" : "Markdown 实时写回"}</small>
                    <button type="button" className="insert-image-button" disabled={imageImportBusy} title="在当前位置插入图片" aria-label="插入图片" onClick={() => void importImages()}><Icon name="imagePlus" size={15} />插入图片</button>
                  </div>
                </div>
                <div className="editor-mode-body">
                  <div className={`source-editor-layer${editorMode === "source" ? " active" : ""}`} aria-hidden={editorMode !== "source"}>
                    <MarkdownEditor
                      ref={markdownEditorRef}
                      value={draft}
                      onViewportAnchorChange={(anchor) => { if (editorMode === "source") synchronizedPreviewRef.current?.updateViewportAnchor(anchor); }}
                      onSelectionChange={(selection) => { if (editorMode === "source") synchronizedPreviewRef.current?.updateSelection(selection); }}
                      onImageDrop={(files, anchorId) => void importImages(files, anchorId)}
                      onDropRejected={(message) => { setDragActive(false); setStatus(message); }}
                      onStatus={setStatus}
                      onChange={applyDraftChange}
                    />
                  </div>
                  <div className={`wysiwyg-editor-layer${editorMode === "wysiwyg" ? " active" : ""}`} aria-hidden={editorMode !== "wysiwyg"}>
                    <WysiwygEditor
                      ref={wysiwygEditorRef}
                      value={draft}
                      html={previewHtml}
                      htmlReady={previewHtmlReady}
                      fontFamily={previewFontStack(previewFontName)}
                      readingMaxWidth={readingWidthMaxWidth(readingWidth)}
                      previewFontSize={previewFontSize}
                      {...(wechatThemeInWysiwyg ? { wechatThemeDefinition: wechatThemeResolved.definition } : {})}
                      darkMode={darkMode}
                      imageImportBusy={imageImportBusy}
                      onApplyTextChange={(change) => {
                        const next = markdownEditorRef.current?.applyTextChange(change) ?? null;
                        if (next === null) setStatus("所见即所得修改未写入：文档版本或 SourceRange 已变化。");
                        return next;
                      }}
                      onImageDrop={(files, anchorId) => void importImages(files, anchorId)}
                      onRequestImageReplacement={(anchorId) => void importImages(undefined, anchorId)}
                      onDropRejected={(message) => { setDragActive(false); setStatus(message); }}
                      onStatus={setStatus}
                      onErrorCapture={handlePreviewImageError}
                      onLoadCapture={handlePreviewImageLoad}
                    />
                  </div>
                </div>
              </div>
              {viewMode === "split" && <div className="split-handle" role="separator" aria-label="调整编辑与预览宽度；使用左右方向键调整" aria-orientation="vertical" aria-valuemin={MIN_SPLIT_RATIO} aria-valuemax={MAX_SPLIT_RATIO} aria-valuenow={Math.round(splitRatio)} tabIndex={0} onKeyDown={resizeWithKeyboard} onPointerDown={startResize}><span /></div>}
              <div className="pane preview-pane">
                <div className="pane-header">
                  <span><Icon name="eye" size={15} />实时预览</span>
                  <div className="pane-actions">
                    <label className="preview-font-control" title="设置实时预览和导出的正文字体">
                      <span>字体</span>
                      <input
                        data-testid="preview-font-select"
                        list="preview-font-presets"
                        value={previewFontDraft}
                        onChange={(event) => { const value = event.target.value; setPreviewFontDraft(value); if (PREVIEW_FONT_PRESETS.includes(value as typeof PREVIEW_FONT_PRESETS[number])) applyPreviewFontDraft(value); }}
                        onBlur={(event) => applyPreviewFontDraft(event.currentTarget.value)}
                        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); applyPreviewFontDraft(event.currentTarget.value); event.currentTarget.blur(); } else if (event.key === "Escape") { event.currentTarget.value = previewFontName; setPreviewFontDraft(previewFontName); event.currentTarget.blur(); } }}
                      />
                    </label>
                    <label className="preview-reading-control" title="仅影响实时预览和所见即所得阅读区，不改变导出结果"><span>宽度</span><select aria-label="阅读宽度" value={readingWidth} onChange={(event) => setReadingWidth(normalizeReadingWidth(event.target.value))}>{READING_WIDTH_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
                    <div className="preview-font-size-control" role="group" aria-label="预览字号"><button type="button" title="减小预览字号" onClick={() => setPreviewFontSize((value) => normalizePreviewFontSize(value - 1))}>−</button><span>{previewFontSize}px</span><button type="button" title="增大预览字号" onClick={() => setPreviewFontSize((value) => normalizePreviewFontSize(value + 1))}>＋</button></div>
                    <button
                      type="button"
                      className={`sync-scroll-button${syncScrollEnabled ? " active" : ""}`}
                      aria-pressed={syncScrollEnabled}
                      data-testid="sync-scroll-toggle"
                      title={syncScrollEnabled ? "关闭编辑区到预览区的同步滚动" : "开启编辑区到预览区的同步滚动"}
                      onClick={() => {
                        setSyncScrollEnabled((current) => {
                          const next = !current;
                          setStatus(next ? "已开启同步滚动：编辑区将驱动预览区。" : "已关闭同步滚动：两个区域可独立滚动。");
                          return next;
                        });
                      }}
                    >
                      <Icon name="scrollSync" size={15} /><span>同步滚动</span><strong>{syncScrollEnabled ? "ON" : "OFF"}</strong>
                    </button>
                    <small>安全本地渲染</small>
                  </div>
                </div>
                <SynchronizedPreview
                  ref={synchronizedPreviewRef}
                  html={previewHtml}
                  enabled={syncScrollEnabled}
                  active={viewMode !== "editor"}
                  identityKey={previewSyncIdentity}
                  fontFamily={previewFontStack(previewFontName)}
                  readingMaxWidth={readingWidthMaxWidth(readingWidth)}
                  previewFontSize={previewFontSize}
                  darkMode={darkMode}
                  onMermaidRender={(result) => {
                    if (result.failed > 0 || result.limited > 0) setStatus(`Mermaid：${result.rendered} 个已渲染，${result.failed + result.limited} 个未完成。`);
                  }}
                  onErrorCapture={handlePreviewImageError}
                  onLoadCapture={handlePreviewImageLoad}
                />
              </div>
            </section>
          ) : (
            <WelcomeScreen onNew={() => void newFile()} onOpen={() => void openFile()} onOpenFolder={() => void openFolder()} recentFiles={recentFiles} onOpenRecent={(recentId) => void openRecentFile(recentId)} />
          )}
        </section>
      </div>

      {searchOpen && <section className="search-panel" role="search" aria-label={searchReplaceOpen ? "查找和替换" : "查找"}>
        <div className="search-row"><input ref={searchInputRef} value={searchQuery} placeholder="查找…" aria-label="查找文本" onChange={(event) => { setSearchQuery(event.target.value); searchIndexRef.current = -1; }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); findInCurrentView(event.shiftKey ? -1 : 1); } }} /><button type="button" title="上一个" onClick={() => findInCurrentView(-1)}>↑</button><button type="button" title="下一个" onClick={() => findInCurrentView(1)}>↓</button><span className="search-count">{searchResult.total ? `${searchResult.index}/${searchResult.total}` : "无结果"}</span><button type="button" className="search-close" aria-label="关闭查找" onClick={() => { setSearchOpen(false); clearSearch(); }}>×</button></div>
        {searchReplaceOpen && <div className="search-row"><input value={replaceText} placeholder="替换为…" aria-label="替换文本" onChange={(event) => setReplaceText(event.target.value)} /><button type="button" disabled={editorMode !== "source" || !searchQuery} onClick={() => { const changed = markdownEditorRef.current?.replaceCurrent(searchQuery, replaceText) ?? false; setStatus(changed ? "已替换当前匹配。" : "当前选择不是匹配文本，请先查找。"); findInCurrentView(1); }}>替换</button><button type="button" disabled={editorMode !== "source" || !searchQuery} onClick={() => { const count = markdownEditorRef.current?.replaceAll(searchQuery, replaceText) ?? 0; setStatus(count > 0 ? `已替换 ${count} 处匹配。` : "没有可替换的匹配。"); searchIndexRef.current = -1; findInCurrentView(1); }}>全部替换</button><small>{editorMode === "source" ? "仅源代码模式可替换" : "切换到源代码模式后可替换"}</small></div>}
      </section>}

      {wechatReplacements && (
        <aside className="wechat-replacements" aria-label="公众号发布验收助手">
          <div className="replacement-header">
            <strong>公众号发布验收助手 · {wechatThemes.find((theme) => theme.id === wechatReplacements.themeId)?.name ?? WECHAT_THEME_OPTIONS.find((theme) => theme.id === wechatReplacements.themeId)?.name ?? "微信原生增强"}</strong>
            <span>{confirmedReplacementIds.size}/{wechatReplacements.items.length} 已确认替换</span>
            <button type="button" className="replacement-close" onClick={() => {
              setWechatReplacements(null);
              setCopiedReplacementIds(new Set());
              setConfirmedReplacementIds(new Set());
              setWechatAcceptance(createEmptyWechatAcceptance());
            }}>关闭</button>
          </div>
          {wechatReplacements.omittedCount > 0 && <div className="replacement-warning">本任务已批准省略 {wechatReplacements.omittedCount} 项资源，属于部分完成，不能视为完整成功。</div>}
          {wechatReplacements.suggestedTitle && <div className="replacement-notice"><strong>公众号标题：</strong><code>{wechatReplacements.suggestedTitle}</code><small>首个一级标题已从复制的正文中移除，请将此标题填入公众号标题栏，避免正文重复。</small></div>}
          <div className="replacement-warning"><strong>不要再使用公众号“一键排版”。</strong>它可能覆盖 fantastic-editor 的样式，并破坏编号列表、任务项和代码块。</div>
          <div className="replacement-auto-draft">
            <div className="auto-draft-actions">
              <button type="button" className="auto-draft-button" disabled={outputBusy || wechatReplacements.omittedCount > 0} onClick={() => void createWechatDraft()}>一键同步到公众号草稿箱</button>
              <button type="button" className="publish-wechat-button" data-testid="publish-wechat-button" disabled={outputBusy || wechatReplacements.omittedCount > 0} onClick={() => void publishWechatArticle()}>一键发布到公众号</button>
            </div>
            <small>{wechatApiConfig.configured
              ? `配置已就绪 · AppID ${wechatApiConfig.appId.slice(0, 4)}…${wechatApiConfig.appId.slice(-4)} · 封面 ${wechatApiConfig.coverDisplayName ?? "已选择"}`
              : "尚未完成公众号 AppID、AppSecret 和默认封面配置。"}</small>
            <small>草稿同步会自动上传全部正文图片、公式和 Mermaid 图片；“一键发布”会在确认后直接提交微信发布并轮询结果。</small>
            {wechatDraftFeedback && <p className={`wechat-draft-feedback is-${wechatDraftFeedback.kind}`} role="status" aria-live="polite">{wechatDraftFeedback.message}</p>}
          </div>
          <label className="acceptance-step"><input type="checkbox" checked={wechatAcceptance.bodyPasted} onChange={(event) => setWechatAcceptanceField("bodyPasted", event.target.checked)} /><span><strong>1. 正文已粘贴到公众号编辑器</strong><small>复制成功只代表系统剪贴板已有正文，需要在公众号后台实际粘贴。</small></span></label>
          {wechatReplacements.items.length > 0 ? (
            <div className="replacement-list">
              {wechatReplacements.items.map((item) => {
                const copied = copiedReplacementIds.has(item.itemId);
                const confirmed = confirmedReplacementIds.has(item.itemId);
                return (
                  <div className={`replacement-item${confirmed ? " is-confirmed" : ""}`} key={item.itemId}>
                    <span className="replacement-number">{String(item.sequence).padStart(2, "0")}</span>
                    <span className="replacement-description">
                      {item.kind === "formula" ? "公式" : item.kind === "diagram" ? "流程图" : "图片"}：{item.label}
                      <code>{item.placeholderText}</code>
                      <small>{item.placement === "inline" ? "行内替换：完整选中标记后直接粘贴，不要换行，前后文字应保持同一段。" : "块级替换：完整选中整段标记后粘贴，不要把图片贴在标记旁边。"}</small>
                      <small>原文字符位置 {item.sourceOffset} · {item.mimeType}{item.width && item.height ? ` · ${item.width}×${item.height}` : ""}</small>
                    </span>
                    <button type="button" onClick={() => void copyWechatReplacement(item)}>{copied ? "重新复制" : "复制此图片"}</button>
                    <label><input type="checkbox" disabled={!copied || !wechatAcceptance.bodyPasted} checked={confirmed} onChange={() => toggleReplacementConfirmed(item.itemId)} />图片已出现且占位文字已消失</label>
                  </div>
                );
              })}
            </div>
          ) : <div className="replacement-empty">本文没有需要逐项替换的图片、公式或流程图。</div>}
          <div className="acceptance-checklist">
            <label className="acceptance-step"><input type="checkbox" disabled={!wechatAcceptanceGates.canConfirmDraftSaved} checked={wechatAcceptance.draftSaved} onChange={(event) => setWechatAcceptanceField("draftSaved", event.target.checked)} /><span><strong>2. 已保存公众号草稿</strong><small>必须先粘贴正文并完成全部替换项。</small></span></label>
            <label className="acceptance-step"><input type="checkbox" disabled={!wechatAcceptanceGates.canConfirmDraftReopened} checked={wechatAcceptance.draftReopened} onChange={(event) => setWechatAcceptanceField("draftReopened", event.target.checked)} /><span><strong>3. 已重新打开草稿复核</strong><small>确认格式和图片仍然存在且正确，并且所有 FE 占位文字均已消失。</small></span></label>
            <label className="acceptance-step"><input type="checkbox" disabled={!wechatAcceptanceGates.canConfirmMobilePreview} checked={wechatAcceptance.mobilePreviewed} onChange={(event) => setWechatAcceptanceField("mobilePreviewed", event.target.checked)} /><span><strong>4. 已完成移动端预览</strong><small>检查字体、表格、代码、公式和图片在手机上的可读性。</small></span></label>
          </div>
          <div className={`replacement-check${wechatAcceptanceGates.completed ? " is-complete" : ""}`}>
            {wechatAcceptanceGates.completed
              ? `本地验收清单已完成${wechatReplacements.omittedCount > 0 ? "，但任务含已批准省略项" : ""}；这仍不代表文章已发布。`
              : "应用无法读取公众号最终草稿；请按顺序完成并人工确认以上步骤。"}
          </div>
          <button type="button" className="acceptance-save" disabled={!wechatAcceptanceGates.completed} onClick={() => void saveWechatAcceptanceReport()}>保存人工验收记录</button>
        </aside>
      )}
      {diagnostics.length > 0 && <aside className="diagnostics" role="region" aria-live="polite" aria-atomic="true" aria-label="文档诊断"><div className="diagnostics-header"><strong>文档诊断 · {diagnostics.length} 项</strong><span><button type="button" onClick={retryPreview}>重新解析</button><button type="button" onClick={() => setDiagnostics([])}>清除提示</button></span></div>{diagnostics.map((item) => <div key={item}>{item}</div>)}</aside>}
      {wechatThemePreviewOpen && active && (
        <WechatThemePreview
          html={previewHtml}
          themeId={wechatThemeId}
          themes={wechatThemes}
          definition={wechatThemeResolved.definition}
          fontFamily={previewFontStack(previewFontName)}
          onThemeChange={setWechatThemeId}
          onSaveAsCustom={saveWechatThemeAsCustom}
          onDeleteCustom={deleteWechatTheme}
          onExportCustom={() => void exportWechatTheme()}
          onImportCustom={(storage) => void importWechatTheme(storage)}
          onClose={closeWechatThemePreview}
        />
      )}
      <WechatApiConfigDialog
        open={wechatApiConfigOpen}
        config={wechatApiConfig}
        onClose={closeWechatApiConfig}
        onSaved={applySavedWechatApiConfig}
      />
      <footer className="statusbar"><span className="status-message" role="status" aria-live="polite" aria-atomic="true"><i />{status}{previewRetryAvailable && <button type="button" className="status-retry" onClick={retryPreview}>重新解析</button>}</span><span className="status-meta"><span>{active ? (editorMode === "source" ? "Markdown · 源代码" : "Markdown · 所见即所得") : "本地模式"}</span><span>{draft.length.toLocaleString()} 字符</span>{documentPerformance && <span className={`performance-metric is-${documentPerformance.level}`} title={documentPerformanceDescription(documentPerformance)} aria-label={documentPerformanceDescription(documentPerformance)}>{documentPerformanceLabel(documentPerformance)}</span>}</span></footer>
      {dragActive && <div className="drop-overlay"><div className="drop-card"><span className="drop-icon"><Icon name="download" size={30} /></span><strong>释放以打开文档或插入图片</strong><span>Markdown 可在窗口打开；图片请放到编辑区的具体位置</span></div></div>}
    </main>
  );
}
