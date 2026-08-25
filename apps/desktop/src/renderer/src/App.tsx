import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent, type SyntheticEvent } from "react";
import type { OpenFileResult, OpenFolderResult, OutputCommandResult, PersistRecoveryRequest, PreviewDerivedUpdate, PreviewSession, WechatReplacementItem, WorkspaceFileEntry } from "@fantastic-editor/shared";
import { Icon } from "./Icon";
import { MarkdownEditor, type MarkdownEditorHandle } from "./MarkdownEditor";
import { SynchronizedPreview, type SynchronizedPreviewHandle } from "./SynchronizedPreview";
import { applyResolutionToPreviewHtml } from "./preview-assets";
import { applyPreviewDerivedUpdate, createPreviewSession } from "./preview-session";
import { ParseWorkerClient } from "./workers/parse-worker-client";
import { WelcomeScreen } from "./WelcomeScreen";

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

type ActiveWorkspace = NonNullable<OpenFolderResult["workspace"]>;

const EMPTY_DOCUMENT = "# fantastic-editor\n\n打开一个本地 Markdown 文件，开始编辑。\n";

export function App() {
  const [active, setActive] = useState<ActiveDocument | null>(null);
  const [tabs, setTabs] = useState<DocumentTab[]>([]);
  const tabsRef = useRef<DocumentTab[]>([]);
  const [workspace, setWorkspace] = useState<ActiveWorkspace | null>(null);
  const [draft, setDraft] = useState(EMPTY_DOCUMENT);
  const [previewHtml, setPreviewHtml] = useState("<h1>fantastic-editor</h1><p>打开一个本地 Markdown 文件，开始编辑。</p>");
  const parseWorkerRef = useRef<ParseWorkerClient | null>(null);
  const markdownEditorRef = useRef<MarkdownEditorHandle | null>(null);
  const synchronizedPreviewRef = useRef<SynchronizedPreviewHandle | null>(null);
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
  const [wechatReplacements, setWechatReplacements] = useState<{ jobId: string; items: WechatReplacementItem[] } | null>(null);
  const [handledReplacementIds, setHandledReplacementIds] = useState<Set<string>>(new Set());
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [status, setStatus] = useState("准备就绪");
  const [dragActive, setDragActive] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [viewMode, setViewMode] = useState<"editor" | "split" | "preview">("split");
  const [splitRatio, setSplitRatio] = useState(50);
  const [darkMode, setDarkMode] = useState(() => window.localStorage.getItem("fantastic-editor-theme") === "dark");
  const [syncScrollEnabled, setSyncScrollEnabled] = useState(() => window.localStorage.getItem("fantastic-editor-sync-scroll") === "true");
  const [previewSyncIdentity, setPreviewSyncIdentity] = useState<string | null>(null);
  const [recoveryReady, setRecoveryReady] = useState(false);
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
          setStatus(response.error);
          return;
        }
        previewSessionRef.current = null;
        setOutputReady(false);
        basePreviewHtmlRef.current = response.previewHtml;
        setPreviewHtml(response.previewHtml);
        const parseDiagnostics = response.diagnostics.map((item) => `${item.code}: ${item.message}`);
        setDiagnostics(parseDiagnostics);
        if (activeDocumentIdRef.current !== response.documentId) return;
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
            setStatus(commit.error ?? "主进程拒绝了当前解析版本。");
            return;
          }
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
          const combined = createPreviewSession(response, resolved);
          if (combined.status !== "accepted") {
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
          setOutputReady(true);
          setPreviewHtml(applyResolutionToPreviewHtml(response.previewHtml, session));
          setDiagnostics(session.diagnostics.map((item) => `${item.code}: ${item.message}`));
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
          if (client.isCurrent(response)) setStatus(error instanceof Error ? error.message : "资源解析失败。");
        });
      },
      onWorkerError: setStatus,
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
    setPreviewSyncIdentity(null);
    synchronizedPreviewRef.current?.clearTransientState();
    parseWorkerRef.current?.invalidate();
    const parseDelayMs = draft.length >= 1_000_000 ? 500 : draft.length >= 250_000 ? 300 : 180;
    const timer = window.setTimeout(() => {
      void parseWorkerRef.current?.parse(active?.documentId ?? "welcome-document", draft).catch((error: unknown) => {
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
    setOutputReady(false);
    setWechatReplacements(null);
    setHandledReplacementIds(new Set());
    pendingDerivedUpdateRef.current = null;
    imageRefreshAttemptsRef.current.clear();
    setActive(nextActive);
    setDraft(cached?.draft ?? result.session.editorText);
    setStatus(result.session.requiresSave
      ? `已转换 ${result.session.displayName}；首次保存将写入确认后的 UTF-8 与换行格式`
      : `${result.session.isUntitled ? "已新建" : "已打开"} ${result.session.displayName}`);
  }, [updateTabs]);

  const newFile = useCallback(async () => {
    const result = await window.fantasticEditor.createUntitledFile();
    if (result.status === "opened") setWorkspace(null);
    acceptOpenedFile(result);
  }, [acceptOpenedFile]);

  const openFile = useCallback(async () => {
    const result = await window.fantasticEditor.openMarkdownFile();
    if (result.status === "opened") setWorkspace(null);
    acceptOpenedFile(result);
  }, [acceptOpenedFile]);

  const selectWorkspaceFile = useCallback(async (
    targetWorkspace: ActiveWorkspace,
    file: WorkspaceFileEntry,
    confirmDirty = true,
  ) => {
    if (confirmDirty && dirty && !window.confirm("当前修改尚未保存，仍要切换文件吗？")) return;
    const result = await window.fantasticEditor.openWorkspaceFile({
      workspaceId: targetWorkspace.workspaceId,
      workspaceRevision: targetWorkspace.workspaceRevision,
      fileId: file.fileId,
    });
    if (result.status === "opened") {
      updateTabs(() => []);
      setActive(null);
    }
    acceptOpenedFile(result, file.fileId);
  }, [acceptOpenedFile, dirty, updateTabs]);

  const openFolder = useCallback(async () => {
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
    setDraft(EMPTY_DOCUMENT);
    setStatus(`工作区 ${result.workspace.displayName} 中没有 Markdown 文件`);
  }, [dirty, selectWorkspaceFile, updateTabs]);

  const saveAs = useCallback(async (): Promise<ActiveDocument | null> => {
    if (!active) { setStatus("请先新建或打开一个 Markdown 文件"); return null; }
    const result = await window.fantasticEditor.saveCurrentFileAs({ sessionId: active.sessionId, editorText: draft });
    if (result.status === "saved") {
      const next: ActiveDocument = {
        ...active,
        displayName: result.displayName ?? active.displayName,
        savedText: draft,
        workspaceRevision: result.workspaceRevision ?? active.workspaceRevision,
        workspaceFileId: result.workspaceMode === "single-file" ? null : active.workspaceFileId,
        isUntitled: false,
        requiresSave: false,
      };
      setActive(next);
      updateTabs((current) => current.map((tab) => tab.sessionId === active.sessionId ? { ...tab, ...next, draft } : tab));
      if (result.workspaceMode === "single-file") setWorkspace(null);
      setStatus(`已另存为 ${next.displayName}`);
      return next;
    }
    if (result.status !== "cancelled") setStatus(result.error ?? "另存为未完成");
    return null;
  }, [active, draft, updateTabs]);

  const save = useCallback(async () => {
    if (!active) { setStatus("请先新建或打开一个 Markdown 文件"); return; }
    if (active.isUntitled) { await saveAs(); return; }
    const result = await window.fantasticEditor.saveCurrentFile({ sessionId: active.sessionId, editorText: draft });
    if (result.status === "saved") {
      const next = { ...active, savedText: draft, requiresSave: false, workspaceRevision: result.workspaceRevision ?? active.workspaceRevision };
      setActive(next);
      updateTabs((current) => current.map((tab) => tab.sessionId === active.sessionId ? { ...tab, ...next, draft } : tab));
      setStatus(`已保存 ${result.displayName ?? active.displayName}`);
    } else setStatus(result.error ?? "保存未完成");
  }, [active, draft, saveAs, updateTabs]);

  const describeOutputResult = useCallback((result: OutputCommandResult) => {
    if (result.status === "completed") {
      if (result.result?.target === "wechat-clipboard") {
        setWechatReplacements({ jobId: result.result.jobId, items: result.result.wechatReplacementItems ?? [] });
        setHandledReplacementIds(new Set());
        setStatus("公众号正文与编号占位已复制（方案 B）；请粘贴后逐项替换图片并在后台复核，当前结果不代表已发布。");
        return;
      }
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
    setStatus(result.error ?? "导出失败，请查看诊断信息。");
    if (result.result?.diagnostics.length) {
      setDiagnostics(result.result.diagnostics.map((item) => `${item.code}: ${item.message}`));
    }
  }, []);

  const exportDocument = useCallback(async (target: "offline-html" | "docx" | "pdf" | "wechat-clipboard") => {
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
      describeOutputResult(result);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "导出 IPC 调用失败。");
    } finally {
      setOutputBusy(false);
    }
  }, [active, describeOutputResult, outputReady]);

  const copyWechatReplacement = useCallback(async (item: WechatReplacementItem) => {
    const task = wechatReplacements;
    if (!task) return;
    const result = await window.fantasticEditor.copyWechatReplacement({ jobId: task.jobId, itemId: item.itemId });
    if (result.status === "copied") {
      setHandledReplacementIds((current) => new Set(current).add(item.itemId));
      setStatus(`已复制第 ${item.sequence} 项${item.kind === "formula" ? "公式图片" : "图片"}；请在公众号对应占位处粘贴。`);
    } else setStatus(result.error);
  }, [wechatReplacements]);

  const toggleReplacementHandled = useCallback((itemId: string) => {
    setHandledReplacementIds((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId); else next.add(itemId);
      return next;
    });
  }, []);

  const presentTab = useCallback((tab: DocumentTab) => {
    activeDocumentIdRef.current = tab.documentId;
    previewSessionRef.current = null;
    pendingDerivedUpdateRef.current = null;
    imageRefreshAttemptsRef.current.clear();
    setOutputReady(false);
    setWechatReplacements(null);
    setHandledReplacementIds(new Set());
    setActive({ sessionId: tab.sessionId, documentId: tab.documentId, displayName: tab.displayName, savedText: tab.savedText, workspaceRevision: tab.workspaceRevision, workspaceFileId: tab.workspaceFileId, isUntitled: tab.isUntitled, requiresSave: tab.requiresSave });
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
        setRecoveryReady(true);
        return;
      }
      if (result.status === "empty") {
        setStatus("准备就绪");
        setRecoveryReady(true);
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
      setRecoveryReady(true);
    }).catch((error: unknown) => {
      if (cancelled) return;
      setStatus(error instanceof Error ? `无法恢复上次会话：${error.message}` : "无法恢复上次会话。");
      setRecoveryReady(true);
    });
    return () => { cancelled = true; };
  }, [presentTab, updateTabs]);

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

  const closeTab = useCallback(async (tab: DocumentTab) => {
    if ((tab.requiresSave || tab.draft !== tab.savedText) && !window.confirm(`${tab.displayName} 尚未保存，确定关闭这个标签吗？`)) return;
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
      setDraft(EMPTY_DOCUMENT);
      setPreviewHtml("<h1>fantastic-editor</h1><p>新建、打开或拖入一个 Markdown 文件。</p>");
      setOutputReady(false);
      setStatus("没有打开的文档");
    }
  }, [active?.sessionId, presentTab, updateTabs]);

  const importImages = useCallback(async (files?: File[], existingAnchorId?: string) => {
    setDragActive(false);
    if (imageImportBusyRef.current) {
      if (existingAnchorId) markdownEditorRef.current?.discardInsertionAnchor(existingAnchorId);
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
      anchorId ??= markdownEditorRef.current?.createInsertionAnchor() ?? undefined;
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
      setHandledReplacementIds(new Set());
      if (activeDocumentIdRef.current !== target.documentId) {
        setStatus("图片已导入 assets，但当前已切换到其他文档，未插入 Markdown 引用。");
        return;
      }
      const inserted = markdownEditorRef.current?.insertImages(anchorId, result.receipts) ?? false;
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
      if (anchorId) markdownEditorRef.current?.discardInsertionAnchor(anchorId);
      imageImportBusyRef.current = false;
      setImageImportBusy(false);
    }
  }, [active, saveAs, updateTabs]);
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

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey) return;
      if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (event.shiftKey) void saveAs(); else void save();
      }
      if (event.key.toLowerCase() === "o") { event.preventDefault(); void openFile(); }
      if (event.key.toLowerCase() === "n") { event.preventDefault(); void newFile(); }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [newFile, openFile, save, saveAs]);

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
      setSplitRatio(Math.min(72, Math.max(28, ratio)));
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

  const title = useMemo(() => `${active?.displayName ?? "欢迎"}${dirty ? " · 未保存" : ""}`, [active?.displayName, dirty]);

  return (
    <main className={`app-shell${darkMode ? " theme-dark" : ""}${dragActive ? " drag-active" : ""}`} onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDragActive(true); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false); }} onDrop={(event) => void handleDrop(event)}>
      <header className="app-header">
        <div className="brand-lockup"><span className="brand-symbol">f</span><span className="brand-name">fantastic<span>editor</span></span></div>
        <div className="header-file-actions">
          <button type="button" className="icon-button" data-testid="new-document" title="新建文档 (Ctrl+N)" aria-label="新建文档" onClick={() => void newFile()}><Icon name="filePlus" /></button>
          <button type="button" className="icon-button" title="打开文件 (Ctrl+O)" aria-label="打开文件" onClick={() => void openFile()}><Icon name="folderOpen" /></button>
          <button type="button" className="icon-button" disabled={!active || !dirty} title="保存 (Ctrl+S)" aria-label="保存" onClick={() => void save()}><Icon name="save" /></button>
        </div>
        <div className="header-document"><span className={`document-state${dirty ? " dirty" : ""}`} /><span>{title}</span><small>{active ? "本地文档" : "本地优先 Markdown 编辑器"}</small></div>
        <div className="header-tools">
          <div className="view-switcher" aria-label="视图模式">
            <button type="button" className={viewMode === "editor" ? "active" : ""} disabled={!active} aria-label="仅编辑" title="仅编辑" onClick={() => setViewMode("editor")}><Icon name="markdown" /></button>
            <button type="button" className={viewMode === "split" ? "active" : ""} disabled={!active} aria-label="分栏" title="编辑与预览" onClick={() => setViewMode("split")}><Icon name="columns" /></button>
            <button type="button" className={viewMode === "preview" ? "active" : ""} disabled={!active} aria-label="仅预览" title="仅预览" onClick={() => setViewMode("preview")}><Icon name="eye" /></button>
          </div>
          <details className={`export-menu${!active || !outputReady || outputBusy ? " disabled" : ""}`}>
            <summary onClick={(event) => { if (!active || !outputReady || outputBusy) event.preventDefault(); }}><Icon name="download" /><span>{outputBusy ? "处理中" : "导出"}</span><Icon name="chevronDown" size={14} /></summary>
            <div className="export-popover">
              <div className="menu-heading">导出与发布</div>
              <button type="button" onClick={(event) => { (event.currentTarget.closest("details") as HTMLDetailsElement).open = false; void exportDocument("pdf"); }}><span className="format-badge pdf">PDF</span><span><strong>导出 PDF</strong><small>保持当前排版和公式</small></span></button>
              <button type="button" onClick={(event) => { (event.currentTarget.closest("details") as HTMLDetailsElement).open = false; void exportDocument("docx"); }}><span className="format-badge word">W</span><span><strong>导出 Word</strong><small>生成可继续编辑的 DOCX</small></span></button>
              <button type="button" onClick={(event) => { (event.currentTarget.closest("details") as HTMLDetailsElement).open = false; void exportDocument("offline-html"); }}><span className="format-badge html">&lt;/&gt;</span><span><strong>离线 HTML</strong><small>图片与公式完全自包含</small></span></button>
              <div className="menu-separator" />
              <button type="button" onClick={(event) => { (event.currentTarget.closest("details") as HTMLDetailsElement).open = false; void exportDocument("wechat-clipboard"); }}><span className="format-badge wechat">微</span><span><strong>复制到公众号</strong><small>内联样式与图片替换助手</small></span></button>
            </div>
          </details>
          <button type="button" className="icon-button theme-toggle" aria-label={darkMode ? "切换浅色主题" : "切换深色主题"} title={darkMode ? "浅色主题" : "深色主题"} onClick={() => setDarkMode((value) => !value)}><Icon name={darkMode ? "sun" : "moon"} /></button>
        </div>
      </header>

      <div className="workbench">
        <aside className="activity-bar" aria-label="主导航">
          <button type="button" className={sidebarVisible ? "active" : ""} aria-label="切换资源管理器" title="资源管理器" onClick={() => setSidebarVisible((value) => !value)}><Icon name="panelLeft" /></button>
          <button type="button" aria-label="新建文档" title="新建文档" onClick={() => void newFile()}><Icon name="filePlus" /></button>
          <button type="button" aria-label="打开文件夹" title="打开文件夹" onClick={() => void openFolder()}><Icon name="folder" /></button>
        </aside>

        {sidebarVisible && (
          <aside className="explorer-panel" aria-label="资源管理器">
            <div className="explorer-title"><span>资源管理器</span><button type="button" title="打开文件夹" aria-label="打开文件夹" onClick={() => void openFolder()}><Icon name="folderOpen" size={16} /></button></div>
            <section className="explorer-section">
              <div className="section-title"><span className="section-chevron">⌄</span><span>打开的编辑器</span><small>{tabs.length}</small></div>
              <div className="open-editors">
                {tabs.length === 0 && <p className="explorer-empty">尚未打开文档</p>}
                {tabs.map((tab) => (
                  <button type="button" className={active?.sessionId === tab.sessionId ? "active" : ""} key={tab.sessionId} onClick={() => void activateTab(tab)}>
                    <Icon name="markdown" size={15} /><span>{tab.displayName}</span>{(tab.requiresSave || tab.draft !== tab.savedText) && <i aria-label="未保存" />}
                  </button>
                ))}
              </div>
            </section>
            {workspace ? (
              <section className="explorer-section workspace-tree">
                <div className="section-title"><span className="section-chevron">⌄</span><span title={workspace.displayName}>{workspace.displayName}</span><small>{workspace.files.length}</small></div>
                <div className="workspace-files">
                  {workspace.files.map((file) => (
                    <button type="button" className={active?.workspaceFileId === file.fileId ? "active" : ""} key={file.fileId} title={file.relativePath} onClick={() => void selectWorkspaceFile(workspace, file)}><Icon name="file" size={14} /><span>{file.displayName}</span></button>
                  ))}
                </div>
              </section>
            ) : (
              <div className="explorer-onboarding"><Icon name="folder" size={28} /><strong>还没有打开文件夹</strong><span>打开工作区后，可以在这里快速切换 Markdown 文档。</span><button type="button" onClick={() => void openFolder()}>打开文件夹</button></div>
            )}
          </aside>
        )}

        <section className="main-area">
          <nav className="document-tabs" data-testid="document-tabs" aria-label="打开的文档">
            <div className="tab-strip">
              {tabs.map((tab) => {
                const tabDirty = tab.requiresSave || tab.draft !== tab.savedText;
                return (
                  <div className={`document-tab${active?.sessionId === tab.sessionId ? " active" : ""}`} key={tab.sessionId}>
                    <button type="button" className="tab-select" title={tab.displayName} onClick={() => void activateTab(tab)}><Icon name="markdown" size={14} /><span>{tab.displayName}</span>{tabDirty && <span className="dirty-dot" aria-label="未保存" />}</button>
                    <button type="button" className="tab-close" aria-label={`关闭 ${tab.displayName}`} onClick={() => void closeTab(tab)}>×</button>
                  </div>
                );
              })}
              <button type="button" className="new-tab" aria-label="新建文档" title="新建文档 (Ctrl+N)" onClick={() => void newFile()}>＋</button>
            </div>
            <span className="drop-hint" data-testid="drop-hint">拖入 Markdown 打开 · 图片拖到编辑区插入</span>
          </nav>

          {active ? (
            <section className={`document-stage view-${viewMode}`} style={viewMode === "split" ? { gridTemplateColumns: `minmax(0, ${splitRatio}fr) 6px minmax(0, ${100 - splitRatio}fr)` } : undefined}>
              <div className="pane editor-pane">
                <div className="pane-header"><span><Icon name="markdown" size={15} />源代码</span><div className="pane-actions"><small>Markdown</small><button type="button" className="insert-image-button" disabled={imageImportBusy} title="在光标处插入图片" aria-label="插入图片" onClick={() => void importImages()}><Icon name="imagePlus" size={15} />插入图片</button></div></div>
                <MarkdownEditor
                  ref={markdownEditorRef}
                  value={draft}
                  onViewportAnchorChange={(anchor) => synchronizedPreviewRef.current?.updateViewportAnchor(anchor)}
                  onSelectionChange={(selection) => synchronizedPreviewRef.current?.updateSelection(selection)}
                  onImageDrop={(files, anchorId) => void importImages(files, anchorId)}
                  onDropRejected={(message) => { setDragActive(false); setStatus(message); }}
                  onChange={(value) => {
                    setOutputReady(false);
                    setPreviewSyncIdentity(null);
                    synchronizedPreviewRef.current?.clearTransientState();
                    setWechatReplacements(null);
                    setHandledReplacementIds(new Set());
                    setDraft(value);
                    updateTabs((current) => current.map((tab) => tab.sessionId === active.sessionId ? { ...tab, draft: value } : tab));
                  }}
                />
              </div>
              {viewMode === "split" && <div className="split-handle" role="separator" aria-label="调整编辑与预览宽度" aria-orientation="vertical" onPointerDown={startResize}><span /></div>}
              <div className="pane preview-pane">
                <div className="pane-header">
                  <span><Icon name="eye" size={15} />实时预览</span>
                  <div className="pane-actions">
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
                      <Icon name="scrollSync" size={15} />同步滚动
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
                  onErrorCapture={handlePreviewImageError}
                  onLoadCapture={handlePreviewImageLoad}
                />
              </div>
            </section>
          ) : (
            <WelcomeScreen onNew={() => void newFile()} onOpen={() => void openFile()} onOpenFolder={() => void openFolder()} />
          )}
        </section>
      </div>

      {wechatReplacements && wechatReplacements.items.length > 0 && (
        <aside className="wechat-replacements" aria-label="公众号图片替换助手">
          <div className="replacement-header"><strong>公众号图片替换助手（方案 B）</strong><span>{handledReplacementIds.size}/{wechatReplacements.items.length} 已处理</span></div>
          <div className="replacement-list">
            {wechatReplacements.items.map((item) => (
              <div className="replacement-item" key={item.itemId}>
                <span className="replacement-number">{String(item.sequence).padStart(2, "0")}</span>
                <span className="replacement-description">{item.kind === "formula" ? "公式" : "图片"}：{item.label}<small>原文字符位置 {item.sourceOffset} · {item.mimeType}{item.width && item.height ? ` · ${item.width}×${item.height}` : ""}</small></span>
                <button type="button" onClick={() => void copyWechatReplacement(item)}>复制此图片</button>
                <label><input type="checkbox" checked={handledReplacementIds.has(item.itemId)} onChange={() => toggleReplacementHandled(item.itemId)} />已粘贴</label>
              </div>
            ))}
          </div>
          <div className="replacement-check">应用无法读取公众号最终草稿；全部勾选后仍需在公众号后台保存、重新打开并移动端预览。</div>
        </aside>
      )}
      {diagnostics.length > 0 && <aside className="diagnostics" aria-label="文档诊断">{diagnostics.map((item) => <div key={item}>{item}</div>)}</aside>}
      <footer className="statusbar"><span className="status-message"><i />{status}</span><span className="status-meta"><span>{active ? "Markdown" : "本地模式"}</span><span>{draft.length.toLocaleString()} 字符</span></span></footer>
      {dragActive && <div className="drop-overlay"><div className="drop-card"><span className="drop-icon"><Icon name="download" size={30} /></span><strong>释放以打开文档或插入图片</strong><span>Markdown 可在窗口打开；图片请放到编辑区的具体位置</span></div></div>}
    </main>
  );
}









