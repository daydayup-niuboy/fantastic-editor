import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type SetStateAction, type SyntheticEvent } from "react";
import { OFFICIAL_WECHAT_THEME_IDS, WECHAT_CUSTOM_THEME_ID_RE, WECHAT_THEME_OPTIONS, resolveOfficialWechatTheme, type AiActionId, type AiProviderId, type AiProviderStatus, type OpenAiCompatibleConfigSummary, type OpenAiCompatibleModelSlot, type AiTextAnchor, type DocumentHistoryItem, type OpenFileResult, type OpenFolderResult, type OutputCommandResult, type PersistRecoveryRequest, type PreviewDerivedUpdate, type PreviewSession, type RecentFileEntry, type ResolvedWechatTheme, type WechatApiConfigSummary, type WechatReplacementItem, type WechatThemeDefinition, type WechatThemeId, type WechatThemeListItem, type WechatThemeOverlayInput, type WorkspaceFileEntry } from "@fantastic-editor/shared";
import { Icon } from "./Icon";
import { FixedAiProviderConfig } from "./FixedAiProviderConfig";
import { MarkdownEditor, type MarkdownEditorHandle } from "./MarkdownEditor";
import { SynchronizedPreview, type SynchronizedPreviewHandle } from "./SynchronizedPreview";
import { applyResolutionToPreviewHtml } from "./preview-assets";
import { applyPreviewDerivedUpdate, createPreviewSession, formatDiagnosticItems, type FormattedDiagnostic } from "./preview-session";
import { liveImageLoadFailureRange, type LiveImageLoadFailure } from "./live-preview-images";
import { ParseWorkerClient } from "./workers/parse-worker-client";
import { WelcomeScreen } from "./WelcomeScreen";
import { EditorRuler } from "./EditorRuler";
import { DEFAULT_PREVIEW_FONT, PREVIEW_FONT_PRESETS, DEFAULT_PREVIEW_FONT_SIZE, DEFAULT_READING_WIDTH, READING_WIDTH_OPTIONS, commitPreviewFontDraft, MIN_PREVIEW_FONT_SIZE, MAX_PREVIEW_FONT_SIZE, DEFAULT_READING_WIDTH_PX, normalizePreviewFontName, normalizePreviewFontSize, normalizeReadingWidth, normalizeReadingWidthPx, previewFontStack, readingWidthMaxWidth, readingWidthPxFromPreset, type ReadingWidth } from "./preview-font";
import { computeWechatAcceptanceGates, createEmptyWechatAcceptance, updateWechatAcceptance, type WechatAcceptanceProgress } from "./wechat-acceptance";
import { WechatThemePreview } from "./WechatThemePreview";
import { WechatApiConfigDialog } from "./WechatApiConfigDialog";
import { clampSidebarWidth, clampSplitRatio, clampWechatInspectorWidth, DEFAULT_SIDEBAR_WIDTH, DEFAULT_WECHAT_INSPECTOR_WIDTH, MAX_SIDEBAR_WIDTH, MAX_SPLIT_RATIO, MAX_WECHAT_INSPECTOR_WIDTH, MIN_SIDEBAR_WIDTH, MIN_SPLIT_RATIO, MIN_WECHAT_INSPECTOR_WIDTH, sidebarWidthForKey, splitRatioForKey, wechatInspectorWidthForKey } from "./accessibility";
import { adjacentTabIndex, moveTabIndexForKey, moveTabItem, tabIndexForNavigationKey } from "./tab-navigation";
import { createDocumentPerformanceSnapshot, documentPerformanceDescription, documentPerformanceLabel, type DocumentPerformanceSnapshot } from "./document-performance";
import { isFileDrag } from "./drag-intent";
import { extractDocumentOutline, type OutlineEntry } from "./document-outline";
import { DocumentOutline } from "./DocumentOutline";
import { clearVisibleTextSearch, type SearchNavigationResult } from "./visible-text-search";
import { nextWebMarkdownRepairSource, repairWebMarkdown, unwrapMarkdownDocumentFence } from "./web-markdown-repair";
import { applySmartPunctuation, writingStatistics } from "./writing-tools";
import { syncAiComparisonScroll } from "./ai-comparison-scroll";
import { suggestionDiffSegments } from "./ai-suggestion-diff";
import { exceedsAiInputLimit, translationInstruction, type TranslationLanguageId } from "./selection-translation";
import packageMetadata from "../../../../../package.json";

interface ActiveDocument {
  sessionId: string;
  documentId: string;
  displayName: string;
  savedText: string;
  workspaceRevision: number;
  workspaceFileId: string | null;
  isUntitled: boolean;
  importedStructured: boolean;
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
const PREVIEW_FONT_LABELS: Record<(typeof PREVIEW_FONT_PRESETS)[number], string> = {
  "Microsoft YaHei UI": "微软雅黑（默认）",
  "Segoe UI Variable Text": "Segoe UI",
  Arial: "Arial",
  DengXian: "等线",
  SimSun: "宋体",
  KaiTi: "楷体",
};
const CUSTOM_FONT_ACTION = "__select_custom_font__";
const messageDiagnostics = (messages: readonly string[]): FormattedDiagnostic[] => messages.map((text, index) => ({ key: `message-${index}-${text}`, text, severity: "info" }));
const EMPTY_WECHAT_API_CONFIG: WechatApiConfigSummary = {
  appId: "",
  hasAppSecret: false,
  coverPath: "",
  coverDisplayName: null,
  configured: false,
  source: "none",
};
const AI_ACTIONS: Array<{ id: AiActionId; label: string; help: string }> = [
  { id: "polish", label: "润色", help: "改善表达和语气，保留原意与 Markdown 结构。" },
  { id: "deai", label: "去AI味", help: "润色之后用：去掉套话和机械腔，保留原意、事实与 Markdown 结构。" },
  { id: "rewrite", label: "改写", help: "重新组织文字和表达方式，不改变事实。" },
  { id: "condense", label: "精简", help: "删除重复和赘述，保留关键信息。" },
  { id: "expand", label: "扩写", help: "补充必要说明，但不编造事实。" },
  { id: "correct", label: "纠错", help: "修正错别字、语病和标点，尽量少改原文。" },
  { id: "continue", label: "续写", help: "保留原文，并在原文后继续写作。" },
  { id: "title", label: "标题", help: "生成一级标题并放到原文前，不删除原文。" },
  { id: "summarize", label: "摘要", help: "提炼当前选区或段落；应用后会用摘要替换原内容。" },
  { id: "custom", label: "自定义", help: "按你填写的要求处理当前选区或段落；指令仅发送本次，不会保存。" },
];
function flashConfigMessage(setter: Dispatch<SetStateAction<string>>, message: string): void {
  setter(message);
  window.setTimeout(() => setter((current) => current === message ? "" : current), 5_000);
}
function newAiRequestId(): string {
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (digit) =>
    (Number(digit) ^ crypto.getRandomValues(new Uint8Array(1))[0]! & 15 >> Number(digit) / 4).toString(16));
}
export function aiDisclosureStorageKey(providerId: AiProviderId): string { return `fantastic-editor-ai-disclosure-accepted:${providerId}`; }

/**
 * 未命名文档的标签显示名：取正文首个非空行并去掉 Markdown 标记。
 * 只影响标签文字。未命名文档的首行升 H1 由 untitled-heading 在粘贴或标题换行时处理。
 */
export function firstLineDisplayName(text: string): string | null {
  for (const rawLine of text.split("\n")) {
    const stripped = rawLine.replace(/^#{1,6}\s*/, "").replace(/^[>*+-]\s+/, "").trim();
    if (stripped) return [...stripped].slice(0, 40).join("");
  }
  return null;
}

export function App() {
  const [active, setActive] = useState<ActiveDocument | null>(null);
  const [tabs, setTabs] = useState<DocumentTab[]>([]);
  const tabsRef = useRef<DocumentTab[]>([]);
  const [workspace, setWorkspace] = useState<ActiveWorkspace | null>(null);
  const [recentFiles, setRecentFiles] = useState<RecentFileEntry[]>([]);
  const [draft, setDraft] = useState(EMPTY_DOCUMENT);
  const draftRef = useRef(EMPTY_DOCUMENT);
  const [webMarkdownRepairSource, setWebMarkdownRepairSource] = useState<string | null>(null);
  const [previewHtml, setPreviewHtml] = useState("<h1>fantastic-editor</h1><p>打开一个本地 Markdown 文件，开始编辑。</p>");
  const [previewHtmlReady, setPreviewHtmlReady] = useState(false);
  const parseWorkerRef = useRef<ParseWorkerClient | null>(null);
  const markdownEditorRef = useRef<MarkdownEditorHandle | null>(null);
  const synchronizedPreviewRef = useRef<SynchronizedPreviewHandle | null>(null);
  const exportMenuSummaryRef = useRef<HTMLElement | null>(null);
  const exportMenuPendingRef = useRef(false);
  const mainAreaRef = useRef<HTMLElement | null>(null);
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
  const [diagnostics, setDiagnostics] = useState<FormattedDiagnostic[]>([]);
  const diagnosticIndexRef = useRef(-1);
  const [status, setStatus] = useState("准备就绪");
  const [previewRetryAvailable, setPreviewRetryAvailable] = useState(false);
  const [documentPerformance, setDocumentPerformance] = useState<DocumentPerformanceSnapshot | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(() => clampSidebarWidth(Number(window.localStorage.getItem("fantastic-editor-sidebar-width") ?? DEFAULT_SIDEBAR_WIDTH)));
  const [wechatInspectorWidth, setWechatInspectorWidth] = useState(() => clampWechatInspectorWidth(Number(window.localStorage.getItem("fantastic-editor-wechat-inspector-width") ?? DEFAULT_WECHAT_INSPECTOR_WIDTH)));
  const [aiInspectorWidth, setAiInspectorWidth] = useState(() => clampWechatInspectorWidth(Number(window.localStorage.getItem("fantastic-editor-ai-inspector-width") ?? DEFAULT_WECHAT_INSPECTOR_WIDTH)));
  const [viewMode, setViewMode] = useState<"editor" | "split">(() => window.localStorage.getItem("fantastic-editor-editor-mode") === "source" ? "split" : "editor");
  const [editorMode, setEditorMode] = useState<"source" | "wysiwyg">(() => window.localStorage.getItem("fantastic-editor-editor-mode") === "source" ? "source" : "wysiwyg");
  const [focusMode, setFocusMode] = useState(false);
  const [typewriterMode, setTypewriterMode] = useState(false);
  const [spellCheck, setSpellCheck] = useState(() => window.localStorage.getItem("fantastic-editor-spellcheck") !== "false");
  const [liveLinkInputOpen, setLiveLinkInputOpen] = useState(false);
  const [liveLinkUrl, setLiveLinkUrl] = useState("");
  const previousSourceViewModeRef = useRef<"editor" | "split">("split");
  const [splitRatio, setSplitRatio] = useState(50);
  const [darkMode, setDarkMode] = useState(() => window.localStorage.getItem("fantastic-editor-theme") === "dark");
  const [syncScrollEnabled, setSyncScrollEnabled] = useState(() => window.localStorage.getItem("fantastic-editor-sync-scroll") === "true");
  const [previewFontName, setPreviewFontName] = useState(() => normalizePreviewFontName(window.localStorage.getItem("fantastic-editor-preview-font") ?? DEFAULT_PREVIEW_FONT));
  const [previewFontDraft, setPreviewFontDraft] = useState(previewFontName);
  const [readingWidth, setReadingWidth] = useState<ReadingWidth>(() => normalizeReadingWidth(window.localStorage.getItem("fantastic-editor-reading-width") ?? DEFAULT_READING_WIDTH));
  const [readingWidthPx, setReadingWidthPx] = useState(() => normalizeReadingWidthPx(window.localStorage.getItem("fantastic-editor-reading-width-px") ?? DEFAULT_READING_WIDTH_PX));
  const [previewFontSize, setPreviewFontSize] = useState(() => normalizePreviewFontSize(window.localStorage.getItem("fantastic-editor-preview-font-size") ?? DEFAULT_PREVIEW_FONT_SIZE));
  const [outlineDocument, setOutlineDocument] = useState<PreviewSession["parsedDocument"] | null>(null);
  const [expandedOutlineSessionId, setExpandedOutlineSessionId] = useState<string | null>(null);
  const [sidebarPanel, setSidebarPanel] = useState<"explorer" | "outline" | "ai-providers">("explorer");
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchReplaceOpen, setSearchReplaceOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const [searchWholeWord, setSearchWholeWord] = useState(false);
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyItems, setHistoryItems] = useState<DocumentHistoryItem[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiProviders, setAiProviders] = useState<AiProviderStatus[]>([]);
  const [aiProviderId, setAiProviderId] = useState<AiProviderId>("codex-cli");
  const [aiAction, setAiAction] = useState<AiActionId>("polish");
  const [aiCustomInstruction, setAiCustomInstruction] = useState("");
  const aiOriginalScrollRef = useRef<HTMLTextAreaElement | null>(null);
  const aiSuggestionScrollRef = useRef<HTMLElement | null>(null);
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [customProviderName, setCustomProviderName] = useState("");
  const [customLocalName, setCustomLocalName] = useState("");
  const [customApiKey, setCustomApiKey] = useState("");
  const [customModelSlots, setCustomModelSlots] = useState<[OpenAiCompatibleModelSlot | null, OpenAiCompatibleModelSlot | null]>([null, null]);
  const [customModelOptions, setCustomModelOptions] = useState<string[]>([]);
  const [customConfigured, setCustomConfigured] = useState(false);
  const [customConfigLoaded, setCustomConfigLoaded] = useState(false);
  const [customConfigOpen, setCustomConfigOpen] = useState(false);
  const [customConfigBusy, setCustomConfigBusy] = useState(false);
  const [customConfigMessage, setCustomConfigMessage] = useState("");
  const [aiModelSlot, setAiModelSlot] = useState<0 | 1>(0);
  const [aiComparisonRatio, setAiComparisonRatio] = useState(50);
  const [aiChromeCollapsed, setAiChromeCollapsed] = useState(false);
  const [aiRequest, setAiRequest] = useState<{ requestId: string; anchor: AiTextAnchor; scope: "selection" | "block"; status: "working" | "ready" | "stale" | "applied" | "failed"; result?: string; error?: string } | null>(null);
  const [selectionTranslationBusy, setSelectionTranslationBusy] = useState(false);
  const selectionTranslationRequestRef = useRef<string | null>(null);
  const selectionTranslationCompletionRef = useRef<Promise<void> | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const commandInputRef = useRef<HTMLInputElement | null>(null);
  const [wechatThemeInWysiwyg, setWechatThemeInWysiwyg] = useState(() => window.localStorage.getItem("fantastic-editor-wechat-theme-wysiwyg") === "true");
  const [aiEditorThemeDefinition, setAiEditorThemeDefinition] = useState<WechatThemeDefinition | null>(null);
  const wechatThemeBeforeAiRef = useRef(wechatThemeInWysiwyg);
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
  const externalChangeCheckBusyRef = useRef(false);
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
  const applyDraftChange = useCallback((value: string, pasted = false) => {
    draftRef.current = value;
    setWebMarkdownRepairSource((current) => nextWebMarkdownRepairSource(current, pasted, value));
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
  const [statsDraft, setStatsDraft] = useState(draft);
  useEffect(() => {
    const timer = window.setTimeout(() => setStatsDraft(draft), 300);
    return () => window.clearTimeout(timer);
  }, [draft]);
  const writingStats = useMemo(() => writingStatistics(statsDraft), [statsDraft]);
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

  // Ctrl + 滚轮缩放编辑区显示：只改屏幕字号（12–24px），不写进 Markdown 或导出结果。
  useEffect(() => {
    const node = mainAreaRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey || event.deltaY === 0) return;
      event.preventDefault();
      setPreviewFontSize((value) => normalizePreviewFontSize(value + (event.deltaY < 0 ? 1 : -1)));
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    window.localStorage.setItem("fantastic-editor-preview-font", previewFontName);
    setPreviewFontDraft(previewFontName);
  }, [previewFontName]);

  useEffect(() => { window.localStorage.setItem("fantastic-editor-reading-width", readingWidth); }, [readingWidth]);
  useEffect(() => { window.localStorage.setItem("fantastic-editor-reading-width-px", String(readingWidthPx)); }, [readingWidthPx]);
  useEffect(() => { window.localStorage.setItem("fantastic-editor-preview-font-size", String(previewFontSize)); }, [previewFontSize]);
  useEffect(() => { window.localStorage.setItem("fantastic-editor-spellcheck", String(spellCheck)); }, [spellCheck]);
  useEffect(() => { window.localStorage.setItem("fantastic-editor-sidebar-width", String(sidebarWidth)); }, [sidebarWidth]);
  useEffect(() => { window.localStorage.setItem("fantastic-editor-wechat-inspector-width", String(wechatInspectorWidth)); }, [wechatInspectorWidth]);
  useEffect(() => { window.localStorage.setItem("fantastic-editor-ai-inspector-width", String(aiInspectorWidth)); }, [aiInspectorWidth]);
  useEffect(() => { exportMenuPendingRef.current = false; }, [active?.sessionId]);
  useEffect(() => {
    if (!active || !outputReady || outputBusy || !previewSessionRef.current || !exportMenuPendingRef.current) return;
    exportMenuPendingRef.current = false;
    exportMenuSummaryRef.current?.click();
  }, [active, outputReady, outputBusy]);

  useEffect(() => {
    window.localStorage.setItem("fantastic-editor-wechat-theme", wechatThemeId);
  }, [wechatThemeId]);

  useEffect(() => {
    window.localStorage.setItem("fantastic-editor-wechat-theme-wysiwyg", String(wechatThemeInWysiwyg));
  }, [wechatThemeInWysiwyg]);
  useEffect(() => {
    setAiEditorThemeDefinition(null);
    wechatThemeBeforeAiRef.current = wechatThemeInWysiwyg;
  }, [active?.documentId]);

  useEffect(() => {
    const acceptDerivedUpdate = (update: PreviewDerivedUpdate): boolean => {
      const current = previewSessionRef.current;
      if (!current) return false;
      const merged = applyPreviewDerivedUpdate(current, update);
      if (merged.status !== "accepted") return false;
      previewSessionRef.current = merged.session;
      setPreviewHtml(applyResolutionToPreviewHtml(basePreviewHtmlRef.current, merged.session));
      setDiagnostics(formatDiagnosticItems(merged.session.diagnostics));
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
        const parseDiagnostics = formatDiagnosticItems(response.diagnostics);
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
            ...(response.parsedDocument.svgContents ? { svgContents: response.parsedDocument.svgContents } : {}),
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
          setDiagnostics(formatDiagnosticItems(session.diagnostics));
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
      ? { sessionId: cached.sessionId, documentId: cached.documentId, displayName: cached.displayName, savedText: cached.savedText, workspaceRevision: cached.workspaceRevision, workspaceFileId: cached.workspaceFileId, isUntitled: cached.isUntitled, importedStructured: cached.importedStructured, requiresSave: cached.requiresSave }
      : {
          sessionId: result.session.sessionId,
          documentId: result.session.documentId,
          displayName: result.session.displayName,
          savedText: result.session.savedText ?? result.session.editorText,
          workspaceRevision: result.session.workspaceRevision,
          workspaceFileId,
          isUntitled: result.session.isUntitled,
          importedStructured: result.session.importedStructured ?? false,
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
    setWebMarkdownRepairSource(draftRef.current);
    window.requestAnimationFrame(() => markdownEditorRef.current?.focus());
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
    setDiagnostics(messageDiagnostics(result.workspace.warnings));
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

  const repairCurrentWebMarkdown = useCallback(() => {
    if (!active) {
      setStatus("请先新建或打开一个 Markdown 文件。");
      return;
    }
    const source = draftRef.current;
    const repaired = repairWebMarkdown(source);
    if (!repaired.changed) {
      setStatus("未检测到可安全修复的网页 Markdown 结构。");
      return;
    }
    const summary = [
      `结构标记/网页空格 ${repaired.repairedMarkers} 处`,
      `成对行内格式 ${repaired.repairedInlinePairs} 处`,
      `多余空行 ${repaired.removedBlankLines} 处`,
      `表格断行 ${repaired.repairedTableGaps} 处`,
    ].join("、");
    const next = markdownEditorRef.current?.applyTextChange({
      from: 0,
      to: source.length,
      insert: repaired.markdown,
      expectedText: source,
    }) ?? null;
    if (next === null) {
      setStatus("网页 Markdown 修复未执行：文档版本已经变化。");
      return;
    }
    // 修复后的普通输入不应再次弹出同一提示；下一次打开文档或粘贴时才重新检测。
    setWebMarkdownRepairSource(null);
    setStatus(`网页 Markdown 已修复：${summary}；可用一次撤销恢复。`);
  }, [active]);

  const markdownDocumentFence = useMemo(
    () => active ? unwrapMarkdownDocumentFence(draft) : { markdown: draft, detected: false },
    [active, draft],
  );
  const webMarkdownRepair = useMemo(
    () => active && webMarkdownRepairSource !== null && !markdownDocumentFence.detected ? repairWebMarkdown(webMarkdownRepairSource) : null,
    [active, markdownDocumentFence.detected, webMarkdownRepairSource],
  );
  const markdownRepairDetected = markdownDocumentFence.detected || Boolean(webMarkdownRepair?.changed);

  const convertDetectedMarkdown = useCallback(() => {
    const source = draftRef.current;
    const detected = unwrapMarkdownDocumentFence(source);
    if (!detected.detected) {
      setStatus("正文已经变化，未再检测到 Markdown 包装。");
      return;
    }
    const next = markdownEditorRef.current?.applyTextChange({
      from: 0,
      to: source.length,
      insert: detected.markdown,
      expectedText: source,
    }) ?? null;
    setStatus(next === null ? "Markdown 转换未执行：文档版本已经变化。" : "已转换为正常 Markdown，可按 Ctrl+Z 一次撤销。");
  }, []);

  const smartenPunctuation = useCallback(() => {
    const source = draftRef.current;
    const nextText = applySmartPunctuation(source);
    if (nextText === source) { setStatus("没有检测到可安全转换的普通正文标点。"); return; }
    const changed = markdownEditorRef.current?.replaceDocument(source, nextText) ?? false;
    setStatus(changed ? "已完成智能标点转换；代码、链接和代码围栏保持不变，可按 Ctrl+Z 撤销。" : "智能标点未执行：文档版本已经变化。");
  }, []);

  const saveAs = useCallback(async (): Promise<ActiveDocument | null> => {
    if (!active) { setStatus("请先新建或打开一个 Markdown 文件"); return null; }
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
        importedStructured: false,
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
  }, [active, updateTabs]);

  const save = useCallback(async () => {
    if (!active) { setStatus("请先新建或打开一个 Markdown 文件"); return; }
    if (active.isUntitled && !active.importedStructured) { await saveAs(); return; }
    const editorText = draftRef.current;
    const result = await window.fantasticEditor.saveCurrentFile({ sessionId: active.sessionId, editorText });
    if (result.status === "saved") {
      const savedAsMarkdown = result.saveMode === "markdown";
      const next = {
        ...active,
        displayName: savedAsMarkdown ? result.displayName ?? active.displayName : active.displayName,
        savedText: editorText,
        requiresSave: false,
        workspaceRevision: result.workspaceRevision ?? active.workspaceRevision,
        isUntitled: savedAsMarkdown ? false : active.isUntitled,
        importedStructured: savedAsMarkdown ? false : active.importedStructured,
      };
      setActive(next);
      updateTabs((current) => current.map((tab) => tab.sessionId === active.sessionId ? { ...tab, ...next, draft: editorText } : tab));
      if (savedAsMarkdown && result.workspaceMode === "single-file") setWorkspace(null);
      setStatus(result.saveMode === "original" ? `已按原格式保存 ${result.displayName ?? active.displayName}` : `已保存 ${result.displayName ?? active.displayName}`);
    } else setStatus(result.error ?? "保存未完成");
  }, [active, saveAs, updateTabs]);

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
      if (diagnostics.length > 0) setDiagnostics(formatDiagnosticItems(diagnostics));
      return;
    }
    setStatus(result.error ?? "导出失败，请查看诊断信息。");
    if (result.result?.diagnostics.length) {
      setDiagnostics(formatDiagnosticItems(result.result.diagnostics));
    }
  }, []);

  const exportDocument = useCallback(async (target: "offline-html" | "docx" | "pdf" | "wechat-clipboard") => {
    const session = previewSessionRef.current;
    if (!active || !outputReady || !session) {
      setStatus("当前草稿尚未完成解析和资源解析，请稍候再导出。");
      return;
    }
    if (target !== "wechat-clipboard") setOutputBusy(true);
    setStatus(target === "docx" ? "正在预检 Word 导出……" : target === "pdf" ? "正在预检 PDF 导出……" : target === "wechat-clipboard" ? "正在生成公众号复制内容……" : "正在预检离线 HTML 导出……");
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
        ...((active.isUntitled ? firstLineDisplayName(draft) ?? active.displayName : active.displayName) ? { suggestedBaseName: active.isUntitled ? firstLineDisplayName(draft) ?? active.displayName : active.displayName } : {}),
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
  }, [active, darkMode, describeOutputResult, draft, outputReady, previewFontName, wechatThemeId]);

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
        if (result.uploadedImageCount) setDiagnostics(messageDiagnostics([`已上传 ${result.uploadedImageCount} 项图片，但草稿尚未创建。`]));
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
    setActive({ sessionId: tab.sessionId, documentId: tab.documentId, displayName: tab.displayName, savedText: tab.savedText, workspaceRevision: tab.workspaceRevision, workspaceFileId: tab.workspaceFileId, isUntitled: tab.isUntitled, importedStructured: tab.importedStructured, requiresSave: tab.requiresSave });
    draftRef.current = tab.draft;
    setDraft(tab.draft);
    setWebMarkdownRepairSource(tab.draft);
    window.requestAnimationFrame(() => markdownEditorRef.current?.focus());
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
          importedStructured: session.importedStructured ?? false,
          requiresSave: session.requiresSave ?? false,
          draft: session.editorText,
        }];
      });
      updateTabs(() => restoredTabs);
      setWorkspace(null);
      const target = restoredTabs.find((tab) => tab.sessionId === result.activeSessionId) ?? restoredTabs.at(-1);
      if (target) presentTab(target);
      setDiagnostics(messageDiagnostics(result.warnings));
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
    const result = await window.fantasticEditor.activateFileSession({ sessionId: tab.sessionId });
    if (result.status === "failed") { setStatus(result.error); return; }
    presentTab(tab);
    setStatus(`已切换到 ${tab.displayName}`);
  }, [active?.sessionId, presentTab]);

  useEffect(() => {
    if (!active || active.isUntitled) return;
    const check = async () => {
      if (externalChangeCheckBusyRef.current) return;
      externalChangeCheckBusyRef.current = true;
      try {
        const result = await window.fantasticEditor.checkExternalFileChange({ sessionId: active.sessionId });
        if (result.status === "save-as") { await saveAs(); return; }
        if (result.status === "kept") { setStatus("已保留编辑器中的内容；保存前仍会再次确认外部修改冲突。"); return; }
        if (result.status === "missing") { setStatus("磁盘文件已不存在；当前编辑内容仍保留，请使用“另存为”。"); return; }
        if (result.status === "failed") { setStatus(result.error ?? "检查外部文件变化失败。"); return; }
        if (result.status !== "reloaded") return;
        const previous = draftRef.current;
        if (!markdownEditorRef.current?.replaceDocument(previous, result.editorText)) { setStatus("正文已变化，未重新加载外部版本。"); return; }
        const next = { ...active, savedText: result.editorText, requiresSave: false };
        setActive(next);
        setDraft(result.editorText);
        setWebMarkdownRepairSource(result.editorText);
        draftRef.current = result.editorText;
        updateTabs((current) => current.map((tab) => tab.sessionId === active.sessionId ? { ...tab, ...next, draft: result.editorText } : tab));
        setStatus("已重新加载磁盘上的最新版本；可按 Ctrl+Z 恢复此前编辑内容。");
      } finally {
        externalChangeCheckBusyRef.current = false;
      }
    };
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [active, saveAs, updateTabs]);

  const toggleOutlineForTab = useCallback(async (tab: DocumentTab) => {
    if (active?.sessionId !== tab.sessionId) {
      await activateTab(tab);
      if (activeDocumentIdRef.current !== tab.documentId) return;
    }
    setExpandedOutlineSessionId((current) => current === tab.sessionId ? null : tab.sessionId);
  }, [activateTab, active?.sessionId]);

  const closeTab = useCallback(async (tab: DocumentTab) => {
    const currentTab = tabsRef.current.find((item) => item.sessionId === tab.sessionId) ?? tab;
    if (currentTab.requiresSave || currentTab.draft !== currentTab.savedText) {
      const message = currentTab.importedStructured
        ? `${currentTab.displayName} 来自非 Markdown 文件且尚未保存。请先点击保存并选择“按原格式保存”或“另存为 Markdown”；现在关闭会放弃当前修改，仍要关闭吗？`
        : `${currentTab.displayName} 尚未保存，确定关闭这个标签吗？`;
      if (!window.confirm(message)) return;
    }
    const result = await window.fantasticEditor.closeFileSession({ sessionId: tab.sessionId });
    if (result.status === "failed") { setStatus(result.error); return; }
    const currentTabs = tabsRef.current;
    const closedIndex = currentTabs.findIndex((item) => item.sessionId === tab.sessionId);
    const remaining = currentTabs.filter((item) => item.sessionId !== tab.sessionId);
    updateTabs(() => remaining);
    if (active?.sessionId !== tab.sessionId) return;
    if (remaining.length === 0) {
      activeDocumentIdRef.current = null;
      previewSessionRef.current = null;
      setActive(null);
      draftRef.current = EMPTY_DOCUMENT;
      setDraft(EMPTY_DOCUMENT);
      setPreviewHtml("<h1>fantastic-editor</h1><p>新建、打开或拖入一个 Markdown 文件。</p>");
      setOutputReady(false);
      queueRecoverySnapshot({ activeSessionId: null, tabs: [] });
      setStatus("已关闭全部文档");
      return;
    }
    const next = remaining[Math.min(Math.max(closedIndex, 0), remaining.length - 1)];
    if (!next) return;
    await window.fantasticEditor.activateFileSession({ sessionId: next.sessionId });
    presentTab(next);
    setStatus(`已关闭 ${tab.displayName}`);
  }, [active?.sessionId, presentTab, queueRecoverySnapshot, updateTabs]);

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
    const insertionEditor = markdownEditorRef.current;
    if (imageImportBusyRef.current) {
      if (existingAnchorId) insertionEditor?.discardInsertionAnchor(existingAnchorId);
      setStatus("已有图片导入任务正在进行，请稍候。");
      return;
    }
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
  }, [active, saveAs, updateTabs]);
  const handleDrop = useCallback(async (event: DragEvent<HTMLElement>) => {
    if (!isFileDrag(event.dataTransfer.types)) { setDragActive(false); return; }
    event.preventDefault();
    setDragActive(false);
    const allFiles = [...event.dataTransfer.files];
    const markdownFiles = allFiles.filter((file) => /\.(?:md|markdown)$/i.test(file.name));
    const imageFiles = allFiles.filter((file) => /\.(?:png|jpe?g|gif|webp|svg)$/i.test(file.name));
    const structuredFiles = allFiles.filter((file) => /\.(?:json|ya?ml|toml|html?|xml|ini|conf|config|env|properties)$/i.test(file.name));
    if (markdownFiles.length > 0 || structuredFiles.length > 0) event.stopPropagation();
    if (markdownFiles.length > 0 && imageFiles.length > 0) { setStatus("Markdown 与图片不能混合拖入，请分开操作。"); return; }
    if (imageFiles.length > 0) { setStatus("请把图片拖到 Markdown 编辑区的具体插入位置。"); return; }
    if (markdownFiles.length + structuredFiles.length !== allFiles.length) { setStatus("只能拖入 Markdown、受支持的配置文件，或将图片拖到编辑区插入。"); return; }
    let opened = 0;
    for (const file of [...markdownFiles, ...structuredFiles]) {
      const result = await window.fantasticEditor.openDroppedMarkdownFile(file);
      if (result.status === "opened") {
        if (workspace && opened === 0) { updateTabs(() => []); setWorkspace(null); }
        acceptOpenedFile(result);
        opened += 1;
      } else if (result.status === "failed") setStatus(result.error ?? "拖入文件失败。");
    }
    if (opened > 0) setStatus(`已拖入 ${opened} 个文档`);
  }, [acceptOpenedFile, updateTabs, workspace]);

  const switchEditorMode = useCallback((nextMode: "source" | "wysiwyg") => {
    if (nextMode === editorMode) return true;
    if (imageImportBusyRef.current) {
      setStatus("图片导入完成后才能切换编辑模式。");
      return false;
    }
    if (nextMode === "wysiwyg") {
      previousSourceViewModeRef.current = viewMode;
      synchronizedPreviewRef.current?.clearTransientState();
      setViewMode("editor");
      setStatus("已切换到所见即所得模式；Markdown 仍是唯一保存来源。");
      window.requestAnimationFrame(() => markdownEditorRef.current?.focus());
    } else {
      setLiveLinkInputOpen(false);
      setLiveLinkUrl("");
      setViewMode(previousSourceViewModeRef.current === "split" ? "split" : "editor");
      setStatus("已切换到源代码模式。");
      window.requestAnimationFrame(() => markdownEditorRef.current?.focus());
    }
    setEditorMode(nextMode);
    return true;
  }, [editorMode, viewMode]);

  const clearSearch = useCallback(() => {
    markdownEditorRef.current?.clearSearch?.();
    synchronizedPreviewRef.current?.clearSearch?.();
    clearVisibleTextSearch();
    searchIndexRef.current = -1;
    setSearchResult({ index: 0, total: 0 });
  }, []);

  const openSearchPanel = useCallback((replaceMode: boolean) => {
    const selected = markdownEditorRef.current?.selectedText().trim() ?? "";
    if (selected) setSearchQuery(selected);
    searchIndexRef.current = -1;
    setSearchResult({ index: 0, total: 0 });
    setSearchOpen(true);
    setSearchReplaceOpen(replaceMode);
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
  }, [viewMode]);

  const findInCurrentView = useCallback((direction = 1) => {
    const query = searchQuery.trim();
    if (!query) { clearSearch(); return; }
    const result = markdownEditorRef.current?.find(query, direction, searchIndexRef.current, { caseSensitive: searchCaseSensitive, wholeWord: searchWholeWord });
    const normalized = result ?? { index: 0, total: 0 };
    searchIndexRef.current = normalized.index > 0 ? normalized.index - 1 : -1;
    setSearchResult(normalized);
  }, [clearSearch, searchCaseSensitive, searchQuery, searchWholeWord, viewMode]);

  const revealSourceRange = useCallback((from: number, to: number) => {
    const revealed = markdownEditorRef.current?.revealSourceRange(from, to);
    return Boolean(revealed);
  }, [viewMode]);

  const revealOutlineEntry = useCallback((entry: OutlineEntry) => {
    const revealed = revealSourceRange(entry.from, entry.to);
    setStatus(revealed ? `已跳转到 ${entry.label}` : "当前视图尚未完成渲染，暂时无法跳转。请稍候再试。");
  }, [revealSourceRange]);

  const revealDiagnostic = useCallback((item: FormattedDiagnostic) => {
    if (!item.source) return;
    const revealed = revealSourceRange(item.source.from, item.source.to);
    setStatus(revealed ? `已跳转到第 ${item.source.startLine} 行。` : "当前视图尚未完成渲染，暂时无法跳转。请稍候再试。");
  }, [revealSourceRange]);

  const navigateDiagnostic = useCallback((direction: 1 | -1) => {
    const locatable = diagnostics.filter((item) => item.source);
    if (locatable.length === 0) return;
    diagnosticIndexRef.current = (diagnosticIndexRef.current + direction + locatable.length) % locatable.length;
    revealDiagnostic(locatable[diagnosticIndexRef.current]!);
  }, [diagnostics, revealDiagnostic]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && commandPaletteOpen) {
        event.preventDefault();
        setCommandPaletteOpen(false);
        setCommandQuery("");
        return;
      }
      if (event.key === "Escape" && searchOpen) {
        event.preventDefault();
        setSearchOpen(false);
        clearSearch();
        return;
      }
      if (event.key === "Escape" && wechatThemePreviewOpen) {
        event.preventDefault();
        setWechatThemePreviewOpen(false);
        window.requestAnimationFrame(() => wechatThemeButtonRef.current?.focus());
        return;
      }
      if (!event.ctrlKey) return;
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandPaletteOpen(true);
        setCommandQuery("");
        window.requestAnimationFrame(() => commandInputRef.current?.focus());
        return;
      }
      if (wechatThemePreviewOpen) return;
      if (event.key === "\\") {
        event.preventDefault();
        setSidebarVisible((current) => !current);
        return;
      }
      if (event.shiftKey && event.key.toLowerCase() === "p" && active) {
        event.preventDefault();
        if (wechatThemePreviewOpen) setWechatThemePreviewOpen(false);
        else { setStatus("处理中，请稍后。"); setWechatThemePreviewOpen(true); }
        return;
      }
      if (event.key.toLowerCase() === "f" || event.key.toLowerCase() === "h") {
        event.preventDefault();
        openSearchPanel(event.key.toLowerCase() === "h");
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
      if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (event.shiftKey) void saveAs(); else void save();
      }
      if (event.key.toLowerCase() === "o") { event.preventDefault(); void openFile(); }
      if (event.key.toLowerCase() === "n") { event.preventDefault(); void newFile(); }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activateTabAtIndex, active, clearSearch, closeTab, commandPaletteOpen, newFile, openFile, openSearchPanel, save, saveAs, searchOpen, wechatThemePreviewOpen]);

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

  useEffect(() => {
    const handleLiveImageLoadError = (event: Event) => {
      const detail = (event as CustomEvent<LiveImageLoadFailure>).detail;
      if (!detail || detail.documentId !== activeDocumentIdRef.current) return;
      const text = draftRef.current;
      const source = liveImageLoadFailureRange(text, detail);
      if (!source) return;
      const key = `live-image-load-${detail.documentId}-${detail.referenceKey}`;
      setDiagnostics((current) => current.some((item) => item.key === key) ? current : [...current, {
        key,
        text: "编辑区无法加载已解析的图片资源。请重新解析；若仍失败，请检查图片文件是否可读且为有效图片。",
        severity: "error",
        source,
      }]);
      setPreviewRetryAvailable(true);
      setStatus("图片加载失败，已加入文档诊断；可以重新解析。");
    };
    window.addEventListener("fantastic-editor:live-image-load-error", handleLiveImageLoadError);
    return () => window.removeEventListener("fantastic-editor:live-image-load-error", handleLiveImageLoadError);
  }, []);

  const startAiComparisonResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const stage = event.currentTarget.parentElement;
    if (!stage) return;
    event.preventDefault();
    const rect = stage.getBoundingClientRect();
    const handleMove = (moveEvent: PointerEvent) => {
      setAiComparisonRatio(clampSplitRatio(((moveEvent.clientY - rect.top) / rect.height) * 100));
    };
    const handleUp = () => {
      document.body.classList.remove("is-resizing-ai-compare");
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
    document.body.classList.add("is-resizing-ai-compare");
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp, { once: true });
  }, []);
  const resizeAiComparisonWithKeyboard = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const next = splitRatioForKey(aiComparisonRatio, event.key, event.shiftKey);
    if (next === null) return;
    event.preventDefault();
    setAiComparisonRatio(next);
  }, [aiComparisonRatio]);
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

  const selectPreviewFont = useCallback(async (value: string) => {
    if (value !== CUSTOM_FONT_ACTION) {
      applyPreviewFontDraft(value);
      return;
    }
    setStatus("请选择 TrueType（.ttf）或 OpenType（.otf）字体文件。");
    const result = await window.fantasticEditor.selectAndInstallFont();
    if (result.status === "cancelled") return;
    if (result.status === "failed") {
      setStatus(`自定义字体安装失败：${result.error}`);
      return;
    }
    try {
      const bytes = result.bytes;
      const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const font = await new FontFace(result.fontFamily, source).load();
      document.fonts.add(font);
      applyPreviewFontDraft(result.fontFamily);
      setStatus(`已安装并应用字体：${result.fontFamily}。后续启动可直接调用。`);
    } catch {
      applyPreviewFontDraft(result.fontFamily);
      setStatus(`字体 ${result.fontFamily} 已安装；如未立即显示，请重启软件后使用。`);
    }
  }, [applyPreviewFontDraft]);

  const previewFontOptions = <>
    <option value={CUSTOM_FONT_ACTION}>自定义…</option>
    {!PREVIEW_FONT_PRESETS.includes(previewFontName as typeof PREVIEW_FONT_PRESETS[number]) && <option value={previewFontName}>{previewFontName}</option>}
    {PREVIEW_FONT_PRESETS.map((font) => <option key={font} value={font}>{PREVIEW_FONT_LABELS[font]}</option>)}
  </>;

  const resizeWithKeyboard = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const next = splitRatioForKey(splitRatio, event.key, event.shiftKey);
    if (next === null) return;
    event.preventDefault();
    setSplitRatio(next);
    setStatus(`编辑区宽度已调整为 ${Math.round(next)}%。`);
  }, [splitRatio]);

  const startSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const handleMove = (moveEvent: PointerEvent) => setSidebarWidth(clampSidebarWidth(startWidth + moveEvent.clientX - startX));
    const handleUp = () => {
      document.body.classList.remove("is-resizing-sidebar");
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
    document.body.classList.add("is-resizing-sidebar");
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp, { once: true });
  }, [sidebarWidth]);

  const resizeSidebarWithKey = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const next = sidebarWidthForKey(sidebarWidth, event.key, event.shiftKey);
    if (next === null) return;
    event.preventDefault();
    setSidebarWidth(next);
  }, [sidebarWidth]);

  const startWechatInspectorResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = wechatInspectorWidth;
    const handleMove = (moveEvent: PointerEvent) => setWechatInspectorWidth(clampWechatInspectorWidth(startWidth + startX - moveEvent.clientX));
    const handleUp = () => {
      document.body.classList.remove("is-resizing-wechat");
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
    document.body.classList.add("is-resizing-wechat");
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp, { once: true });
  }, [wechatInspectorWidth]);

  const resizeWechatInspectorWithKey = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const next = wechatInspectorWidthForKey(wechatInspectorWidth, event.key, event.shiftKey);
    if (next === null) return;
    event.preventDefault();
    setWechatInspectorWidth(next);
  }, [wechatInspectorWidth]);

  const startAiInspectorResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = aiInspectorWidth;
    const handleMove = (moveEvent: PointerEvent) => setAiInspectorWidth(clampWechatInspectorWidth(startWidth + startX - moveEvent.clientX));
    const handleUp = () => {
      document.body.classList.remove("is-resizing-ai");
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
    document.body.classList.add("is-resizing-ai");
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp, { once: true });
  }, [aiInspectorWidth]);

  const resizeAiInspectorWithKey = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const next = wechatInspectorWidthForKey(aiInspectorWidth, event.key, event.shiftKey);
    if (next === null) return;
    event.preventDefault();
    setAiInspectorWidth(next);
  }, [aiInspectorWidth]);

  const title = useMemo(() => `${active?.displayName ?? "欢迎"}${dirty ? " · 未保存" : ""}`, [active?.displayName, dirty]);
  const aiProvider = aiProviders.find((provider) => provider.providerId === aiProviderId) ?? null;
  const aiModelTitleSuffix = aiProviderId === "openai-compatible"
    ? (customModelSlots[aiModelSlot]?.modelId ? `-${customModelSlots[aiModelSlot]!.modelId}` : "")
    : (aiProviderId === "deepseek-api" || aiProviderId === "gemini-api" || aiProviderId === "kimi-api" || aiProviderId === "minimax-api")
      && aiProvider?.status === "available" && aiProvider.version ? `-${aiProvider.version}` : "";
  const loadAiProviders = useCallback(async () => {
    const providers = await window.fantasticEditor.detectAiProviders();
    setAiProviders(providers);
    return providers;
  }, []);
  const openAi = useCallback(() => {
    if (!active) return;
    setWechatThemePreviewOpen(false);
    setAiOpen(true);
    if (aiProviders.length === 0) void loadAiProviders();
  }, [active, aiProviders.length, loadAiProviders]);
  const openAiProviders = () => {
    setSidebarPanel("ai-providers");
    setSidebarVisible(true);
    if (aiProviders.length === 0) void loadAiProviders();
  };
  const prepareContextAi = useCallback((instruction: string) => {
    if (aiRequest?.status === "working") void window.fantasticEditor.cancelAi({ requestId: aiRequest.requestId });
    setAiAction("custom");
    setAiCustomInstruction(instruction);
    setAiRequest(null);
    openAi();
  }, [aiRequest, openAi]);
  const refreshAiProviders = useCallback(() => { void loadAiProviders(); }, [loadAiProviders]);
  useEffect(() => { if (wechatThemePreviewOpen && aiProviders.length === 0) refreshAiProviders(); }, [aiProviders.length, refreshAiProviders, wechatThemePreviewOpen]);
  const applyCustomConfig = useCallback((config: OpenAiCompatibleConfigSummary) => {
    setCustomBaseUrl(config.baseUrl);
    setCustomProviderName(config.providerName);
    setCustomLocalName(config.localName);
    setCustomApiKey("");
    setCustomModelSlots(config.modelSlots);
    setCustomModelOptions(config.modelOptions);
    setCustomConfigured(config.configured);
    setCustomConfigLoaded(true);
    setCustomConfigOpen(!config.configured);
    setAiModelSlot((current) => config.modelSlots[current] ? current : config.modelSlots[0] ? 0 : config.modelSlots[1] ? 1 : 0);
  }, []);
  const loadCustomConfig = useCallback(async () => {
    const result = await window.fantasticEditor.getOpenAiCompatibleConfig();
    if (result.status === "loaded") applyCustomConfig(result.config);
    else if (result.status === "failed") { setCustomConfigLoaded(true); setCustomConfigMessage(result.error); }
  }, [applyCustomConfig]);
  useEffect(() => {
    if (aiProviderId === "openai-compatible" && !customConfigLoaded) void loadCustomConfig();
  }, [aiProviderId, customConfigLoaded, loadCustomConfig]);
  const saveCustomConfig = useCallback(async () => {
    setCustomConfigBusy(true); setCustomConfigMessage("");
    const result = await window.fantasticEditor.saveOpenAiCompatibleConfig({
      baseUrl: customBaseUrl,
      apiKey: customApiKey,
      providerName: customProviderName,
      localName: customLocalName,
      modelSlots: customModelSlots,
      modelOptions: customModelOptions,
    });
    setCustomConfigBusy(false);
    if (result.status === "failed") { setCustomConfigMessage(result.error); return; }
    applyCustomConfig(result.config);
    setCustomConfigMessage(result.configured ? "配置已加密保存，可以使用。" : "已保存连接信息，但还需至少选择一个模型。");
    refreshAiProviders();
  }, [applyCustomConfig, customApiKey, customBaseUrl, customLocalName, customModelOptions, customModelSlots, customProviderName, refreshAiProviders]);
  const fetchCustomModels = useCallback(async () => {
    setCustomConfigBusy(true); setCustomConfigMessage("");
    const result = await window.fantasticEditor.listOpenAiCompatibleModels({ baseUrl: customBaseUrl, ...(customApiKey.trim() ? { apiKey: customApiKey.trim() } : {}) });
    setCustomConfigBusy(false);
    if (result.status === "failed") { setCustomConfigMessage(result.error); return; }
    const used = new Set<string>();
    const nextSlots = ([0, 1] as const).map((index) => {
      const current = customModelSlots[index];
      if (current?.modelId && result.models.includes(current.modelId) && !used.has(current.modelId)) { used.add(current.modelId); return current; }
      const modelId = result.models.find((id) => !used.has(id));
      if (!modelId) return null;
      used.add(modelId);
      return { modelId, localName: current?.localName || modelId };
    }) as [OpenAiCompatibleModelSlot | null, OpenAiCompatibleModelSlot | null];
    setCustomModelOptions(result.models);
    setCustomModelSlots(nextSlots);
    setAiModelSlot(nextSlots[0] ? 0 : nextSlots[1] ? 1 : 0);
    setCustomConfigOpen(true);
    setCustomConfigMessage(`已获取 ${result.models.length} 个模型，并预设两个模型；确认别名后保存。`);
  }, [customApiKey, customBaseUrl, customModelSlots]);
  const testCustomConnection = useCallback(async () => {
    setCustomConfigBusy(true); setCustomConfigMessage("");
    const result = await window.fantasticEditor.testOpenAiCompatibleConnection({ baseUrl: customBaseUrl, ...(customApiKey.trim() ? { apiKey: customApiKey.trim() } : {}) });
    setCustomConfigBusy(false);
    if (result.status === "connected") flashConfigMessage(setCustomConfigMessage, "连接正常，可以调用模型。"); else setCustomConfigMessage(result.error);
  }, [customApiKey, customBaseUrl]);

  const clearCustomConfig = useCallback(async () => {
    setCustomConfigBusy(true);
    await window.fantasticEditor.clearOpenAiCompatibleConfig();
    setCustomConfigBusy(false);
    applyCustomConfig({ configured: false, baseUrl: "", providerName: "", localName: "", modelSlots: [null, null], modelOptions: [] });
    setCustomConfigMessage("自定义 API 配置已删除。");
    refreshAiProviders();
  }, [applyCustomConfig, refreshAiProviders]);
  const closeAi = useCallback(() => {
    if (aiRequest?.status === "working") void window.fantasticEditor.cancelAi({ requestId: aiRequest.requestId });
    setAiOpen(false);
    setAiRequest(null);
  }, [aiRequest]);
  const cancelSelectionTranslation = useCallback(async () => {
    const requestId = selectionTranslationRequestRef.current;
    const completion = selectionTranslationCompletionRef.current;
    if (requestId) {
      selectionTranslationRequestRef.current = null;
      await window.fantasticEditor.cancelAi({ requestId }).catch(() => false);
    }
    await completion;
  }, []);
  const invokeSelectionTranslation = useCallback(async (anchor: AiTextAnchor, targetLanguage: TranslationLanguageId): Promise<string> => {
    if (!active || activeDocumentIdRef.current !== anchor.documentId) throw new Error("文档已切换，请重新选择文字后翻译。");
    if (aiRequest?.status === "working" || selectionTranslationRequestRef.current || selectionTranslationCompletionRef.current) throw new Error("已有 AI 任务正在运行，请稍后再试。");
    if (exceedsAiInputLimit(anchor.expectedText)) throw new Error("AI 单次处理内容不能超过 64 KiB。");
    if (draftRef.current.slice(anchor.from, anchor.to) !== anchor.expectedText) throw new Error("选中的文字已变化，请重新选择后翻译。");
    const providerId = aiProviderId;
    const modelSlot = aiModelSlot;
    const requestId = newAiRequestId();
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
    selectionTranslationCompletionRef.current = completion;
    selectionTranslationRequestRef.current = requestId;
    setSelectionTranslationBusy(true);
    try {
      const providers = aiProviders.length > 0 ? aiProviders : await loadAiProviders();
      if (selectionTranslationRequestRef.current !== requestId) throw new Error("翻译已取消。");
      const provider = providers.find((item) => item.providerId === providerId);
      if (!provider || provider.status !== "available") throw new Error(`${provider?.displayName ?? "AI 设置中的模型"} 当前不可用，请先在 AI 设置中检查配置。`);
      if (providerId === "openai-compatible" && !customModelSlots[modelSlot]) throw new Error("请先在 AI 设置中选择并保存一个可用模型。");
      if (window.localStorage.getItem(aiDisclosureStorageKey(providerId)) !== "true") {
        const accepted = window.confirm(`划词翻译会把所选文字发送给 ${provider.displayName}。是否继续？`);
        if (!accepted) throw new Error("已取消翻译。");
        window.localStorage.setItem(aiDisclosureStorageKey(providerId), "true");
      }
      if (selectionTranslationRequestRef.current !== requestId) throw new Error("翻译已取消。");
      const result = await window.fantasticEditor.invokeAi({
        requestId,
        providerId,
        scope: "selection",
        actionId: "custom",
        anchor,
        content: anchor.expectedText,
        customInstruction: translationInstruction(targetLanguage),
        ...(providerId === "openai-compatible" ? { modelSlot } : {}),
      });
      if (selectionTranslationRequestRef.current !== requestId) throw new Error("翻译已取消。");
      if (activeDocumentIdRef.current !== anchor.documentId || draftRef.current.slice(anchor.from, anchor.to) !== anchor.expectedText) throw new Error("原文已变化，未显示过期译文；请重新选择后翻译。");
      if (result.status === "completed") return result.result;
      throw new Error(result.status === "failed" ? result.error : "翻译已取消。");
    } finally {
      if (selectionTranslationRequestRef.current === requestId) selectionTranslationRequestRef.current = null;
      setSelectionTranslationBusy(false);
      if (selectionTranslationCompletionRef.current === completion) selectionTranslationCompletionRef.current = null;
      resolveCompletion();
    }
  }, [active, aiModelSlot, aiProviderId, aiProviders, aiRequest?.status, customModelSlots, loadAiProviders]);
  useEffect(() => {
    if (aiRequest && active?.documentId !== aiRequest.anchor.documentId && aiRequest.status !== "applied") {
      if (aiRequest.status === "working") void window.fantasticEditor.cancelAi({ requestId: aiRequest.requestId });
      setAiRequest((current) => current ? { ...current, status: "stale" } : current);
    }
  }, [active?.documentId, aiRequest?.anchor.documentId]);
  const invokeAi = useCallback(async () => {
    if (!active || aiRequest?.status === "working" || selectionTranslationRequestRef.current || selectionTranslationCompletionRef.current) return;
    const anchor = await markdownEditorRef.current?.captureTextAnchor(active.documentId);
    if (!anchor) { setStatus("请先把光标放入一段正文，或选择需要处理的文字。"); return; }
    if (exceedsAiInputLimit(anchor.expectedText)) { setStatus("AI 单次处理内容不能超过 64 KiB。"); return; }
    const disclosureKey = aiDisclosureStorageKey(aiProviderId);
    if (window.localStorage.getItem(disclosureKey) !== "true") {
      const accepted = window.confirm(`AI 助手会把当前选中的文字（无选区时为当前段落）发送给 ${aiProvider?.displayName ?? "所选 AI 服务"}。是否继续？`);
      if (!accepted) return;
      window.localStorage.setItem(disclosureKey, "true");
    }
    const requestId = newAiRequestId();
    const scope = markdownEditorRef.current?.selectedText() ? "selection" as const : "block" as const;
    setAiRequest({ requestId, anchor, scope, status: "working" });
    const result = await window.fantasticEditor.invokeAi({ requestId, providerId: aiProviderId, scope, actionId: aiAction, anchor, content: anchor.expectedText, ...(aiAction === "custom" ? { customInstruction: aiCustomInstruction.trim() } : {}), ...(aiProviderId === "openai-compatible" ? { modelSlot: aiModelSlot } : {}) });
    setAiRequest((current) => current?.requestId !== requestId || current.status !== "working" ? current : result.status === "completed"
      ? { ...current, status: "ready", result: result.result }
      : result.status === "cancelled" ? null : { ...current, status: "failed", error: result.error });
  }, [active, aiAction, aiCustomInstruction, aiModelSlot, aiProvider?.displayName, aiProviderId, aiRequest?.status]);
  const applyAiSuggestion = useCallback(async () => {
    if (!active || aiRequest?.status !== "ready" || aiRequest.result === undefined) return;
    const applied = await markdownEditorRef.current?.applyTextReplacement(active.documentId, aiRequest.anchor, aiRequest.result);
    setAiRequest((current) => current ? { ...current, status: applied ? "applied" : "stale" } : current);
    setStatus(applied ? "AI 建议已应用；可按 Ctrl+Z 一步撤销。" : "正文在等待期间已经变化，旧建议没有覆盖当前内容。请重新生成。");
  }, [active, aiRequest]);
  const openHistoryForSession = useCallback(async (sessionId: string) => {
    setSettingsOpen(false); setHistoryOpen(true); setHistoryBusy(true);
    const result = await window.fantasticEditor.listDocumentHistory({ sessionId });
    setHistoryBusy(false);
    if (result.status === "listed") setHistoryItems(result.items); else setStatus(result.error);
  }, []);
  const openHistory = useCallback(async () => {
    if (!active || active.isUntitled) { setStatus("请先保存文档，再查看历史版本。"); return; }
    await openHistoryForSession(active.sessionId);
  }, [active, openHistoryForSession]);
  const showOpenFileMenu = useCallback(async (tab: DocumentTab) => {
    const result = await window.fantasticEditor.showOpenFileMenu({ sessionId: tab.sessionId });
    if (result.action === "rename") { beginRenameOpenFile(tab); return; }
    if (result.action === "delete") {
      if (result.workspace) {
        const removed = result.workspace;
        setWorkspace((current) => current ? { ...current, workspaceRevision: removed.workspaceRevision, files: removed.files } : current);
        updateTabs((current) => current.filter((item) => !removed.removedSessionIds.includes(item.sessionId)).map((item) => ({ ...item, workspaceRevision: removed.workspaceRevision })));
        setActive((current) => current && removed.removedSessionIds.includes(current.sessionId) ? null : current ? { ...current, workspaceRevision: removed.workspaceRevision } : current);
      } else {
        updateTabs((current) => current.filter((item) => item.sessionId !== tab.sessionId));
        setActive((current) => current?.sessionId === tab.sessionId ? null : current);
      }
      setStatus("文件已删除。");
      return;
    }
    if (result.action === "none") return;
    await activateTab(tab);
    if (result.action === "history") await openHistoryForSession(tab.sessionId);
  }, [activateTab, beginRenameOpenFile, openHistoryForSession, updateTabs]);
  const restoreHistory = useCallback(async (snapshotId: string) => {
    if (!active || historyBusy || !window.confirm("恢复此历史版本？当前编辑内容会先自动保存到历史中，磁盘文件不会立即覆盖。")) return;
    setHistoryBusy(true);
    const result = await window.fantasticEditor.restoreDocumentHistory({ sessionId: active.sessionId, snapshotId, currentText: draftRef.current });
    setHistoryBusy(false);
    if (result.status === "failed") { setStatus(result.error); return; }
    if (!markdownEditorRef.current?.replaceDocument(draftRef.current, result.editorText)) { setStatus("正文已经变化，请重新打开历史记录后恢复。"); return; }
    setHistoryOpen(false); setStatus("历史版本已恢复到编辑器；保存后才会写入磁盘，可按 Ctrl+Z 撤销。");
  }, [active, historyBusy]);
  const showWorkspaceFileMenu = useCallback(async (targetWorkspace: ActiveWorkspace, file: WorkspaceFileEntry) => {
    const request = { workspaceId: targetWorkspace.workspaceId, workspaceRevision: targetWorkspace.workspaceRevision, fileId: file.fileId };
    const result = await window.fantasticEditor.showWorkspaceFileMenu(request);
    if (result.action === "rename") { beginRenameWorkspaceFile(targetWorkspace, file); return; }
    if (result.action === "none") return;
    if (result.workspace) {
      setWorkspace((current) => current?.workspaceId === targetWorkspace.workspaceId ? { ...current, workspaceRevision: result.workspace!.workspaceRevision, files: result.workspace!.files } : current);
      updateTabs((current) => current.filter((tab) => !result.workspace!.removedSessionIds.includes(tab.sessionId)).map((tab) => ({ ...tab, workspaceRevision: result.workspace!.workspaceRevision })));
      setActive((current) => current && result.workspace!.removedSessionIds.includes(current.sessionId) ? null : current ? { ...current, workspaceRevision: result.workspace!.workspaceRevision } : null);
      setStatus(result.action === "duplicate" ? "已创建文件副本。" : result.action === "move" ? "文件已移动。" : "文件已删除。 ");
      return;
    }
    const opened = await window.fantasticEditor.openWorkspaceFile(request);
    if (opened.status !== "opened" || !opened.session) { acceptOpenedFile(opened, file.fileId); return; }
    if (result.action !== "open-new-tab") updateTabs(() => []);
    acceptOpenedFile(opened, file.fileId);
    if (result.action === "history") await openHistoryForSession(opened.session.sessionId);
  }, [acceptOpenedFile, beginRenameWorkspaceFile, openHistoryForSession, updateTabs]);
  const closeCommandPalette = () => { setCommandPaletteOpen(false); setCommandQuery(""); };
  const commandItems = [
    { label: "新建文档", shortcut: "Ctrl+N", enabled: true, run: () => void newFile() },
    { label: "打开文件", shortcut: "Ctrl+O", enabled: true, run: () => void openFile() },
    { label: "保存文档", shortcut: "Ctrl+S", enabled: Boolean(active), run: () => void save() },
    { label: "写作模式", shortcut: "", enabled: Boolean(active), run: () => { if (switchEditorMode("wysiwyg")) setViewMode("editor"); } },
    { label: "源码模式", shortcut: "", enabled: Boolean(active), run: () => { if (switchEditorMode("source")) setViewMode("editor"); } },
    { label: "分栏模式", shortcut: "", enabled: Boolean(active), run: () => { if (switchEditorMode("source")) setViewMode("split"); } },
    { label: focusMode ? "退出专注模式" : "进入专注模式", shortcut: "", enabled: Boolean(active), run: () => setFocusMode((current) => !current) },
    { label: typewriterMode ? "关闭打字机模式" : "开启打字机模式", shortcut: "", enabled: Boolean(active), run: () => setTypewriterMode((current) => !current) },
    { label: "查找与替换", shortcut: "Ctrl+F", enabled: Boolean(active), run: () => openSearchPanel(false) },
    { label: "AI 写作助手", shortcut: "", enabled: Boolean(active), run: openAi },
    { label: "公众号排版", shortcut: "Ctrl+Shift+P", enabled: Boolean(active), run: () => setWechatThemePreviewOpen((open) => !open) },
    { label: "设置与关于", shortcut: "", enabled: true, run: () => setSettingsOpen(true) },
    { label: "导出", shortcut: "", enabled: Boolean(active && outputReady && !outputBusy), run: () => exportMenuSummaryRef.current?.click() },
  ].filter((item) => item.label.toLocaleLowerCase().includes(commandQuery.trim().toLocaleLowerCase()));
  const runCommand = (command: (typeof commandItems)[number]) => {
    if (!command.enabled) return;
    closeCommandPalette();
    command.run();
  };

  return (
    <main className={`app-shell${darkMode ? " theme-dark" : ""}${dragActive ? " drag-active" : ""}${focusMode ? " focus-mode" : ""}`} onDragEnter={(event) => { if (!isFileDrag(event.dataTransfer.types)) return; event.preventDefault(); setDragActive(true); }} onDragOver={(event) => { if (!isFileDrag(event.dataTransfer.types)) return; event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDragActive(true); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false); }} onDragEnd={() => setDragActive(false)} onDropCapture={(event) => void handleDrop(event)}>
      <header className="app-header">
        <div className="brand-lockup"><span className="brand-symbol">f</span><span className="brand-name">fantastic<span>editor</span></span></div>
        <div className="header-document" title={title}><span className={`document-state${dirty ? " dirty" : ""}`} /><span>{title}</span><small>{active ? "本地文档" : "本地优先 Markdown 编辑器"}</small></div>
        <div className="header-tools">
          <button type="button" className={`reading-mode-button${darkMode ? " active" : ""}`} aria-label={darkMode ? "切换浅色模式" : "切换深色模式"} aria-pressed={darkMode} title={darkMode ? "切换浅色模式" : "切换深色模式"} onClick={() => setDarkMode((value) => !value)}><Icon name={darkMode ? "sun" : "moon"} size={15} /></button>
          <button type="button" className={`reading-mode-button${spellCheck ? " active" : ""}`} aria-pressed={spellCheck} title={spellCheck ? "关闭拼写检查" : "开启拼写检查"} onClick={() => setSpellCheck((value) => !value)}>拼写</button>
          <button type="button" className={`reading-mode-button${focusMode ? " active" : ""}`} disabled={!active} aria-pressed={focusMode} title="隐藏导航和辅助面板，只保留写作区" onClick={() => setFocusMode((current) => !current)}>专注</button>
          <button type="button" className={`reading-mode-button${typewriterMode ? " active" : ""}`} disabled={!active} aria-pressed={typewriterMode} title="让当前行保持在视野中央并柔和突出显示" onClick={() => setTypewriterMode((current) => { const next = !current; setStatus(next ? "已开启打字机模式：当前行将居中并突出显示。" : "已关闭打字机模式。"); return next; })}>打字机</button>
          <div className="view-switcher primary-mode-switcher" role="group" aria-label="写作视图">
            <button type="button" className={viewMode === "editor" && editorMode === "wysiwyg" ? "active" : ""} disabled={!active} aria-label="写作模式" aria-pressed={viewMode === "editor" && editorMode === "wysiwyg"} onClick={() => { if (switchEditorMode("wysiwyg")) setViewMode("editor"); }}>写作</button>
            <button type="button" className={viewMode === "editor" && editorMode === "source" ? "active" : ""} disabled={!active} aria-label="源码模式" aria-pressed={viewMode === "editor" && editorMode === "source"} onClick={() => { if (switchEditorMode("source")) setViewMode("editor"); }}>源码</button>
            <button type="button" className={viewMode === "split" ? "active" : ""} disabled={!active} aria-label="分栏" aria-pressed={viewMode === "split"} onClick={() => { if (switchEditorMode("source")) setViewMode("split"); }}>分栏</button>
          </div>
          <details
            className={`export-menu${!active || outputBusy ? " disabled" : ""}`}
            onMouseEnter={(event) => { if (active && outputReady && !outputBusy) event.currentTarget.open = true; }}
            onMouseLeave={(event) => {
              const next = event.relatedTarget;
              if (next instanceof Node && event.currentTarget.contains(next)) return;
              event.currentTarget.open = false;
            }}
          >
            <summary
              ref={exportMenuSummaryRef}
              title={!active ? "请先新建或打开 Markdown 文档" : outputBusy ? "导出正在处理中" : !outputReady ? "正在解析文档和资源，请稍候" : "导出"}
              onClick={(event) => {
                event.preventDefault();
                if (active && outputReady && !outputBusy) {
                  (event.currentTarget.parentElement as HTMLDetailsElement).open = true;
                  return;
                }
                if (!active) {
                  setStatus("请先新建或打开一个 Markdown 文件。");
                  return;
                }
                if (outputBusy) {
                  setStatus("已有导出任务正在处理，请稍候。");
                  return;
                }
                exportMenuPendingRef.current = true;
                setStatus("文档或资源仍在解析，解析完成后将自动打开导出菜单。");
              }}
            ><span>{outputBusy ? "处理中" : "导出"}</span><Icon name="chevronDown" size={14} /></summary>
            <div className="export-popover">
              <div className="menu-heading">导出</div>
              <button type="button" onClick={(event) => { (event.currentTarget.closest("details") as HTMLDetailsElement).open = false; void exportDocument("pdf"); }}><span className="format-badge pdf">PDF</span><span><strong>导出 PDF</strong><small>保持当前排版和公式</small></span></button>
              <button type="button" onClick={(event) => { (event.currentTarget.closest("details") as HTMLDetailsElement).open = false; void exportDocument("docx"); }}><span className="format-badge word">W</span><span><strong>导出 Word</strong><small>生成可继续编辑的 DOCX</small></span></button>
              <button type="button" onClick={(event) => { (event.currentTarget.closest("details") as HTMLDetailsElement).open = false; void exportDocument("offline-html"); }}><span className="format-badge html">&lt;/&gt;</span><span><strong>离线 HTML</strong><small>图片与公式完全自包含</small></span></button>
            </div>
          </details>
        </div>
      </header>

      <div className="workbench">
        <aside className="activity-bar" aria-label="主导航">
          <button type="button" className={sidebarVisible && sidebarPanel === "explorer" ? "active" : ""} aria-label="切换资源管理器" aria-pressed={sidebarVisible && sidebarPanel === "explorer"} title="显示或隐藏资源管理器" onClick={() => { if (sidebarVisible && sidebarPanel === "explorer") setSidebarVisible(false); else { setSidebarPanel("explorer"); setSidebarVisible(true); } }}><Icon name="panelLeft" /></button>
          <button type="button" data-testid="new-document" aria-label="新建文档" title="新建文档 (Ctrl+N)" onClick={() => void newFile()}><Icon name="filePlus" /></button>
          <button type="button" aria-label="打开文件" title="打开文件 (Ctrl+O)" onClick={() => void openFile()}><Icon name="file" /></button>
          <button type="button" aria-label="保存" title="保存文档 (Ctrl+S)" disabled={!active || !dirty} onClick={() => void save()}><Icon name="save" /></button>
          <button type="button" aria-label="打开文件夹" title="打开文件夹" onClick={() => void openFolder()}><Icon name="folderOpen" /></button>
          <button type="button" className={sidebarVisible && sidebarPanel === "outline" ? "active" : ""} aria-label="切换文档大纲" aria-pressed={sidebarVisible && sidebarPanel === "outline"} title="显示或隐藏文档大纲" onClick={() => { if (sidebarVisible && sidebarPanel === "outline") setSidebarVisible(false); else { setSidebarPanel("outline"); setSidebarVisible(true); } }}><Icon name="list" /></button>
          <button type="button" aria-label="搜索" title="查找/替换 (Ctrl+F / Ctrl+H)" disabled={!active} onClick={() => openSearchPanel(false)}><Icon name="search" /></button>
          <button type="button" className={sidebarVisible && sidebarPanel === "ai-providers" ? "active ai-provider-entry" : "ai-provider-entry"} aria-label="切换 AI 提供商" aria-pressed={sidebarVisible && sidebarPanel === "ai-providers"} title="AI 提供商与模型设置" onClick={() => { if (sidebarVisible && sidebarPanel === "ai-providers") setSidebarVisible(false); else openAiProviders(); }}><span aria-hidden="true">模</span></button>
          <button type="button" className={aiOpen ? "active ai-entry" : "ai-entry"} aria-label="AI 写作助手" aria-pressed={aiOpen} title="AI 写作助手" disabled={!active} onClick={() => aiOpen ? closeAi() : openAi()}><span aria-hidden="true">AI</span></button>
          <button type="button" className="wechat-copy-entry" aria-label="复制到公众号" title="复制到公众号（使用当前公众号主题）" disabled={!active || outputBusy} onClick={() => { if (!outputReady) { setStatus("正文正在更新，请稍候再复制到公众号。"); return; } void exportDocument("wechat-clipboard"); }}><span aria-hidden="true">微</span></button>
          <button ref={wechatThemeButtonRef} type="button" className={`wechat-layout-entry${wechatThemePreviewOpen || wechatApiConfigOpen ? " active" : ""}`} aria-label="公众号" aria-pressed={wechatThemePreviewOpen || wechatApiConfigOpen} title={active ? "公众号排版、草稿同步与接口设置 (Ctrl+Shift+P)" : "公众号接口与封面设置"} disabled={wechatThemeSaveOpen} onClick={() => { closeAi(); if (!active) { setWechatApiConfigOpen((open) => !open); return; } if (wechatThemePreviewOpen) { setWechatThemePreviewOpen(false); return; } setStatus("处理中，请稍后。"); setWechatThemePreviewOpen(true); }}><Icon name="wechat" /></button>
          <button type="button" className={`activity-settings${settingsOpen ? " active" : ""}`} aria-label="设置与关于" aria-pressed={settingsOpen} title="设置与关于" onClick={() => setSettingsOpen((current) => !current)}><Icon name="settings" /></button>
        </aside>

        {sidebarVisible && sidebarPanel === "explorer" && (
          <aside className="explorer-panel" aria-label="资源管理器" style={{ flexBasis: `${sidebarWidth}px` }}>
            <div className="explorer-title"><span>资源管理器</span></div>
            <section className="explorer-section">
              <div className="section-title"><span className="section-chevron">⌄</span><span>打开的编辑器</span><small>{tabs.length}</small></div>
              <div className="open-editors">
                {tabs.length === 0 && <p className="explorer-empty">尚未打开文档</p>}
                {tabs.map((tab) => (
                  <div className="open-editor-entry" key={tab.sessionId}>
                    {renameTarget?.kind === "open" && renameTarget.sessionId === tab.sessionId ? (
                      <form className="rename-inline-form" onSubmit={(event) => { event.preventDefault(); void submitRename(); }}>
                        <input ref={renameInputRef} value={renameValue} aria-label="新的 Markdown 文件名" onChange={(event) => setRenameValue(event.target.value)} onBlur={() => { if (renameValue.trim()) void submitRename(); else cancelRename(); }} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); cancelRename(); } }} />
                      </form>
                    ) : (
                      <button type="button" className={`open-editor-select${active?.sessionId === tab.sessionId ? " active" : ""}`} title="点击切换文档；再次点击展开或收起目录；右键打开操作菜单；双击重命名" onClick={() => void toggleOutlineForTab(tab)} onDoubleClick={(event) => { event.preventDefault(); beginRenameOpenFile(tab); }} onContextMenu={(event) => {
                        event.preventDefault();
                        void showOpenFileMenu(tab);
                      }}>
                        <Icon name="markdown" size={15} /><span>{tab.isUntitled ? firstLineDisplayName(tab.draft) ?? tab.displayName : tab.displayName}</span>{(tab.requiresSave || tab.draft !== tab.savedText) && <i aria-label="未保存" />}
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
                        <button type="button" className={`workspace-file-select${active?.workspaceFileId === file.fileId ? " active" : ""}`} title={`${file.relativePath} · 右键打开操作菜单`} onClick={() => void selectWorkspaceFile(workspace, file)} onContextMenu={(event) => { event.preventDefault(); void showWorkspaceFileMenu(workspace, file); }}><Icon name="file" size={14} /><span>{file.displayName}</span></button>
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
          <aside className="explorer-panel outline-panel" aria-label="文档大纲" style={{ flexBasis: `${sidebarWidth}px` }}>
            <div className="explorer-title"><span>文档大纲</span><div className="explorer-title-actions"><small>{extractDocumentOutline(outlineDocument).length}</small></div></div>
            <DocumentOutline entries={extractDocumentOutline(outlineDocument)} stale={Boolean(active && !outlineDocument)} onReveal={revealOutlineEntry} />
          </aside>
        )}
        {sidebarVisible && sidebarPanel === "ai-providers" && (
          <aside className="explorer-panel ai-provider-panel" aria-label="AI 提供商设置" style={{ flexBasis: `${sidebarWidth}px` }}>
            <div className="explorer-title"><span>AI 提供商</span><button type="button" aria-label="重新检测 AI 提供商" title="重新检测" onClick={refreshAiProviders}>↻</button></div>
            <div className="ai-provider-panel-content">
              <div className="ai-select-row">
                <label className={`ai-select-block${aiRequest?.status === "working" || selectionTranslationBusy ? " is-disabled" : ""}`}><span>当前提供商</span><select aria-label="AI 提供商" value={aiProviderId} disabled={aiRequest?.status === "working" || selectionTranslationBusy} onChange={(event) => setAiProviderId(event.target.value as AiProviderId)}>{aiProviders.map((provider) => <option key={provider.providerId} value={provider.providerId}>{provider.displayName}{provider.status === "unavailable" ? "（不可用）" : ""}</option>)}</select></label>
                {aiProviderId === "openai-compatible" && customConfigured && <label className={`ai-select-block${aiRequest?.status === "working" || selectionTranslationBusy ? " is-disabled" : ""}`}><span>当前模型</span><select aria-label="自定义模型预设" value={customModelSlots[aiModelSlot]?.modelId ? aiModelSlot : 0} disabled={aiRequest?.status === "working" || selectionTranslationBusy} onChange={(event) => setAiModelSlot(Number(event.target.value) as 0 | 1)}>{customModelSlots.map((slot, index) => slot && <option key={`${index}:${slot.modelId}`} value={index}>{slot.localName || slot.modelId}</option>)}</select></label>}
              </div>
              <small className="ai-provider-status" role="status">{aiProvider?.status === "available" ? `${aiProvider.displayName} 已就绪${aiProvider.version ? ` · ${aiProvider.version}` : ""}` : aiProvider?.guidance ?? "正在检测可用的 AI 提供商…"}</small>
            {aiProviderId === "openai-compatible" && <>
              <details className="ai-custom-config" open={customConfigOpen} onToggle={(event) => setCustomConfigOpen(event.currentTarget.open)}>
                <summary>连接与模型设置</summary>
                <div className="ai-custom-fields">
                  <label><span>订阅地址</span><input type="url" inputMode="url" autoComplete="off" placeholder="https://…/v1" value={customBaseUrl} disabled={customConfigBusy || aiRequest?.status === "working" || selectionTranslationBusy} onChange={(event) => setCustomBaseUrl(event.target.value)} /></label>
                  <label><span>API Key</span><input type="password" autoComplete="off" placeholder={customConfigured ? "已加密保存，留空保持不变" : "粘贴 API Key"} value={customApiKey} disabled={customConfigBusy || aiRequest?.status === "working" || selectionTranslationBusy} onChange={(event) => setCustomApiKey(event.target.value)} /></label>
                  <label><span>服务名称（自定义）</span><input maxLength={80} placeholder="例如：我的订阅服务" value={customProviderName} disabled={customConfigBusy || aiRequest?.status === "working" || selectionTranslationBusy} onChange={(event) => setCustomProviderName(event.target.value)} /></label>
                  <label><span>软件内名称（自定义）</span><input maxLength={80} placeholder="例如：我的写作模型" value={customLocalName} disabled={customConfigBusy || aiRequest?.status === "working" || selectionTranslationBusy} onChange={(event) => setCustomLocalName(event.target.value)} /></label>
                </div>
                <div className="ai-custom-models" aria-label="两个模型预设">
                  {([0, 1] as const).map((index) => {
                    const slot = customModelSlots[index];
                    return <div className="ai-custom-model" key={`model-slot-${index}`}>
                      <label><span>模型 {index + 1}</span><select value={slot?.modelId ?? ""} disabled={customConfigBusy || aiRequest?.status === "working" || selectionTranslationBusy} onChange={(event) => { const modelId = event.target.value; setCustomModelSlots((current) => { const next = [...current] as [OpenAiCompatibleModelSlot | null, OpenAiCompatibleModelSlot | null]; next[index] = modelId ? { modelId, localName: current[index]?.localName || modelId } : null; return next; }); }}><option value="">未选择</option>{customModelOptions.map((modelId) => <option key={modelId} value={modelId}>{modelId}</option>)}</select></label>
                      <label><span>软件内名称</span><input maxLength={80} placeholder={slot?.modelId || "先获取模型"} value={slot?.localName ?? ""} disabled={!slot || customConfigBusy || aiRequest?.status === "working" || selectionTranslationBusy} onChange={(event) => setCustomModelSlots((current) => { const next = [...current] as [OpenAiCompatibleModelSlot | null, OpenAiCompatibleModelSlot | null]; if (next[index]) next[index] = { ...next[index]!, localName: event.target.value }; return next; })} /></label>
                    </div>;
                  })}
                </div>
                <div className="ai-custom-actions">
                  <button type="button" disabled={customConfigBusy || aiRequest?.status === "working" || selectionTranslationBusy || !customBaseUrl.trim()} onClick={() => void testCustomConnection()}>{customConfigBusy ? "处理中…" : "测试连通性"}</button>
                  <button type="button" disabled={customConfigBusy || aiRequest?.status === "working" || selectionTranslationBusy || !customBaseUrl.trim()} onClick={() => void fetchCustomModels()}>{customConfigBusy ? "处理中…" : "一键获取模型能力"}</button>
                  <button type="button" disabled={customConfigBusy || aiRequest?.status === "working" || selectionTranslationBusy || !customBaseUrl.trim()} onClick={() => void saveCustomConfig()}>保存配置</button>
                  <button type="button" disabled={customConfigBusy || aiRequest?.status === "working" || selectionTranslationBusy} onClick={() => void clearCustomConfig()}>清除配置</button>
                </div>
                <small>标准 OpenAI 兼容格式：读取 GET /models，并用官方模型 ID 调用 POST /chat/completions。自定义名称只用于本软件显示。</small>
              </details>
              {customConfigMessage && <small role="status">{customConfigMessage}</small>}
            </>}
            {(["deepseek-api", "gemini-api", "kimi-api", "minimax-api"] as const).map((providerId) => {
              const providerStatus = aiProviders.find((item) => item.providerId === providerId);
              return <div key={providerId} style={{ display: aiProviderId === providerId ? "contents" : "none" }}><FixedAiProviderConfig providerId={providerId} configured={providerStatus?.status === "available"} disabled={aiProviderId !== providerId || aiRequest?.status === "working" || selectionTranslationBusy} onProvidersChanged={refreshAiProviders} /></div>;
            })}
            </div>
          </aside>
        )}

        {sidebarVisible && <div className="sidebar-resize-handle" role="separator" aria-label="调整侧边栏宽度" aria-orientation="vertical" aria-valuemin={MIN_SIDEBAR_WIDTH} aria-valuemax={MAX_SIDEBAR_WIDTH} aria-valuenow={sidebarWidth} tabIndex={0} title="拖动调整宽度；方向键微调" onPointerDown={startSidebarResize} onKeyDown={resizeSidebarWithKey}><button type="button" className="panel-collapse-button" aria-label="收起侧边栏" title="收起侧边栏" onPointerDown={(event) => event.stopPropagation()} onClick={() => { setSidebarVisible(false); setStatus("已收起侧边栏。"); }}>‹</button><span /></div>}

        <section className="main-area" ref={mainAreaRef}>
          <nav className="document-tabs" data-testid="document-tabs" aria-label="打开的文档" onDoubleClick={(event) => { if ((event.target as HTMLElement).closest(".document-tab")) return; void newFile(); }}>
            <div className="tab-strip" role="tablist" aria-label="文档标签">
              {tabs.map((tab, tabIndex) => {
                const tabDirty = tab.requiresSave || tab.draft !== tab.savedText;
                return (
                  <div
                    className={`document-tab${active?.sessionId === tab.sessionId ? " active" : ""}`}
                    key={tab.sessionId}
                    draggable={!(renameTarget?.kind === "open" && renameTarget.sessionId === tab.sessionId)}
                    onDragStart={(event) => { draggedTabSessionIdRef.current = tab.sessionId; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-fantastic-editor-tab", tab.sessionId); }}
                    onDragEnter={(event) => { event.preventDefault(); event.stopPropagation(); }}
                    onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move"; }}
                    onDrop={(event) => { event.preventDefault(); event.stopPropagation(); const sessionId = draggedTabSessionIdRef.current ?? event.dataTransfer.getData("application/x-fantastic-editor-tab"); if (sessionId) moveDocumentTab(sessionId, tabIndex); draggedTabSessionIdRef.current = null; }}
                    onDragEnd={() => { draggedTabSessionIdRef.current = null; }}
                  >
                    {renameTarget?.kind === "open" && renameTarget.sessionId === tab.sessionId ? (
                      <form className="rename-inline-form tab-rename-form" onSubmit={(event) => { event.preventDefault(); void submitRename(); }}>
                        <input ref={renameInputRef} value={renameValue} aria-label="新的 Markdown 文件名" onChange={(event) => setRenameValue(event.target.value)} onBlur={() => { if (renameValue.trim()) void submitRename(); else cancelRename(); }} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); cancelRename(); } }} />
                      </form>
                    ) : (
                      <button type="button" role="tab" aria-selected={active?.sessionId === tab.sessionId} tabIndex={active?.sessionId === tab.sessionId ? 0 : -1} data-tab-index={tabIndex} className="tab-select" title={`${tab.displayName} · 右键重命名 · 左右键切换`} onContextMenu={(event) => { event.preventDefault(); beginRenameOpenFile(tab); }} onKeyDown={(event) => handleTabKeyDown(event, tabIndex, tab.sessionId)} onClick={() => void activateTab(tab)}><Icon name="markdown" size={14} /><span>{tab.isUntitled ? firstLineDisplayName(tab.draft) ?? tab.displayName : tab.displayName}</span>{tabDirty && <span className="dirty-dot" aria-label="未保存" />}</button>
                    )}
                    <button type="button" className="tab-close" aria-label={`关闭 ${tab.displayName}`} title="关闭标签 (Ctrl+W)" onClick={() => void closeTab(tab)}>×</button>
                  </div>
                );
              })}
            </div>
          </nav>

          {active ? (
            <section className={`document-stage view-${viewMode}`} style={viewMode === "split" ? { gridTemplateColumns: `minmax(0, ${splitRatio}fr) 6px minmax(0, ${100 - splitRatio}fr)` } : undefined}>
              <div className={`pane editor-pane editor-mode-${editorMode}${markdownRepairDetected ? " has-markdown-detection" : ""}`}>
                <div className="pane-header">
                  <div className="pane-actions">
                    {editorMode === "wysiwyg" && <>
                      <div className="live-preview-format-toolbar" role="toolbar" aria-label="文字和内容块格式" onMouseDown={(event) => event.preventDefault()}>
                        <button type="button" title="正文" onClick={() => markdownEditorRef.current?.setBlockType(0)}>正文</button>
                        <button type="button" title="一级标题" onClick={() => markdownEditorRef.current?.setBlockType(1)}>H1</button>
                        <button type="button" title="二级标题" onClick={() => markdownEditorRef.current?.setBlockType(2)}>H2</button>
                        <button type="button" title="三级标题" onClick={() => markdownEditorRef.current?.setBlockType(3)}>H3</button>
                        <button type="button" title="切换粗体（Ctrl+B）" onClick={() => markdownEditorRef.current?.toggleSelectionMark("bold")}><strong>B</strong></button>
                        <button type="button" title="切换斜体（Ctrl+I）" onClick={() => markdownEditorRef.current?.toggleSelectionMark("italic")}><em>I</em></button>
                        <button type="button" title="切换删除线" onClick={() => markdownEditorRef.current?.toggleSelectionMark("strike")}><s>S</s></button>
                        <button type="button" title="添加链接" onClick={() => setLiveLinkInputOpen(true)}>链接</button>
                        <button type="button" title="上移当前行或选中内容，可连续点击" onClick={() => markdownEditorRef.current?.moveSelection("up")}>上移</button>
                        <button type="button" title="下移当前行或选中内容，可连续点击" onClick={() => markdownEditorRef.current?.moveSelection("down")}>下移</button>
                      </div>
                      <label className="preview-reading-control" title="调整写作区内容宽度，适配不同屏幕；不改变导出结果"><span>宽度</span><select aria-label="阅读宽度" value={readingWidth} onChange={(event) => { const next = normalizeReadingWidth(event.target.value); setReadingWidth(next); setReadingWidthPx(readingWidthPxFromPreset(next)); }}>{READING_WIDTH_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
                      {liveLinkInputOpen && <form className="live-preview-link-editor" onSubmit={(event) => {
                        event.preventDefault();
                        if (!markdownEditorRef.current?.insertLink(liveLinkUrl)) {
                          setStatus("链接地址格式不正确，请使用 http、https、mailto、# 或站内路径。");
                          return;
                        }
                        setLiveLinkInputOpen(false);
                        setLiveLinkUrl("");
                      }}>
                        <input autoFocus aria-label="新链接地址" placeholder="https://…" value={liveLinkUrl} onChange={(event) => setLiveLinkUrl(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { setLiveLinkInputOpen(false); setLiveLinkUrl(""); window.requestAnimationFrame(() => markdownEditorRef.current?.focus()); } }} />
                        <button type="submit">应用</button>
                        <button type="button" onClick={() => { setLiveLinkInputOpen(false); setLiveLinkUrl(""); markdownEditorRef.current?.focus(); }}>取消</button>
                      </form>}
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
                      >{wechatThemeInWysiwyg ? aiEditorThemeDefinition ? "AI 排版 · 开" : "公众号主题 · 开" : "公众号主题 · 关"}</button>
                      <>
                        <button type="button" className="wysiwyg-font-default" title="统一写作、预览和导出的正文字体为微软雅黑；不修改 Markdown 内容" aria-label="统一正文字体为微软雅黑" onClick={() => applyPreviewFontDraft(DEFAULT_PREVIEW_FONT)}>统一微软雅黑</button>
                        <label className="preview-font-preset" title="正文字体同时用于写作、实时预览和导出；“自定义”可安装本机字体文件"><span>正文字体</span><select data-testid="wysiwyg-font-preset" aria-label="正文字体" value={previewFontName} onChange={(event) => void selectPreviewFont(event.target.value)}>{previewFontOptions}</select></label>
                      </>
                    </>}
                    <button type="button" className="smart-punctuation-button" disabled={!active} title="转换普通正文中的直引号和三个英文句点；不处理代码与链接" onClick={smartenPunctuation}>智能标点</button>
                  </div>
                </div>
                {markdownDocumentFence.detected && <div className="markdown-detection-banner" role="status" data-testid="markdown-detection-banner"><span><Icon name="markdown" size={16} /><strong>识别到 Markdown 语法</strong><small>内容似乎被整篇代码框包住了，可自动恢复正常排版。</small></span><button type="button" onClick={convertDetectedMarkdown}>立即转换</button></div>}
                {!markdownDocumentFence.detected && webMarkdownRepair?.changed && <div className="markdown-detection-banner" role="status" data-testid="web-markdown-repair-banner"><span><Icon name="markdown" size={16} /><strong>识别到网页 Markdown 格式问题</strong><small>可自动修复网页空格、转义标记、异常空行和表格断行，不改动代码块、路径及普通反斜杠。</small></span><button type="button" onClick={repairCurrentWebMarkdown}>立即修复</button></div>}
                <div className="editor-mode-body has-ruler">
                  <EditorRuler widthPx={readingWidthPx} onChange={setReadingWidthPx} onReset={() => { setReadingWidth(DEFAULT_READING_WIDTH); setReadingWidthPx(DEFAULT_READING_WIDTH_PX); }} />
                  <div className="source-editor-layer active">
                    <MarkdownEditor
                      {...(previewHtmlReady ? { imagePreviewHtml: previewHtml } : {})}
                      key={active.sessionId}
                      ref={markdownEditorRef}
                      documentId={active.documentId}
                      value={draft}
                      onViewportAnchorChange={(anchor) => { if (editorMode === "source") synchronizedPreviewRef.current?.updateViewportAnchor(anchor); }}
                      onSelectionChange={(selection) => {
                        if (editorMode === "source") synchronizedPreviewRef.current?.updateSelection(selection);
                      }}
                      onTranslateSelection={invokeSelectionTranslation}
                      onCancelTranslation={cancelSelectionTranslation}
                      translationProviderLabel={aiProvider?.displayName ?? aiProviderId}
                      onImageDrop={(files, anchorId) => void importImages(files, anchorId)}
                      onInsertImages={(anchorId) => void importImages(undefined, anchorId)}
                      onAiAssist={prepareContextAi}
                      onDropRejected={(message) => { setDragActive(false); setStatus(message); }}
                      onStatus={setStatus}
                      onChange={applyDraftChange}
                      prefixUntitledHeading={active.isUntitled}
                      livePreview={editorMode === "wysiwyg"}
                      fontFamily={previewFontStack(previewFontName)}
                      readingMaxWidth={`${readingWidthPx}px`}
                      fontSize={previewFontSize}
                      typewriterMode={typewriterMode}
                      darkMode={darkMode}
                      spellCheck={spellCheck}
                      {...(editorMode === "wysiwyg" && wechatThemeInWysiwyg ? { wechatThemeDefinition: aiEditorThemeDefinition ?? wechatThemeResolved.definition } : {})}
                    />
                  </div>
                </div>
              </div>
              {viewMode === "split" && <div className="split-handle" role="separator" aria-label="调整编辑与预览宽度；使用左右方向键调整" aria-orientation="vertical" aria-valuemin={MIN_SPLIT_RATIO} aria-valuemax={MAX_SPLIT_RATIO} aria-valuenow={Math.round(splitRatio)} tabIndex={0} onKeyDown={resizeWithKeyboard} onPointerDown={startResize}><span /></div>}
              <div className="pane preview-pane">
                <div className="pane-header">
                  <span><Icon name="eye" size={15} />实时预览</span>
                  <div className="pane-actions">
                    <label className="preview-font-preset" title="正文字体同时用于写作、实时预览和导出；“自定义”可安装本机字体文件"><span>正文字体</span><select data-testid="preview-font-preset" aria-label="正文字体" value={previewFontName} onChange={(event) => void selectPreviewFont(event.target.value)}>{previewFontOptions}</select></label>
                    <label className="preview-reading-control" title="仅影响实时预览和所见即所得阅读区，不改变导出结果"><span>宽度</span><select aria-label="阅读宽度" value={readingWidth} onChange={(event) => { const next = normalizeReadingWidth(event.target.value); setReadingWidth(next); setReadingWidthPx(readingWidthPxFromPreset(next)); }}>{READING_WIDTH_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
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
                  readingMaxWidth={`${readingWidthPx}px`}
                  previewFontSize={previewFontSize}
                  darkMode={darkMode}
                  onMermaidRender={(result) => {
                    if (result.failed > 0 || result.limited > 0) setStatus(`Mermaid：${result.rendered} 个已渲染，${result.failed + result.limited} 个未完成。`);
                  }}
                  onStatus={setStatus}
                  onErrorCapture={handlePreviewImageError}
                  onLoadCapture={handlePreviewImageLoad}
                />
              </div>
            </section>
          ) : (
            <WelcomeScreen onNew={() => void newFile()} onOpen={() => void openFile()} onOpenFolder={() => void openFolder()} recentFiles={recentFiles} onOpenRecent={(recentId) => void openRecentFile(recentId)} />
          )}
        </section>
        {wechatThemePreviewOpen && active && (
          <div className="wechat-inspector-shell" style={{ width: wechatInspectorWidth, flexBasis: wechatInspectorWidth }}>
          <div className="wechat-inspector-resize-handle" role="separator" aria-label="调整公众号面板宽度" aria-orientation="vertical" aria-valuemin={MIN_WECHAT_INSPECTOR_WIDTH} aria-valuemax={MAX_WECHAT_INSPECTOR_WIDTH} aria-valuenow={wechatInspectorWidth} tabIndex={0} title="拖动调整宽度；方向键微调" onPointerDown={startWechatInspectorResize} onKeyDown={resizeWechatInspectorWithKey}><button type="button" className="panel-collapse-button" aria-label="收起公众号面板" title="收起公众号面板" onPointerDown={(event) => event.stopPropagation()} onClick={closeWechatThemePreview}>›</button><span /></div>
          <aside className="wechat-inspector" aria-label="公众号排版与手机预览">
            <WechatThemePreview
              display="panel"
              html={previewHtml}
              themeId={wechatThemeId}
              themes={wechatThemes}
              definition={wechatThemeResolved.definition}
              fontFamily={previewFontStack(previewFontName)}
              markdown={draft}
              documentId={active.documentId}
              aiProviders={aiProviders}
              aiProviderId={aiProviderId}
              aiModelSlot={aiModelSlot}
              onAiProviderChange={setAiProviderId}
              aiThemeAppliedToEditor={Boolean(aiEditorThemeDefinition)}
              onApplyAiThemeToEditor={(nextDefinition) => {
                if (nextDefinition && !aiEditorThemeDefinition) {
                  wechatThemeBeforeAiRef.current = wechatThemeInWysiwyg;
                }
                setAiEditorThemeDefinition(nextDefinition);
                setWechatThemeInWysiwyg(nextDefinition ? true : wechatThemeBeforeAiRef.current);
                setStatus(nextDefinition ? "AI 排版已应用到写作区；只改变本机显示，不会修改 Markdown 或导出结果。" : "已恢复写作区原有显示。");
              }}
              onThemeChange={setWechatThemeId}
              onSaveAsCustom={saveWechatThemeAsCustom}
              onDeleteCustom={deleteWechatTheme}
              onExportCustom={() => void exportWechatTheme()}
              onImportCustom={(storage) => void importWechatTheme(storage)}
              onClose={closeWechatThemePreview}
            />
            <div className="wechat-inspector-actions" aria-label="公众号操作">
              <button type="button" onClick={() => setWechatApiConfigOpen(true)}>接口与封面设置</button>
              <button type="button" disabled={!outputReady || outputBusy} onClick={() => void exportDocument("wechat-clipboard")}>{wechatReplacements ? "重新生成公众号内容" : "准备公众号内容"}</button>
              <button type="button" disabled={!wechatReplacements || outputBusy || wechatReplacements.omittedCount > 0} onClick={() => void createWechatDraft()}>同步到草稿箱</button>
              <button type="button" className="primary" disabled={!wechatReplacements || outputBusy || wechatReplacements.omittedCount > 0} onClick={() => void publishWechatArticle()}>发布</button>
              <small>{wechatReplacements ? "内容已准备，可复制、同步草稿或在确认后发布。" : "先准备当前内容，再同步到公众号草稿箱。"}</small>
            </div>
          </aside>
          </div>
        )}
        {aiOpen && active && (
          <div className="ai-inspector-shell" style={{ width: aiInspectorWidth, flexBasis: aiInspectorWidth }}>
          <div className="ai-inspector-resize-handle" role="separator" aria-label="调整 AI 写作助手宽度" aria-orientation="vertical" aria-valuemin={MIN_WECHAT_INSPECTOR_WIDTH} aria-valuemax={MAX_WECHAT_INSPECTOR_WIDTH} aria-valuenow={aiInspectorWidth} tabIndex={0} title="拖动调整宽度；方向键微调" onPointerDown={startAiInspectorResize} onKeyDown={resizeAiInspectorWithKey}><button type="button" className="panel-collapse-button" aria-label="收起 AI 写作助手" title="收起 AI 写作助手" onPointerDown={(event) => event.stopPropagation()} onClick={closeAi}>›</button><span /></div>
          <aside className={`ai-inspector${aiChromeCollapsed && aiProvider?.status === "available" ? " is-chrome-collapsed" : ""}`} aria-label="AI 写作助手">
            <header><div><strong>AI 写作助手{aiModelTitleSuffix}</strong>{aiProvider?.status === "available" && <small>{aiProvider.version}</small>}</div><div className="ai-header-actions"><button type="button" className="ai-chrome-toggle" aria-pressed={aiChromeCollapsed} aria-label={aiChromeCollapsed ? "展开写作操作" : "收起写作操作"} title={aiChromeCollapsed ? "展开写作操作" : "收起写作操作，扩大对照区"} onClick={() => setAiChromeCollapsed((value) => !value)}>{aiChromeCollapsed ? "▾" : "▴"}</button><button type="button" aria-label="关闭 AI 写作助手" onClick={closeAi}>×</button></div></header>
            {!aiProvider || aiProvider.status !== "available" || (aiProviderId === "openai-compatible" && !customModelSlots[aiModelSlot]) ? <div className="ai-empty"><strong>请先配置 AI 提供商</strong><span>{aiProvider?.status === "unavailable" ? aiProvider.guidance : aiProviderId === "openai-compatible" ? "请在侧边栏选择或配置模型预设。" : "正在检测可用的 AI 提供商…"}</span><button type="button" onClick={openAiProviders}>打开侧边栏设置</button></div> : <>
              <div className="ai-actions" role="group" aria-label="AI 操作">{AI_ACTIONS.map((action) => <button key={action.id} type="button" title={action.help} className={aiAction === action.id ? "active" : ""} aria-pressed={aiAction === action.id} disabled={aiRequest?.status === "working"} onClick={() => setAiAction(action.id)}>{action.label}</button>)}</div>
                {aiAction === "custom" && <label className="ai-custom-field"><span>告诉 AI 要怎样处理</span><textarea className="ai-custom-instruction" aria-label="AI 自定义指令" maxLength={1000} placeholder="例如：改成适合公众号开头的语气；整理成三点列表；翻译成英文。" value={aiCustomInstruction} disabled={aiRequest?.status === "working"} onChange={(event) => setAiCustomInstruction(event.target.value)} /><small>{aiCustomInstruction.length}/1000 · 仅处理当前选区；没有选区时处理光标所在段落</small></label>}
              <button type="button" className="ai-generate" disabled={!aiProvider || aiProvider.status !== "available" || aiRequest?.status === "working" || selectionTranslationBusy || (aiAction === "custom" && !aiCustomInstruction.trim()) || (aiProviderId === "openai-compatible" && !customModelSlots[aiModelSlot])} onClick={() => void invokeAi()}>{aiRequest?.status === "working" ? "正在生成…" : aiRequest ? "重新生成" : "生成建议"}</button>
              <div className="ai-result" aria-live="polite">
                {!aiRequest && <><p className="ai-disclosure">仅发送当前选区；没有选区时发送光标所在段落。结果需确认后才会写入文档。</p><p>选择文字或把光标放在目标段落中，然后生成建议。</p></>}
                {aiRequest?.status === "working" && <p>{aiProvider?.displayName ?? "AI"} 正在处理当前{aiRequest.scope === "selection" ? "选区" : "段落"}…</p>}
                {aiRequest?.status === "failed" && <p className="error">{aiRequest.error}</p>}
                {aiRequest?.status === "stale" && <p className="error">正文已变化，旧建议不能应用。请重新生成。</p>}
                {aiRequest?.result !== undefined && <div className="ai-comparison" aria-label="AI 原文与建议对照" style={{ gridTemplateRows: `${aiComparisonRatio}fr 8px ${100 - aiComparisonRatio}fr` }}>
                  <section><header><strong>原文</strong><span>{aiRequest.anchor.expectedText.length} 字符</span></header><textarea ref={aiOriginalScrollRef} readOnly aria-label="AI 原文预览" value={aiRequest.anchor.expectedText} onScroll={(event) => syncAiComparisonScroll(event.currentTarget, aiSuggestionScrollRef.current)} /></section>
                  <div className="ai-comparison-handle split-handle" role="separator" aria-label="调整原文与 AI 建议的高度比例；使用上下方向键调整" aria-orientation="horizontal" aria-valuemin={MIN_SPLIT_RATIO} aria-valuemax={MAX_SPLIT_RATIO} aria-valuenow={Math.round(aiComparisonRatio)} tabIndex={0} onKeyDown={resizeAiComparisonWithKeyboard} onPointerDown={startAiComparisonResize}><span /></div>
                  <section><header><strong>AI 建议</strong><span>{aiRequest.result.length - aiRequest.anchor.expectedText.length >= 0 ? "+" : ""}{aiRequest.result.length - aiRequest.anchor.expectedText.length} 字符</span></header><pre ref={(node) => { aiSuggestionScrollRef.current = node; }} className="ai-suggestion-diff" aria-label="AI 建议预览" onScroll={(event) => syncAiComparisonScroll(event.currentTarget, aiOriginalScrollRef.current)}>{suggestionDiffSegments(aiRequest.anchor.expectedText, aiRequest.result).map((segment, index) => segment.changed ? <mark key={index} className="ai-diff-changed">{segment.text}</mark> : <span key={index}>{segment.text}</span>)}</pre></section>
                </div>}
              </div>
              {aiRequest?.status === "working" && <button type="button" className="ai-secondary" onClick={() => void window.fantasticEditor.cancelAi({ requestId: aiRequest.requestId })}>停止</button>}
              {aiRequest?.status === "ready" && <div className="ai-review-actions"><button type="button" className="primary" onClick={() => void applyAiSuggestion()}>应用到正文</button><button type="button" onClick={() => setAiRequest(null)}>放弃</button><button type="button" onClick={() => void navigator.clipboard.writeText(aiRequest.result ?? "")}>复制</button></div>}
              {aiRequest?.status === "applied" && <p className="ai-applied">已应用，可按 Ctrl+Z 撤销。</p>}
            </>}

          </aside>
          </div>
        )}
      </div>

      {searchOpen && <section className="search-panel" role="search" aria-label={searchReplaceOpen ? "查找和替换" : "查找"}>
        <div className="search-row"><input ref={searchInputRef} value={searchQuery} placeholder="查找…" aria-label="查找文本" onChange={(event) => { setSearchQuery(event.target.value); searchIndexRef.current = -1; }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); findInCurrentView(event.shiftKey ? -1 : 1); } }} /><button type="button" title="上一个" onClick={() => findInCurrentView(-1)}>↑</button><button type="button" title="下一个" onClick={() => findInCurrentView(1)}>↓</button><span className="search-count">{searchResult.total ? `${searchResult.index}/${searchResult.total}` : "无结果"}</span><button type="button" className="search-close" aria-label="关闭查找" onClick={() => { setSearchOpen(false); clearSearch(); }}>×</button></div>
        <div className="search-options"><button type="button" className={searchReplaceOpen ? "active" : ""} aria-pressed={searchReplaceOpen} onClick={() => setSearchReplaceOpen((value) => !value)}>显示替换</button><button type="button" className={searchCaseSensitive ? "active" : ""} aria-pressed={searchCaseSensitive} onClick={() => { setSearchCaseSensitive((value) => !value); searchIndexRef.current = -1; }}>区分大小写</button><button type="button" className={searchWholeWord ? "active" : ""} aria-pressed={searchWholeWord} onClick={() => { setSearchWholeWord((value) => !value); searchIndexRef.current = -1; }}>全词匹配</button><small>快捷键：Ctrl+H 直接打开替换</small></div>
        {searchReplaceOpen && <div className="search-row"><input value={replaceText} placeholder="替换为…" aria-label="替换文本" onChange={(event) => setReplaceText(event.target.value)} /><button type="button" disabled={!searchQuery} onClick={() => { const changed = markdownEditorRef.current?.replaceCurrent(searchQuery, replaceText, { caseSensitive: searchCaseSensitive, wholeWord: searchWholeWord }) ?? false; setStatus(changed ? "已替换当前匹配。" : "当前选择不是匹配文本，请先查找。"); findInCurrentView(1); }}>替换</button><button type="button" disabled={!searchQuery} onClick={() => { const count = markdownEditorRef.current?.replaceAll(searchQuery, replaceText, { caseSensitive: searchCaseSensitive, wholeWord: searchWholeWord }) ?? 0; setStatus(count > 0 ? `已替换 ${count} 处匹配。` : "没有可替换的匹配。"); searchIndexRef.current = -1; findInCurrentView(1); }}>全部替换</button><small>写作与源码模式均可替换</small></div>}
      </section>}

      {commandPaletteOpen && <div className="command-palette-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeCommandPalette(); }}>
        <section className="command-palette" role="dialog" aria-modal="true" aria-label="命令面板">
          <input ref={commandInputRef} value={commandQuery} aria-label="搜索命令" placeholder="输入命令…" onChange={(event) => setCommandQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && commandItems[0]?.enabled) { event.preventDefault(); runCommand(commandItems[0]); } }} />
          <div className="command-list">
            {commandItems.map((command) => <button type="button" key={command.label} disabled={!command.enabled} onClick={() => runCommand(command)}><span>{command.label}</span>{command.shortcut && <kbd>{command.shortcut}</kbd>}</button>)}
            {commandItems.length === 0 && <p>没有匹配的命令</p>}
          </div>
        </section>
      </div>}

      <aside className="settings-popover" hidden={!settingsOpen} aria-label="设置与关于">
        <header><strong>设置与关于</strong><button type="button" aria-label="关闭设置" onClick={() => setSettingsOpen(false)}>×</button></header>
        <button type="button" disabled={!active} onClick={() => void openHistory()}><Icon name="list" size={16} /><span>文档历史</span></button>
        <div className="settings-about" data-testid="app-about"><strong>fantastic-editor v{packageMetadata.version}</strong><span>作者：{packageMetadata.author.name}</span><span>{packageMetadata.author.email}</span>{documentPerformance && <small className={`performance-metric is-${documentPerformance.level}`} aria-label={documentPerformanceDescription(documentPerformance)}>{documentPerformanceLabel(documentPerformance)}</small>}</div>
      </aside>

      {historyOpen && <div className="history-overlay" role="dialog" aria-modal="true" aria-label="文档历史" onMouseDown={(event) => { if (event.target === event.currentTarget && !historyBusy) setHistoryOpen(false); }}><section className="history-dialog"><header><div><strong>文档历史</strong><small>仅记录手动保存且内容不同的版本，最多保留 20 个</small></div><button type="button" aria-label="关闭文档历史" disabled={historyBusy} onClick={() => setHistoryOpen(false)}>×</button></header><div className="history-list">{historyBusy && <p>正在读取…</p>}{!historyBusy && historyItems.length === 0 && <p>还没有历史版本。保存文档后会自动生成。</p>}{historyItems.map((item) => <button type="button" key={item.snapshotId} disabled={historyBusy} onClick={() => void restoreHistory(item.snapshotId)}><strong>{new Date(item.createdAt).toLocaleString("zh-CN")}</strong><span>{item.characterCount.toLocaleString()} 字符</span><small>恢复此版本</small></button>)}</div></section></div>}

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
          <div className="replacement-notice"><strong>粘贴后请不要点公众号编辑器里的“一键排版”。</strong>那是微信后台自己的排版，会盖掉本软件已经编好的样式。</div>
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
      {diagnostics.length > 0 && <aside className="diagnostics" role="region" aria-live="polite" aria-atomic="true" aria-label="文档诊断"><div className="diagnostics-header"><strong>文档诊断 · {diagnostics.length} 项{editorMode === "wysiwyg" && <small>（行号为 Markdown 文档位置，点击提示可跳转）</small>}</strong><span><button type="button" disabled={!diagnostics.some((item) => item.source)} title="上一项" aria-label="上一项诊断" onClick={() => navigateDiagnostic(-1)}>↑</button><button type="button" disabled={!diagnostics.some((item) => item.source)} title="下一项" aria-label="下一项诊断" onClick={() => navigateDiagnostic(1)}>↓</button><button type="button" onClick={retryPreview}>重新解析</button><button type="button" onClick={() => { diagnosticIndexRef.current = -1; setDiagnostics([]); }}>清除提示</button></span></div>{diagnostics.map((item) => item.source ? <button type="button" className={`diagnostic-item severity-${item.severity}`} key={item.key} title={`跳转到第 ${item.source.startLine} 行`} onClick={() => { diagnosticIndexRef.current = diagnostics.filter((candidate) => candidate.source).indexOf(item); revealDiagnostic(item); }}><span aria-hidden="true">{item.severity === "blocking" || item.severity === "error" ? "●" : item.severity === "warning" ? "▲" : "●"}</span>{item.text}</button> : <div className={`diagnostic-item severity-${item.severity}`} key={item.key}><span aria-hidden="true">●</span>{item.text}</div>)}</aside>}
      <WechatApiConfigDialog
        open={wechatApiConfigOpen}
        config={wechatApiConfig}
        onClose={closeWechatApiConfig}
        onSaved={applySavedWechatApiConfig}
      />
      <footer className="statusbar"><span className="status-message" role="status" aria-live="polite" aria-atomic="true"><i />{status}{previewRetryAvailable && <button type="button" className="status-retry" onClick={retryPreview}>重新解析</button>}</span><span className="status-meta"><span>{active ? (dirty ? "未保存" : "已保存") : "本地"}</span><span>{active ? (editorMode === "source" ? "源码" : "写作") : "欢迎"}</span><span title={`${writingStats.characters.toLocaleString()} 个非空白字符`}>{writingStats.words.toLocaleString()} 字词</span><span>约 {writingStats.readingMinutes} 分钟</span><label className="status-zoom" title="拖动调整编辑区文字大小；也可按住 Ctrl 滚轮。只影响屏幕显示，不改变导出结果"><span aria-hidden="true">−</span><input type="range" aria-label="编辑区文字缩放" min={MIN_PREVIEW_FONT_SIZE} max={MAX_PREVIEW_FONT_SIZE} step={1} value={previewFontSize} disabled={!active} onChange={(event) => setPreviewFontSize(normalizePreviewFontSize(event.target.value))} /><span aria-hidden="true">＋</span><small>{Math.round(previewFontSize / DEFAULT_PREVIEW_FONT_SIZE * 100)}%</small><button type="button" className="status-zoom-reset" title="文字缩放复位为 100%" aria-label="文字缩放复位" disabled={!active || previewFontSize === DEFAULT_PREVIEW_FONT_SIZE} onClick={() => setPreviewFontSize(DEFAULT_PREVIEW_FONT_SIZE)}>复位</button></label></span></footer>
      {dragActive && <div className="drop-overlay"><div className="drop-card"><span className="drop-icon"><Icon name="download" size={30} /></span><strong>释放以打开文档或插入图片</strong><span>Markdown 可在窗口打开；图片请放到编辑区的具体位置</span></div></div>}
    </main>
  );
}
