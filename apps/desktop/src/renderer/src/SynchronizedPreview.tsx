import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type CSSProperties,
  type ReactEventHandler,
} from "react";
import {
  mapSourceOffsetToPreviewY,
  selectionIsInsideAnchor,
  sourceRangesIntersect,
  type EditorSourceSelection,
  type EditorViewportAnchor,
  type PreviewSourceAnchor,
} from "./preview-sync";
import { renderMermaidPreview } from "./mermaid-preview";
import { applyVisibleTextSearch, clearVisibleTextSearch, type SearchNavigationResult } from "./visible-text-search";

interface SynchronizedPreviewProps {
  html: string;
  enabled: boolean;
  active: boolean;
  identityKey: string | null;
  fontFamily: string;
  readingMaxWidth?: string;
  previewFontSize?: number;
  darkMode: boolean;
  onStatus?: (message: string) => void;
  onMermaidRender?: (result: { rendered: number; failed: number; limited: number }) => void;
  onErrorCapture?: ReactEventHandler<HTMLDivElement>;
  onLoadCapture?: ReactEventHandler<HTMLDivElement>;
}

export interface SynchronizedPreviewHandle {
  updateViewportAnchor(anchor: EditorViewportAnchor): void;
  updateSelection(selection: EditorSourceSelection | null): void;
  clearTransientState(): void;
  revealSourceRange(from: number, to: number): boolean;
  find(query: string, direction?: number, previousIndex?: number): SearchNavigationResult;
  clearSearch(): void;
}

interface PreviewDomAnchor extends PreviewSourceAnchor {
  element: HTMLElement;
  isBlock: boolean;
}

function collectPreviewAnchors(container: HTMLElement, content: HTMLElement): PreviewDomAnchor[] {
  const containerRect = container.getBoundingClientRect();
  const anchors: PreviewDomAnchor[] = [];
  for (const element of content.querySelectorAll<HTMLElement>("[data-source-from][data-source-to][data-source-kind]")) {
    const sourceFrom = Number(element.dataset.sourceFrom);
    const sourceTo = Number(element.dataset.sourceTo);
    const rect = element.getBoundingClientRect();
    if (!Number.isFinite(sourceFrom) || !Number.isFinite(sourceTo) || sourceTo <= sourceFrom || rect.width <= 0 || rect.height <= 0) continue;
    anchors.push({
      sourceFrom,
      sourceTo,
      top: rect.top - containerRect.top + container.scrollTop,
      height: rect.height,
      kind: element.dataset.sourceKind ?? "unknown",
      element,
      isBlock: element.dataset.sourceBlock === "true",
    });
  }
  return anchors;
}

function minimalDomAnchors(anchors: PreviewDomAnchor[]): PreviewDomAnchor[] {
  return anchors.filter((candidate) => !anchors.some((other) =>
    other !== candidate && candidate.element.contains(other.element),
  ));
}

export const SynchronizedPreview = forwardRef<SynchronizedPreviewHandle, SynchronizedPreviewProps>(function SynchronizedPreview(
  { html, enabled, active, identityKey, fontFamily, readingMaxWidth = "820px", previewFontSize = 14, darkMode, onMermaidRender, onStatus, onErrorCapture, onLoadCapture },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const viewportAnchorRef = useRef<EditorViewportAnchor | null>(null);
  const selectionRef = useRef<EditorSourceSelection | null>(null);
  const frameRef = useRef<number | null>(null);
  const shouldScrollRef = useRef(false);
  const interactionReadyRef = useRef(false);
  interactionReadyRef.current = enabled && active && identityKey !== null;

  const clearOverlay = () => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    overlay.replaceChildren();
    overlay.dataset.boxCount = "0";
  };

  const drawSelection = () => {
    clearOverlay();
    if (!interactionReadyRef.current) return;
    const selection = selectionRef.current;
    const container = containerRef.current;
    const content = contentRef.current;
    const overlay = overlayRef.current;
    if (!selection || selection.to <= selection.from || !container || !content || !overlay) return;

    const anchors = collectPreviewAnchors(container, content);
    const exactVisualAnchors = anchors.filter((anchor) =>
      anchor.kind === "image" && selectionIsInsideAnchor(anchor, selection),
    );
    const blockAnchors = anchors.filter((anchor) =>
      anchor.isBlock && sourceRangesIntersect(anchor, selection),
    );
    const selected = minimalDomAnchors(exactVisualAnchors.length > 0 ? exactVisualAnchors : blockAnchors);
    const containerRect = container.getBoundingClientRect();

    for (const anchor of selected) {
      const rect = anchor.element.getBoundingClientRect();
      const box = document.createElement("span");
      box.className = "preview-selection-box";
      box.style.left = `${Math.max(0, rect.left - containerRect.left + container.scrollLeft - 4)}px`;
      box.style.top = `${Math.max(0, rect.top - containerRect.top + container.scrollTop - 3)}px`;
      box.style.width = `${Math.max(1, rect.width + 8)}px`;
      box.style.height = `${Math.max(1, rect.height + 6)}px`;
      overlay.append(box);
    }
    overlay.dataset.boxCount = String(selected.length);
  };

  const synchronizeScroll = () => {
    if (!interactionReadyRef.current) return;
    const viewportAnchor = viewportAnchorRef.current;
    const container = containerRef.current;
    const content = contentRef.current;
    if (!viewportAnchor || !container || !content) return;
    const anchors = collectPreviewAnchors(container, content);
    const previewY = mapSourceOffsetToPreviewY(anchors, viewportAnchor.sourceOffset);
    if (previewY === null) return;
    const maximum = Math.max(0, container.scrollHeight - container.clientHeight);
    const target = previewY - container.clientHeight * viewportAnchor.viewportRatio;
    container.scrollTop = Math.min(maximum, Math.max(0, target));
  };

  const scheduleUpdate = (includeScroll: boolean) => {
    if (includeScroll) shouldScrollRef.current = true;
    if (!interactionReadyRef.current || frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      if (!interactionReadyRef.current) return;
      if (shouldScrollRef.current) {
        shouldScrollRef.current = false;
        synchronizeScroll();
      }
      drawSelection();
    });
  };

  const clearTransientState = () => {
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    shouldScrollRef.current = false;
    clearOverlay();
  };

  useImperativeHandle(ref, () => ({
    updateViewportAnchor(anchor) {
      viewportAnchorRef.current = anchor;
      scheduleUpdate(true);
    },
    updateSelection(selection) {
      selectionRef.current = selection;
      scheduleUpdate(false);
    },
    clearTransientState,
    revealSourceRange(from, to) {
      const container = containerRef.current;
      const content = contentRef.current;
      if (!container || !content || !interactionReadyRef.current || to <= from) return false;
      const anchor = collectPreviewAnchors(container, content)
        .filter((candidate) => candidate.sourceFrom <= from && candidate.sourceTo >= to)
        .sort((left, right) => (left.sourceTo - left.sourceFrom) - (right.sourceTo - right.sourceFrom))[0];
      if (!anchor) return false;
      anchor.element.scrollIntoView({ block: "center", behavior: "smooth" });
      return true;
    },
    find(query, direction = 1, previousIndex = -1) {
      const content = contentRef.current;
      return content ? applyVisibleTextSearch(content, query, direction, previousIndex) : { index: 0, total: 0 };
    },
    clearSearch() {
      clearVisibleTextSearch();
    },
  }));

  useEffect(() => {
    if (!interactionReadyRef.current) {
      clearTransientState();
      return;
    }
    scheduleUpdate(true);
  }, [active, enabled, html, identityKey]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    let cancelled = false;
    delete content.dataset.mermaidError;
    const frame = window.requestAnimationFrame(() => {
      content.dataset.mermaidStarted = String(content.querySelectorAll("pre > code.language-mermaid").length);
      void renderMermaidPreview(content, { darkMode, fontFamily }).then((result) => {
        if (cancelled) return;
        onMermaidRender?.(result);
        scheduleUpdate(true);
      }).catch((error: unknown) => {
        if (cancelled) return;
        content.dataset.mermaidError = error instanceof Error ? error.message.slice(0, 300) : "Mermaid preview failed";
        onMermaidRender?.({ rendered: 0, failed: 1, limited: 0 });
      });
    });
    return () => { cancelled = true; window.cancelAnimationFrame(frame); };
  }, [darkMode, fontFamily, html]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const decorate = () => {
      content.querySelectorAll<HTMLElement>(".preview-code-toolbar").forEach((item) => item.remove());
      content.querySelectorAll<HTMLElement>("pre > code").forEach((code) => {
        const pre = code.parentElement;
        if (!pre || pre.closest(".mermaid-diagram")) return;
        pre.classList.add("preview-code-block");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "preview-code-toolbar";
        const language = code.className.match(/language-([\w-]+)/i)?.[1];
        button.textContent = "复制";
        button.ariaLabel = language ? `复制 ${language} 代码块` : "复制代码块";
        button.title = button.ariaLabel;
        button.addEventListener("click", async () => {
          const text = (code.textContent ?? "").replace(/\r\n?/g, "\n");
          try {
            if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
            await navigator.clipboard.writeText(text);
          } catch {
            const textarea = document.createElement("textarea");
            textarea.value = text;
            textarea.style.position = "fixed";
            textarea.style.opacity = "0";
            document.body.append(textarea);
            textarea.select();
            const copied = document.execCommand("copy");
            textarea.remove();
            if (!copied) {
              onStatus?.("代码复制失败，请选中代码后复制。");
              return;
            }
          }
          button.textContent = "已复制";
          onStatus?.("代码块已复制到系统剪贴板。");
          window.setTimeout(() => { if (button.isConnected) button.textContent = "复制"; }, 1200);
        });
        pre.append(button);
      });
    };
    decorate();
    const timer = window.setTimeout(decorate, 0);
    return () => window.clearTimeout(timer);
  }, [html, darkMode, fontFamily, onStatus]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => scheduleUpdate(true));
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => clearTransientState(), []);

  return (
    <div
      className="markdown-preview"
      ref={containerRef}
      style={{ fontFamily, fontSize: `${previewFontSize}px` } as CSSProperties}
      onErrorCapture={onErrorCapture}
      onLoadCapture={onLoadCapture}
    >
      <article className="preview-content" ref={contentRef} style={{ "--reading-max-width": readingMaxWidth } as CSSProperties} dangerouslySetInnerHTML={{ __html: html }} />
      <div className="preview-selection-layer" ref={overlayRef} data-box-count="0" aria-hidden="true" />
    </div>
  );
});
