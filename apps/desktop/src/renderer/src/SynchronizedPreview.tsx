import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
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

interface SynchronizedPreviewProps {
  html: string;
  enabled: boolean;
  active: boolean;
  identityKey: string | null;
  onErrorCapture?: ReactEventHandler<HTMLDivElement>;
  onLoadCapture?: ReactEventHandler<HTMLDivElement>;
}

export interface SynchronizedPreviewHandle {
  updateViewportAnchor(anchor: EditorViewportAnchor): void;
  updateSelection(selection: EditorSourceSelection | null): void;
  clearTransientState(): void;
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
  { html, enabled, active, identityKey, onErrorCapture, onLoadCapture },
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
      onErrorCapture={onErrorCapture}
      onLoadCapture={onLoadCapture}
    >
      <article className="preview-content" ref={contentRef} dangerouslySetInnerHTML={{ __html: html }} />
      <div className="preview-selection-layer" ref={overlayRef} data-box-count="0" aria-hidden="true" />
    </div>
  );
});