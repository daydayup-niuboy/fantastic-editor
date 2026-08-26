import { forwardRef, useEffect, useImperativeHandle, useRef, type DragEvent } from "react";
import { defaultKeymap, history, historyKeymap, redo, undo } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, highlightSpecialChars, keymap, lineNumbers } from "@codemirror/view";
import type { ImportedAssetReceipt } from "@fantastic-editor/shared";
import { createImageMarkdown, mapImageInsertionAnchor, type ImageInsertionAnchor } from "./image-insertion";
import type { EditorSourceSelection, EditorViewportAnchor } from "./preview-sync";
import { applyWysiwygTextChange, type WysiwygTextChange } from "./wysiwyg-transactions";

interface MarkdownEditorProps {
  value: string;
  onChange(value: string): void;
  onImageDrop?(files: File[], anchorId: string): void;
  onDropRejected?(message: string): void;
  onViewportAnchorChange?(anchor: EditorViewportAnchor): void;
  onSelectionChange?(selection: EditorSourceSelection | null): void;
}

export interface MarkdownEditorHandle {
  createInsertionAnchor(coordinates?: { x: number; y: number }): string | null;
  discardInsertionAnchor(anchorId: string): void;
  insertImages(anchorId: string, receipts: readonly ImportedAssetReceipt[]): boolean;
  applyTextChange(change: WysiwygTextChange): string | null;
  undo(): boolean;
  redo(): boolean;
  focus(): void;
}

const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|svg)$/i;
const MARKDOWN_FILE = /\.(?:md|markdown)$/i;
const VIEWPORT_TRACKING_RATIO = 0.3;

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(function MarkdownEditor(
  { value, onChange, onImageDrop, onDropRejected, onViewportAnchorChange, onSelectionChange },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const anchorsRef = useRef(new Map<string, ImageInsertionAnchor>());
  const anchorSequenceRef = useRef(0);
  const onChangeRef = useRef(onChange);
  const onViewportAnchorChangeRef = useRef(onViewportAnchorChange);
  const onSelectionChangeRef = useRef(onSelectionChange);
  onChangeRef.current = onChange;
  onViewportAnchorChangeRef.current = onViewportAnchorChange;
  onSelectionChangeRef.current = onSelectionChange;

  const createAnchor = (coordinates?: { x: number; y: number }): string | null => {
    const view = viewRef.current;
    if (!view) return null;
    const selection = view.state.selection.main;
    const coordinatePosition = coordinates ? view.posAtCoords(coordinates) : null;
    const from = coordinatePosition ?? selection.from;
    const to = coordinatePosition ?? selection.to;
    const anchorId = `image-anchor-${Date.now()}-${++anchorSequenceRef.current}`;
    anchorsRef.current.set(anchorId, { from, to });
    return anchorId;
  };

  useImperativeHandle(ref, () => ({
    createInsertionAnchor: createAnchor,
    discardInsertionAnchor(anchorId) { anchorsRef.current.delete(anchorId); },
    insertImages(anchorId, receipts) {
      const view = viewRef.current;
      const anchor = anchorsRef.current.get(anchorId);
      anchorsRef.current.delete(anchorId);
      if (!view || !anchor || receipts.length === 0) return false;
      const insert = createImageMarkdown(receipts);
      view.dispatch({
        changes: { from: anchor.from, to: anchor.to, insert },
        selection: { anchor: anchor.from + insert.length },
        scrollIntoView: true,
        userEvent: "input",
      });
      view.focus();
      return true;
    },
    applyTextChange(change) {
      const view = viewRef.current;
      if (!view) return null;
      const currentText = view.state.doc.toString();
      const next = applyWysiwygTextChange(currentText, change);
      if (next === null) return null;
      view.dispatch({
        changes: { from: change.from, to: change.to, insert: change.insert },
        selection: { anchor: change.from + change.insert.length },
        userEvent: "input.wysiwyg",
      });
      return next;
    },
    undo() {
      const view = viewRef.current;
      return view ? undo(view) : false;
    },
    redo() {
      const view = viewRef.current;
      return view ? redo(view) : false;
    },
    focus() {
      viewRef.current?.requestMeasure();
      viewRef.current?.focus();
    },
  }));

  useEffect(() => {
    if (!hostRef.current) return;
    let viewportFrame: number | null = null;

    const emitSelection = (view: EditorView) => {
      const selection = view.state.selection.main;
      onSelectionChangeRef.current?.(selection.from === selection.to
        ? null
        : { from: selection.from, to: selection.to });
    };

    const emitViewportAnchor = () => {
      viewportFrame = null;
      const view = viewRef.current;
      if (!view) return;
      const scrollRect = view.scrollDOM.getBoundingClientRect();
      const contentRect = view.contentDOM.getBoundingClientRect();
      const coordinates = {
        x: Math.min(scrollRect.right - 1, Math.max(scrollRect.left + 1, contentRect.left + 4)),
        y: scrollRect.top + scrollRect.height * VIEWPORT_TRACKING_RATIO,
      };
      const sourceOffset = view.posAtCoords(coordinates) ?? view.viewport.from;
      onViewportAnchorChangeRef.current?.({ sourceOffset, viewportRatio: VIEWPORT_TRACKING_RATIO });
    };

    const scheduleViewportAnchor = () => {
      if (viewportFrame !== null) return;
      viewportFrame = window.requestAnimationFrame(emitViewportAnchor);
    };

    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(), highlightSpecialChars(), history(), drawSelection(), highlightActiveLine(),
          bracketMatching(), syntaxHighlighting(defaultHighlightStyle, { fallback: true }), markdown(),
          keymap.of([...defaultKeymap, ...historyKeymap]), EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              for (const [anchorId, anchor] of anchorsRef.current) {
                anchorsRef.current.set(anchorId, mapImageInsertionAnchor(anchor, update.changes));
              }
              onChangeRef.current(update.state.doc.toString());
            }
            if (update.selectionSet || update.docChanged) emitSelection(update.view);
            if (update.viewportChanged || update.docChanged) scheduleViewportAnchor();
          }),
        ],
      }),
    });
    viewRef.current = view;
    view.scrollDOM.addEventListener("scroll", scheduleViewportAnchor, { passive: true });
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(scheduleViewportAnchor);
    resizeObserver?.observe(view.scrollDOM);
    emitSelection(view);
    scheduleViewportAnchor();

    return () => {
      if (viewportFrame !== null) window.cancelAnimationFrame(viewportFrame);
      resizeObserver?.disconnect();
      view.scrollDOM.removeEventListener("scroll", scheduleViewportAnchor);
      anchorsRef.current.clear();
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    const files = [...event.dataTransfer.files];
    if (files.length === 0) return;
    const images = files.filter((file) => IMAGE_FILE.test(file.name));
    const markdownFiles = files.filter((file) => MARKDOWN_FILE.test(file.name));
    if (images.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (images.length !== files.length || markdownFiles.length > 0) {
      onDropRejected?.("Markdown 与图片不能混合拖入，请分开操作。");
      return;
    }
    const anchorId = createAnchor({ x: event.clientX, y: event.clientY });
    if (!anchorId) {
      onDropRejected?.("无法确定图片插入位置。");
      return;
    }
    onImageDrop?.(images, anchorId);
  };

  return <div className="editor-host" ref={hostRef} onDragOverCapture={(event) => {
    if ([...event.dataTransfer.items].some((item) => item.kind === "file")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  }} onDropCapture={handleDrop} />;
});