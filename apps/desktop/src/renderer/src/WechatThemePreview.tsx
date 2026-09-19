import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { sha256 } from "@fantastic-editor/document-core";
import { buildWechatThemeDefinition, compileWechatPublishHtml, normalizeWechatThemeTokens, type AiProviderId, type AiProviderStatus, type OfficialWechatThemeId, type WechatHeadingDecoration, type WechatThemeDefinition, type WechatThemeId, type WechatThemeListItem, type WechatThemeOverlayInput } from "@fantastic-editor/shared";
import { renderMermaidPreview } from "./mermaid-preview";
import { auditWechatMobileLayout, mobileAuditSummary, type WechatMobileAuditIssue } from "./wechat-mobile-audit";

interface WechatThemePreviewProps {
  html: string;
  themeId: WechatThemeId;
  themes: WechatThemeListItem[];
  definition: WechatThemeDefinition;
  fontFamily: string;
  markdown: string;
  documentId: string;
  aiProviders: AiProviderStatus[];
  aiProviderId: AiProviderId;
  onAiProviderChange(providerId: AiProviderId): void;
  aiThemeAppliedToEditor: boolean;
  onApplyAiThemeToEditor(definition: WechatThemeDefinition | null): void;
  onThemeChange(themeId: WechatThemeId): void;
  onSaveAsCustom(input: WechatThemeOverlayInput): Promise<boolean>;
  onDeleteCustom(themeId: string): Promise<boolean>;
  onExportCustom(): void;
  onImportCustom(storage: "workspace" | "global"): void;
  onClose(): void;
  display?: "dialog" | "panel";
}

function withoutLeadingPreviewTitle(html: string): string {
  return html.replace(/^\s*<h1(?:\s[^>]*)?>[\s\S]*?<\/h1>/i, "");
}

const MOBILE_WIDTHS = [320, 375, 414] as const;
type MobileWidth = (typeof MOBILE_WIDTHS)[number];
type AuditReports = Record<MobileWidth, WechatMobileAuditIssue[] | null>;

function emptyReports(): AuditReports {
  return { 320: null, 375: null, 414: null };
}

function newThemeRequestId(): string {
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (digit) =>
    (Number(digit) ^ crypto.getRandomValues(new Uint8Array(1))[0]! & 15 >> Number(digit) / 4).toString(16));
}

function themeLabel(theme: WechatThemeListItem): string {
  if (theme.source === "official") return theme.name;
  const hash = theme.shortHash ?? "------";
  return `${theme.name} · ${theme.baseThemeId} · ${hash}${theme.source === "workspace" ? " · 本文" : ""}`;
}

function WechatAuditProbe({ width, html, fontFamily, onResult }: { width: MobileWidth; html: string; fontFamily: string; onResult(width: MobileWidth, issues: WechatMobileAuditIssue[]): void }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const content = ref.current;
    if (!content) return;
    let cancelled = false;
    const audit = () => { if (!cancelled && ref.current) onResult(width, auditWechatMobileLayout(ref.current)); };
    const frame = requestAnimationFrame(() => {
      audit();
      void renderMermaidPreview(content, { darkMode: false, fontFamily }).then(audit).catch(audit);
    });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(audit);
    observer?.observe(content);
    return () => { cancelled = true; cancelAnimationFrame(frame); observer?.disconnect(); };
  }, [fontFamily, html, onResult, width]);
  return <article ref={ref} className="wechat-themed-content" style={{ width, fontFamily }} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function WechatThemePreview({ html, themeId, themes, definition, fontFamily, markdown, documentId, aiProviders, aiProviderId, onAiProviderChange, aiThemeAppliedToEditor, onApplyAiThemeToEditor, onThemeChange, onSaveAsCustom, onDeleteCustom, onExportCustom, onImportCustom, onClose, display = "dialog" }: WechatThemePreviewProps) {
  const [viewportWidth, setViewportWidth] = useState<MobileWidth>(375);
  const [reports, setReports] = useState<AuditReports>(() => emptyReports());
  const [customizing, setCustomizing] = useState(false);
  const [deleteThemeId, setDeleteThemeId] = useState("");
  const [confirmDeleteThemeId, setConfirmDeleteThemeId] = useState("");
  const [deletingTheme, setDeletingTheme] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customTokens, setCustomTokens] = useState({ ...definition.tokens });
  const [draftBaseThemeId, setDraftBaseThemeId] = useState<OfficialWechatThemeId>(definition.baseThemeId);
  const [aiInstruction, setAiInstruction] = useState("");
  const [aiState, setAiState] = useState<{ requestId?: string; status: "idle" | "working" | "ready" | "failed"; reason?: string; warnings?: string[]; error?: string }>({ status: "idle" });
  const contentRef = useRef<HTMLElement>(null);
  const identityRef = useRef({ documentId, markdown });
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const previewDraft = useMemo(() => {
    if (!customizing) return { definition, valid: true };
    try {
      return { definition: buildWechatThemeDefinition(draftBaseThemeId, normalizeWechatThemeTokens(draftBaseThemeId, customTokens)), valid: true };
    } catch {
      return { definition, valid: false };
    }
  }, [customTokens, customizing, definition, draftBaseThemeId]);
  const previewDefinition = useDeferredValue(previewDraft.definition);
  const themedHtml = useMemo(() => compileWechatPublishHtml({ fragment: withoutLeadingPreviewTitle(html), definition: previewDefinition, wrapperFontFromContext: fontFamily }), [fontFamily, html, previewDefinition]);
  const [auditedHtml, setAuditedHtml] = useState(themedHtml);
  const issues = reports[viewportWidth] ?? [];
  const allIssues = MOBILE_WIDTHS.flatMap((width) => reports[width] ?? []);
  const summary = Object.values(reports).some((report) => report === null) ? "running" : mobileAuditSummary(allIssues);
  const handleAuditResult = useCallback((width: MobileWidth, nextIssues: WechatMobileAuditIssue[]) => {
    setReports((current) => ({ ...current, [width]: nextIssues }));
  }, []);
  const deletableThemes = themes.filter((theme) => theme.source !== "official");
  const safeDeleteThemeId = deletableThemes.some((theme) => theme.id === deleteThemeId) ? deleteThemeId : "";
  const hasCustomThemes = themes.some((theme) => theme.source !== "official");

  useEffect(() => {
    if (customizing) return;
    const selected = themes.find((theme) => theme.id === themeId);
    setCustomName(selected?.name ? `${selected.name} 自定义` : "自定义主题");
    setDraftBaseThemeId(definition.baseThemeId);
    setCustomTokens({ ...definition.tokens, sizeBodyPx: [15, 16, 17].includes(definition.tokens.sizeBodyPx) ? definition.tokens.sizeBodyPx : 16 });
  }, [customizing, definition, themeId, themes]);

  useEffect(() => {
    identityRef.current = { documentId, markdown };
    setAiState({ status: "idle" });
  }, [documentId, markdown]);
  useEffect(() => () => { if (aiState.requestId) void window.fantasticEditor.cancelAi({ requestId: aiState.requestId }); }, [aiState.requestId]);

  const generateAiTheme = async () => {
    const provider = aiProviders.find((item) => item.providerId === aiProviderId);
    if (!provider || provider.status !== "available") { setAiState({ status: "failed", error: "请先在 AI 写作助手中配置或启用这个提供商。" }); return; }
    const disclosureKey = `fantastic-editor-ai-disclosure-accepted:${aiProviderId}`;
    if (window.localStorage.getItem(disclosureKey) !== "true") {
      if (!window.confirm(`AI 排版会把当前 Markdown 正文发送给 ${provider.displayName} 分析，但不会自动修改正文或发布。是否继续？`)) return;
      window.localStorage.setItem(disclosureKey, "true");
    }
    const identity = { documentId, markdown };
    const sourceHash = await sha256(markdown);
    const requestId = newThemeRequestId();
    setAiState({ requestId, status: "working" });
    const result = await window.fantasticEditor.suggestWechatTheme({ requestId, providerId: aiProviderId, documentId, sourceHash, content: markdown, ...(aiInstruction.trim() ? { instruction: aiInstruction.trim() } : {}) });
    if (identityRef.current.documentId !== identity.documentId || identityRef.current.markdown !== identity.markdown) return;
    if (result.status === "cancelled") { setAiState({ status: "idle" }); return; }
    if (result.status === "failed") { setAiState({ status: "failed", error: result.error }); return; }
    setDraftBaseThemeId(result.suggestion.baseThemeId);
    setCustomTokens({ ...normalizeWechatThemeTokens(result.suggestion.baseThemeId, result.suggestion.tokens) });
    setCustomName(`AI 排版 · ${new Date().toLocaleDateString()}`);
    setCustomizing(true);
    setAiState({ status: "ready", reason: result.suggestion.reason, warnings: result.suggestion.warnings });
  };

  useEffect(() => {
    const available = themes.filter((theme) => theme.source !== "official");
    if (!available.some((theme) => theme.id === deleteThemeId)) setDeleteThemeId(available[0]?.id ?? "");
  }, [deleteThemeId, themeId, themes]);

  useEffect(() => {
    if (confirmDeleteThemeId && confirmDeleteThemeId !== safeDeleteThemeId) setConfirmDeleteThemeId("");
  }, [confirmDeleteThemeId, safeDeleteThemeId]);

  useEffect(() => {
    const timeout = window.setTimeout(() => setAuditedHtml(themedHtml), 300);
    return () => window.clearTimeout(timeout);
  }, [themedHtml]);

  const submitCustomTheme = async () => {
    if (!previewDraft.valid) return;
    if (await onSaveAsCustom({ schemaVersion: "0.1", name: customName, baseThemeId: draftBaseThemeId, tokens: customTokens })) { setCustomizing(false); setAiState({ status: "idle" }); }
  };

  const requestDeleteTheme = async () => {
    if (!safeDeleteThemeId) return;
    if (confirmDeleteThemeId !== safeDeleteThemeId) {
      setConfirmDeleteThemeId(safeDeleteThemeId);
      return;
    }
    setDeletingTheme(true);
    try {
      if (await onDeleteCustom(safeDeleteThemeId)) setConfirmDeleteThemeId("");
    } finally {
      setDeletingTheme(false);
    }
  };

  useEffect(() => setReports(emptyReports()), [fontFamily, themedHtml]);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (display !== "dialog") return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])];
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [display]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const timeout = window.setTimeout(() => {
      void renderMermaidPreview(content, { darkMode: false, fontFamily }).catch(() => undefined);
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [fontFamily, themedHtml, viewportWidth]);

  return (
    <div className={display === "dialog" ? "wechat-preview-overlay" : "wechat-preview-panel"} role={display === "dialog" ? "dialog" : "region"} aria-modal={display === "dialog" ? true : undefined} aria-labelledby="wechat-preview-title" aria-describedby="wechat-preview-description" onMouseDown={(event) => { if (display === "dialog" && event.target === event.currentTarget) onClose(); }}>
      <section className={`wechat-preview-dialog${customizing ? " has-customizer" : ""}`} ref={dialogRef}>
        <header>
          <div><strong id="wechat-preview-title">公众号主题预览</strong><small id="wechat-preview-description">与复制正文共用同一主题编译器；首个 H1 将作为公众号标题，不在正文中重复。</small></div>
          <button ref={closeButtonRef} type="button" onClick={onClose} aria-label="关闭公众号主题预览">关闭</button>
        </header>
        <div className="wechat-preview-controls">
          <label>主题<select value={themeId} onChange={(event) => onThemeChange(event.target.value as WechatThemeId)}>{themes.map((theme) => <option key={`${theme.source}:${theme.slug ?? theme.id}`} value={theme.id}>{themeLabel(theme)}</option>)}</select></label>
          <button type="button" className="theme-save-button" onClick={() => setCustomizing(true)}>另存为自定义</button>
          {themes.find((theme) => theme.id === themeId)?.source !== "official" && <button type="button" onClick={onExportCustom}>导出主题</button>}
          <button type="button" onClick={() => onImportCustom("workspace")}>导入到本文</button>
          <button type="button" onClick={() => onImportCustom("global")}>导入到全局</button>
          {hasCustomThemes && <label>删除<select value={safeDeleteThemeId} disabled={!safeDeleteThemeId || deletingTheme} title="选择要删除的自定义主题；删除当前主题后会切回其官方基底" onChange={(event) => { setDeleteThemeId(event.target.value); setConfirmDeleteThemeId(""); }}>{deletableThemes.map((theme) => <option key={`${theme.source}:${theme.slug ?? theme.id}`} value={theme.id}>{theme.name}{theme.id === themeId ? " · 当前" : ""}</option>)}</select></label>}
          {hasCustomThemes && <button type="button" className="theme-delete-button" disabled={!safeDeleteThemeId || deletingTheme} title="需要再次点击确认删除" onClick={() => void requestDeleteTheme()}>{deletingTheme ? "删除中…" : confirmDeleteThemeId === safeDeleteThemeId && safeDeleteThemeId ? "确认删除" : "删除主题"}</button>}
          <span className="viewport-buttons" role="group" aria-label="手机宽度">{MOBILE_WIDTHS.map((width) => { const widthSummary = reports[width] === null ? "running" : mobileAuditSummary(reports[width]!); return <button type="button" aria-pressed={viewportWidth === width} className={`${viewportWidth === width ? "active " : ""}${widthSummary}`} key={width} onClick={() => setViewportWidth(width)}><i />{width}px</button>; })}</span>
          <span className={`mobile-audit-state ${summary}`}><i />{summary === "running" ? "三档宽度审计中" : summary === "passed" ? "三档宽度全部通过" : summary === "review" ? "存在可滚动内容，建议复核" : "检测到质量警告"}</span>
        </div>
        <section className="wechat-ai-layout" aria-label="AI 一键排版">
          <div><strong>AI 一键排版</strong><small>分析当前 Markdown，只建议安全主题参数；不会改正文。先预览，满意后再保存。</small></div>
          <select aria-label="AI 排版提供商" value={aiProviderId} disabled={aiState.status === "working"} onChange={(event) => onAiProviderChange(event.target.value as AiProviderId)}>{aiProviders.map((provider) => <option key={provider.providerId} value={provider.providerId}>{provider.displayName}{provider.status === "unavailable" ? "（不可用）" : ""}</option>)}</select>
          <input aria-label="AI 排版偏好" maxLength={1000} placeholder="可选：例如简洁科技风、适合科普长文" value={aiInstruction} disabled={aiState.status === "working"} onChange={(event) => setAiInstruction(event.target.value)} />
          <button type="button" disabled={aiState.status === "working" || !markdown.trim()} onClick={() => void generateAiTheme()}>{aiState.status === "working" ? "分析中…" : aiState.status === "ready" ? "重新生成" : "一键排版"}</button>
          {aiState.status === "ready" && <button type="button" className="secondary" onClick={() => onApplyAiThemeToEditor(aiThemeAppliedToEditor ? null : previewDraft.definition)}>{aiThemeAppliedToEditor ? "恢复写作区" : "应用到写作区"}</button>}
          {aiState.status === "working" && <button type="button" onClick={() => { if (aiState.requestId) void window.fantasticEditor.cancelAi({ requestId: aiState.requestId }); }}>停止</button>}
          {aiState.reason && <p><b>建议：</b>{aiState.reason}{aiState.warnings?.length ? ` · 提醒：${aiState.warnings.join("；")}` : ""}</p>}
          {aiState.error && <p className="error">{aiState.error}</p>}
        </section>
        {customizing && <section className="wechat-theme-customizer" aria-label="另存为自定义主题">
          <header><strong>另存为自定义</strong><span>基于 {draftBaseThemeId}（只读）</span></header>
          <label>名称<input value={customName} maxLength={64} onChange={(event) => setCustomName(event.target.value)} /></label>
          <div className="theme-color-grid">
            {(["accent", "text", "page", "heading"] as const).map((key) => <label key={key}>{key}<span><input type="color" value={customTokens[key]} onChange={(event) => setCustomTokens((current) => ({ ...current, [key]: event.target.value }))} /><input value={customTokens[key]} onChange={(event) => setCustomTokens((current) => ({ ...current, [key]: event.target.value }))} /></span></label>)}
          </div>
          <label>字号<select value={customTokens.sizeBodyPx} onChange={(event) => setCustomTokens((current) => ({ ...current, sizeBodyPx: Number(event.target.value) as 15 | 16 | 17 }))}><option value={15}>15px</option><option value={16}>16px</option><option value={17}>17px</option></select></label>
          <label>对齐<select value={customTokens.align} onChange={(event) => setCustomTokens((current) => ({ ...current, align: event.target.value as "left" | "justify" }))}><option value="left">左对齐</option><option value="justify">两端对齐</option></select></label>
          <label>标题装饰<select value={customTokens.headingDecoration} onChange={(event) => setCustomTokens((current) => ({ ...current, headingDecoration: event.target.value as WechatHeadingDecoration }))}><option value="none">无</option><option value="spark">星芒 ✦</option><option value="book">书页 ▣</option><option value="check">勾选 ✓</option></select></label>
          <div><button type="button" onClick={() => void submitCustomTheme()} disabled={!customName.trim() || !previewDraft.valid}>保存主题</button><button type="button" onClick={() => setCustomizing(false)}>取消</button></div>
        </section>}
        <div className="wechat-preview-workspace">
          <div className="wechat-phone-shell" style={{ width: viewportWidth + 28 }}>
            <div className="wechat-phone-bar"><span>公众号预览</span><small>{viewportWidth}px</small></div>
            <div className="wechat-phone-viewport" style={{ width: viewportWidth }}>
              <article ref={contentRef} className="wechat-themed-content" style={{ fontFamily }} dangerouslySetInnerHTML={{ __html: themedHtml }} />
            </div>
          </div>
          <aside className="wechat-audit-panel">
            <strong>移动宽度质量审计</strong>
            <p>三档宽度会自动并行检查；当前显示 {viewportWidth}px 的明细，按钮圆点表示各宽度结果。</p>
            {reports[viewportWidth] === null ? <div className="audit-running">正在等待字体、图片和 Mermaid 完成布局……</div> : issues.length === 0 ? <div className="audit-empty">未发现横向溢出、过小文字、低对比度或标题间距异常。</div> : <ul>{issues.map((issue, index) => <li className={issue.severity} key={`${issue.kind}-${issue.label}-${index}`}><b>{issue.severity === "warning" ? "警告" : "复核"}</b><span>{issue.label}{issue.overflowPixels ? ` · 超出约 ${issue.overflowPixels}px` : issue.contrastRatio ? ` · 对比度 ${issue.contrastRatio}:1` : issue.spacingPixels !== undefined ? ` · 间距约 ${issue.spacingPixels}px` : " · 字号小于 12px"}</span></li>)}</ul>}
            <small>这是本地布局审计，不能替代公众号后台保存、重开和手机预览。</small>
          </aside>
        </div>
        <div className="wechat-audit-probes" aria-hidden="true">{MOBILE_WIDTHS.map((width) => <WechatAuditProbe key={width} width={width} html={auditedHtml} fontFamily={fontFamily} onResult={handleAuditResult} />)}</div>
      </section>
    </div>
  );
}
