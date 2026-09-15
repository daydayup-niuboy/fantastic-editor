import { forwardRef, useEffect, useImperativeHandle, useRef, type CSSProperties, type DragEvent } from "react";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab, moveLineUp, redo, undo } from "@codemirror/commands";
import { moveLineDownWithSpace } from "./move-line-down";
import { markdown } from "@codemirror/lang-markdown";
import { Strikethrough } from "@lezer/markdown";
import { SearchQuery, search, setSearchQuery, openSearchPanel, closeSearchPanel } from "@codemirror/search";
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, Prec, Transaction } from "@codemirror/state";
import { EditorView, highlightActiveLine, highlightSpecialChars, keymap, lineNumbers } from "@codemirror/view";
import type { ImportedAssetReceipt, WechatThemeDefinition } from "@fantastic-editor/shared";
import { buildEditorClipboardPayload as buildClipboardPayload } from "./clipboard-paste";
import { createImageMarkdown, mapImageInsertionAnchor, type ImageInsertionAnchor } from "./image-insertion";
import { resolveClipboardPaste, type PasteIntent } from "./clipboard-paste";
import type { EditorSourceSelection, EditorViewportAnchor } from "./preview-sync";
import { applyWysiwygTextChange, type MarkdownSelectionMark, type WysiwygTextChange } from "./wysiwyg-transactions";
import { livePreviewExtension } from "./live-preview";
import { imageSnapshotFromHtml, livePreviewImages, setImageSnapshot } from "./live-preview-images";
import { tableSnapshotFromHtml, livePreviewTables, setTableSnapshot } from "./live-preview-tables";
import { formulaSnapshotFromHtml, livePreviewFormulas, setFormulaSnapshot } from "./live-preview-formulas";
import { buildCodeMirrorWechatThemeProjectionCss } from "./wechat-theme-projection";
import type { SearchNavigationResult, TextSearchOptions } from "./visible-text-search";
import { applyEditorTextReplacement, captureEditorTextAnchor, type EditorTextAnchor } from "./editor-text-transaction";

interface MarkdownEditorProps {
  imagePreviewHtml?: string;
  value: string;
  onChange(value: string): void;
  onImageDrop?(files: File[], anchorId: string): void;
  onDropRejected?(message: string): void;
  onViewportAnchorChange?(anchor: EditorViewportAnchor): void;
  onSelectionChange?(selection: EditorSourceSelection | null): void;
  onStatus?(message: string): void;
  livePreview?: boolean;
  fontFamily?: string;
  readingMaxWidth?: string;
  fontSize?: number;
  wechatThemeDefinition?: WechatThemeDefinition;
  typewriterMode?: boolean;
}

export interface MarkdownEditorHandle {
  createInsertionAnchor(coordinates?: { x: number; y: number }): string | null;
  discardInsertionAnchor(anchorId: string): void;
  selectionScreenRect(): { left: number; top: number; bottom: number } | null;
  insertImages(anchorId: string, receipts: readonly ImportedAssetReceipt[]): boolean;
  applyTextChange(change: WysiwygTextChange): string | null;
  undo(): boolean;
  redo(): boolean;
  selectedText(): string;
  captureTextAnchor(documentId: string): Promise<EditorTextAnchor | null>;
  applyTextReplacement(documentId: string, anchor: EditorTextAnchor, insert: string): Promise<boolean>;
  replaceDocument(expectedText: string, insert: string): boolean;
  find(query: string, direction?: number, previousIndex?: number, options?: TextSearchOptions): SearchNavigationResult;
  replaceCurrent(query: string, replacement: string, options?: TextSearchOptions): boolean;
  replaceAll(query: string, replacement: string, options?: TextSearchOptions): number;
  revealSourceRange(from: number, to: number): boolean;
  clearSearch(): void;
  focus(): void;
  toggleSelectionMark(mark: MarkdownSelectionMark): boolean;
  insertLink(url: string): boolean;
  moveSelection(direction: "up" | "down"): boolean;
  setBlockType(level: 0 | 1 | 2 | 3): boolean;
}

const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|svg)$/i;
const MARKDOWN_FILE = /\.(?:md|markdown)$/i;
const VIEWPORT_TRACKING_RATIO = 0.3;

export function createSearchQuery(query: string, options: TextSearchOptions): SearchQuery {
  return new SearchQuery({ search: query.trim(), caseSensitive: options.caseSensitive ?? false, wholeWord: options.wholeWord ?? false, literal: true });
}

export function searchMatches(state: EditorState, query: SearchQuery): Array<{ from: number; to: number }> {
  const matches: Array<{ from: number; to: number }> = [];
  const cursor = query.getCursor(state);
  for (let next = cursor.next(); !next.done; next = cursor.next()) matches.push({ from: next.value.from, to: next.value.to });
  return matches;
}

export function skipAutoClosedCharacter(view: EditorView): boolean {
  const selection = view.state.selection.main;
  if (!selection.empty || !/[（(\p{Pe}\p{Pf}'"]/u.test(view.state.sliceDoc(selection.head, selection.head + 1))) return false;
  view.dispatch({ selection: { anchor: selection.head + 1 }, userEvent: "select" });
  return true;
}

function centerTypewriterCaret(view: EditorView, position: number): void {
  const caret = view.coordsAtPos(position);
  if (!caret) return;
  const viewport = view.scrollDOM.getBoundingClientRect();
  view.scrollDOM.scrollTop += caret.top - viewport.top - viewport.height / 2 + (caret.bottom - caret.top) / 2;
}

const editorTabBinding = {
  ...indentWithTab,
  run: (view: EditorView) => skipAutoClosedCharacter(view) || indentWithTab.run!(view),
};

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(function MarkdownEditor(
  { value, imagePreviewHtml, onChange, onImageDrop, onDropRejected, onViewportAnchorChange, onSelectionChange, onStatus, livePreview = false, fontFamily, readingMaxWidth, fontSize, wechatThemeDefinition, typewriterMode = false },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const anchorsRef = useRef(new Map<string, ImageInsertionAnchor>());
  const anchorSequenceRef = useRef(0);
  const onChangeRef = useRef(onChange);
  const onViewportAnchorChangeRef = useRef(onViewportAnchorChange);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onStatusRef = useRef(onStatus);
  const literalPasteUntilRef = useRef(0);
  const livePreviewCompartmentRef = useRef(new Compartment());
  const typewriterModeRef = useRef(typewriterMode);
  const typewriterLineRef = useRef<number | null>(null);
  typewriterModeRef.current = typewriterMode;
  onChangeRef.current = onChange;
  onViewportAnchorChangeRef.current = onViewportAnchorChange;
  onSelectionChangeRef.current = onSelectionChange;
  onStatusRef.current = onStatus;

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
    selectionScreenRect() {
      const view = viewRef.current;
      if (!view) return null;
      const selection = view.state.selection.main;
      if (selection.empty) return null;
      const start = view.coordsAtPos(selection.from);
      const end = view.coordsAtPos(selection.to);
      if (!start || !end) return null;
      return {
        left: (start.left + end.right) / 2,
        top: Math.min(start.top, end.top),
        bottom: Math.max(start.bottom, end.bottom),
      };
    },
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
    selectedText() {
      const view = viewRef.current;
      if (!view) return "";
      const selection = view.state.selection.main;
      return selection.empty ? "" : view.state.sliceDoc(selection.from, selection.to);
    },
    captureTextAnchor(documentId) {
      const view = viewRef.current;
      return view ? captureEditorTextAnchor(documentId, view.state) : Promise.resolve(null);
    },
    applyTextReplacement(documentId, anchor, insert) {
      const view = viewRef.current;
      return view ? applyEditorTextReplacement(view, documentId, anchor, insert) : Promise.resolve(false);
    },
    replaceDocument(expectedText, insert) {
      const view = viewRef.current;
      if (!view || view.state.doc.toString() !== expectedText) return false;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert }, selection: { anchor: 0 }, scrollIntoView: true, userEvent: "input.history.restore" });
      view.focus();
      return true;
    },
    find(query, direction = 1, previousIndex = -1, options = {}) {
      const view = viewRef.current;
      const needle = query.trim();
      if (!view || !needle) return { index: 0, total: 0 };
      const searchQuery = createSearchQuery(needle, options);
      const matches = searchMatches(view.state, searchQuery);
      openSearchPanel(view);
      view.dispatch({ effects: setSearchQuery.of(searchQuery) });
      if (matches.length === 0) return { index: 0, total: 0 };
      const next = previousIndex >= 0
        ? (previousIndex + (direction < 0 ? matches.length - 1 : 1)) % matches.length
        : direction < 0 ? matches.length - 1 : 0;
      const match = matches[next]!;
      view.dispatch({ selection: { anchor: match.from, head: match.to }, scrollIntoView: true });
      return { index: next + 1, total: matches.length };
    },
    replaceCurrent(query, replacement, options = {}) {
      const view = viewRef.current;
      if (!view || !query) return false;
      const selection = view.state.selection.main;
      const matches = searchMatches(view.state, createSearchQuery(query, options));
      if (!matches.some((match) => match.from === selection.from && match.to === selection.to)) return false;
      view.dispatch({ changes: { from: selection.from, to: selection.to, insert: replacement }, selection: { anchor: selection.from + replacement.length }, userEvent: "input.replace" });
      view.focus();
      return true;
    },
    replaceAll(query, replacement, options = {}) {
      const view = viewRef.current;
      const needle = query.trim();
      if (!view || !needle) return 0;
      const changes = searchMatches(view.state, createSearchQuery(needle, options)).map(({ from, to }) => ({ from, to, insert: replacement }));
      if (changes.length === 0) return 0;
      view.dispatch({ changes, userEvent: "input.replace.all" });
      view.focus();
      return changes.length;
    },
    revealSourceRange(from, to) {
      const view = viewRef.current;
      if (!view || to <= from || from < 0 || to > view.state.doc.length) return false;
      view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
      view.focus();
      return true;
    },
    clearSearch() {
      const view = viewRef.current;
      if (!view) return;
      const position = view.state.selection.main.head;
      closeSearchPanel(view);
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "" })), selection: { anchor: position } });
    },
    focus() {
      viewRef.current?.requestMeasure();
      viewRef.current?.focus();
    },
    toggleSelectionMark(mark) {
      const view = viewRef.current;
      if (!view) return false;
      const selection = view.state.selection.main;
      const marker = mark === "bold" ? "**" : mark === "italic" ? "*" : "~~";
      if (selection.empty) {
        view.dispatch({
          changes: { from: selection.from, insert: marker + marker },
          selection: { anchor: selection.from + marker.length },
          userEvent: "input.format",
        });
      } else {
        const firstLine = view.state.doc.lineAt(selection.from);
        const lastOffset = selection.to > selection.from && selection.to === view.state.doc.lineAt(selection.to).from ? selection.to - 1 : selection.to;
        const lastLine = view.state.doc.lineAt(lastOffset);
        const fragments: Array<{ from: number; to: number }> = [];
        for (let lineNumber = firstLine.number; lineNumber <= lastLine.number; lineNumber += 1) {
          const line = view.state.doc.line(lineNumber);
          const prefixLength = /^(?: {0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+)/.exec(line.text)?.[0].length ?? 0;
          const from = Math.max(selection.from, line.from + prefixLength);
          const to = Math.min(selection.to, line.to);
          if (to > from) fragments.push({ from, to });
        }
        if (fragments.length === 0) return false;
        const isFormatted = (fragment: { from: number; to: number }) => fragment.from >= marker.length
          && fragment.to + marker.length <= view.state.doc.length
          && view.state.sliceDoc(fragment.from - marker.length, fragment.from) === marker
          && view.state.sliceDoc(fragment.to, fragment.to + marker.length) === marker;
        const allFormatted = fragments.every(isFormatted);
        const changes = fragments.flatMap((fragment) => allFormatted
          ? [
              { from: fragment.from - marker.length, to: fragment.from, insert: "" },
              { from: fragment.to, to: fragment.to + marker.length, insert: "" },
            ]
          : isFormatted(fragment) ? [] : [
              { from: fragment.from, insert: marker },
              { from: fragment.to, insert: marker },
            ]);
        const changeSet = view.state.changes(changes);
        view.dispatch({
          changes: changeSet,
          selection: {
            anchor: changeSet.mapPos(selection.anchor, selection.anchor <= selection.head ? 1 : -1),
            head: changeSet.mapPos(selection.head, selection.head >= selection.anchor ? -1 : 1),
          },
          userEvent: "input.format",
        });
      }
      view.focus();
      return true;
    },
    insertLink(url) {
      const view = viewRef.current;
      if (!view || !/^(?:https?:\/\/|mailto:|#|\/|\.\/|\.\.\/)/i.test(url.trim())) return false;
      const selection = view.state.selection.main;
      const label = selection.empty ? "链接文字" : view.state.sliceDoc(selection.from, selection.to);
      const insert = `[${label}](${url.trim()})`;
      view.dispatch({
        changes: { from: selection.from, to: selection.to, insert },
        selection: { anchor: selection.from + 1, head: selection.from + 1 + label.length },
        userEvent: "input.link",
      });
      view.focus();
      return true;
    },
    moveSelection(direction) {
      const view = viewRef.current;
      if (!view) return false;
      const moved = direction === "up" ? moveLineUp(view) : moveLineDownWithSpace(view);
      if (moved) view.focus();
      return moved;
    },
    setBlockType(level) {
      const view = viewRef.current;
      if (!view) return false;
      const selection = view.state.selection.main;
      const firstLine = view.state.doc.lineAt(selection.from);
      const lastOffset = selection.to > selection.from && selection.to === view.state.doc.lineAt(selection.to).from ? selection.to - 1 : selection.to;
      const lastLine = view.state.doc.lineAt(lastOffset);
      const changes: Array<{ from: number; to: number; insert: string }> = [];
      for (let lineNumber = firstLine.number; lineNumber <= lastLine.number; lineNumber += 1) {
        const line = view.state.doc.line(lineNumber);
        if (!line.text.trim()) continue;
        const heading = /^( {0,3})#{1,6}[ \t]+/.exec(line.text);
        const from = line.from + (heading?.[1]?.length ?? 0);
        const to = line.from + (heading?.[0]?.length ?? 0);
        changes.push({ from, to, insert: level === 0 ? "" : `${"#".repeat(level)} ` });
      }
      if (changes.length === 0) return false;
      const changeSet = view.state.changes(changes);
      const mappedAnchor = changeSet.mapPos(selection.anchor, selection.empty || selection.anchor <= selection.head ? 1 : -1);
      const mappedHead = selection.empty ? mappedAnchor : changeSet.mapPos(selection.head, selection.head >= selection.anchor ? -1 : 1);
      view.dispatch({
        changes: changeSet,
        selection: { anchor: mappedAnchor, head: mappedHead },
        userEvent: "input.heading",
      });
      view.focus();
      return true;
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
          lineNumbers(), highlightSpecialChars(), history(), highlightActiveLine(), search({ createPanel: () => {
            // App owns the visible search controls; opening this panel enables CodeMirror's native match decorations.
            const dom = document.createElement("div");
            dom.hidden = true;
            return { dom };
          } }), closeBrackets(),
          bracketMatching(), syntaxHighlighting(defaultHighlightStyle, { fallback: true }), markdown({ extensions: [Strikethrough] }),
          livePreviewCompartmentRef.current.of(livePreview ? [livePreviewExtension, livePreviewImages, livePreviewTables, livePreviewFormulas] : []),
          Prec.highest(keymap.of([editorTabBinding])), keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap]), EditorView.lineWrapping,
          EditorView.domEventHandlers({
            keydown: (event, editorView) => {
              if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "v") {
                literalPasteUntilRef.current = Date.now() + 2000;
              }
              return false;
            },
            copy: (event, editorView) => {
              const selection = editorView.state.selection.main;
              if (editorView.state.selection.ranges.length !== 1 || selection.empty || !event.clipboardData) return false;
              const payload = buildClipboardPayload(editorView.state.sliceDoc(selection.from, selection.to));
              event.clipboardData.setData("text/plain", payload.plain);
              if (payload.html) event.clipboardData.setData("text/html", payload.html);
              event.preventDefault();
              for (const warning of payload.warnings) onStatusRef.current?.(warning);
              return true;
            },
            cut: (event, editorView) => {
              const selection = editorView.state.selection.main;
              if (editorView.state.selection.ranges.length !== 1 || selection.empty || !event.clipboardData) return false;
              const payload = buildClipboardPayload(editorView.state.sliceDoc(selection.from, selection.to));
              event.clipboardData.setData("text/plain", payload.plain);
              if (payload.html) event.clipboardData.setData("text/html", payload.html);
              editorView.dispatch({
                changes: { from: selection.from, to: selection.to, insert: "" },
                selection: { anchor: selection.from },
                userEvent: "delete.cut",
              });
              event.preventDefault();
              for (const warning of payload.warnings) onStatusRef.current?.(warning);
              return true;
            },
            paste: (event, editorView) => {
              const selection = editorView.state.selection.main;
              if (editorView.state.selection.ranges.length !== 1 || !event.clipboardData) return false;
              const intent: PasteIntent = literalPasteUntilRef.current >= Date.now() ? "literal" : "normal";
              literalPasteUntilRef.current = 0;
              const resolved = resolveClipboardPaste({
                plainText: event.clipboardData.getData("text/plain"),
                htmlText: event.clipboardData.getData("text/html"),
                intent,
              });
              if (resolved.rejected) {
                event.preventDefault();
                onStatusRef.current?.(resolved.warnings.join(" "));
                return true;
              }
              if (!resolved.markdown && !event.clipboardData.types.includes("Files")) return false;
              if (!resolved.markdown) return false;
              editorView.dispatch({
                changes: { from: selection.from, to: selection.to, insert: resolved.markdown },
                selection: { anchor: selection.from + resolved.markdown.length },
                userEvent: "input.paste",
              });
              event.preventDefault();
              if (resolved.warnings.length > 0) onStatusRef.current?.(resolved.warnings.join(" "));
              return true;
            },
          }),
          EditorView.updateListener.of((update) => {
            const typewriterLine = update.state.doc.lineAt(update.state.selection.main.head).number;
            if (update.docChanged) {
              for (const [anchorId, anchor] of anchorsRef.current) {
                anchorsRef.current.set(anchorId, mapImageInsertionAnchor(anchor, update.changes));
              }
              onChangeRef.current(update.state.doc.toString());
            }
            if (update.selectionSet || update.docChanged) emitSelection(update.view);
            if (update.selectionSet && typewriterModeRef.current) {
              const head = update.state.selection.main.head;
              const line = typewriterLine;
              if (typewriterLineRef.current !== line) {
                typewriterLineRef.current = line;
                centerTypewriterCaret(update.view, head);
              }
            }
            if (update.viewportChanged || update.docChanged) scheduleViewportAnchor();
          }),
        ],
      }),
    });
    viewRef.current = view;
    const clearLiteralPasteIntent = () => { literalPasteUntilRef.current = 0; };
    window.addEventListener("blur", clearLiteralPasteIntent);
    document.addEventListener("visibilitychange", clearLiteralPasteIntent);
    hostRef.current.addEventListener("contextmenu", clearLiteralPasteIntent);
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
      window.removeEventListener("blur", clearLiteralPasteIntent);
      document.removeEventListener("visibilitychange", clearLiteralPasteIntent);
      hostRef.current?.removeEventListener("contextmenu", clearLiteralPasteIntent);
      view.scrollDOM.removeEventListener("scroll", scheduleViewportAnchor);
      anchorsRef.current.clear();
      view.destroy();
      viewRef.current = null;
      literalPasteUntilRef.current = 0;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: livePreviewCompartmentRef.current.reconfigure(livePreview ? [livePreviewExtension, livePreviewImages, livePreviewTables, livePreviewFormulas] : []),
    });
    view.requestMeasure();
  }, [livePreview]);

  useEffect(() => {
    if (!typewriterMode) { typewriterLineRef.current = null; return; }
    const view = viewRef.current;
    if (!view) return;
    const head = view.state.selection.main.head;
    typewriterLineRef.current = view.state.doc.lineAt(head).number;
    centerTypewriterCaret(view, head);
  }, [typewriterMode]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      annotations: Transaction.addToHistory.of(false),
    });
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !livePreview || !imagePreviewHtml) return;
    view.dispatch({ effects: [
      setImageSnapshot.of(imageSnapshotFromHtml(value, imagePreviewHtml)),
      setTableSnapshot.of(tableSnapshotFromHtml(value, imagePreviewHtml)),
      setFormulaSnapshot.of(formulaSnapshotFromHtml(value, imagePreviewHtml)),
    ] });
  }, [value, imagePreviewHtml, livePreview]);

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

  const editorStyle = {
    "--live-font-family": fontFamily,
    "--live-reading-width": readingMaxWidth,
    "--live-font-size": fontSize ? `${fontSize}px` : undefined,
  } as CSSProperties;

  return <><div className={`editor-host${wechatThemeDefinition ? " wechat-theme-active" : ""}${typewriterMode ? " typewriter-mode" : ""}`} ref={hostRef} style={editorStyle} onDragOverCapture={(event) => {
    if ([...event.dataTransfer.items].some((item) => item.kind === "file")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  }} onDropCapture={handleDrop} />{livePreview && wechatThemeDefinition && <style>{buildCodeMirrorWechatThemeProjectionCss(wechatThemeDefinition)}</style>}</>;
});
