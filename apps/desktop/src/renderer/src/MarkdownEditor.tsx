import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab, moveLineUp, redo, undo } from "@codemirror/commands";
import { moveLineDownWithSpace } from "./move-line-down";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
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
import { applyWysiwygTextChange, createMarkdownBlockInsertion, type MarkdownSelectionMark, type WysiwygTextChange } from "./wysiwyg-transactions";
import { livePreviewExtension, livePreviewMarkdownHighlight } from "./live-preview";
import { imageSnapshotFromHtml, livePreviewImages, setImageSnapshot } from "./live-preview-images";
import { tableSnapshotFromHtml, livePreviewTables, setTableSnapshot } from "./live-preview-tables";
import { formulaSnapshotFromHtml, livePreviewFormulas, setFormulaSnapshot } from "./live-preview-formulas";
import { livePreviewStructuredCode, setStructuredCodeSnapshot, structuredCodeSnapshotFromHtml } from "./live-preview-structured-code";
import { livePreviewMermaid, mermaidSnapshotFromHtml, setMermaidSnapshot } from "./live-preview-mermaid";
import { buildCodeMirrorWechatThemeProjectionCss } from "./wechat-theme-projection";
import type { SearchNavigationResult, TextSearchOptions } from "./visible-text-search";
import { applyEditorTextReplacement, captureEditorTextAnchor, type EditorTextAnchor } from "./editor-text-transaction";
import { DEFAULT_PREVIEW_FONT_SIZE } from "./preview-font";
import { shouldPrefixUntitledHeading } from "./untitled-heading";
import { defaultTranslationLanguage, TRANSLATION_LANGUAGES, type TranslationLanguageId } from "./selection-translation";

interface MarkdownEditorProps {
  imagePreviewHtml?: string;
  documentId: string | null;
  value: string;
  onChange(value: string, pasted: boolean): void;
  onImageDrop?(files: File[], anchorId: string): void;
  onInsertImages?(anchorId: string): void;
  onAiAssist?(instruction: string): void;
  onDropRejected?(message: string): void;
  onViewportAnchorChange?(anchor: EditorViewportAnchor): void;
  onSelectionChange?(selection: EditorSourceSelection | null): void;
  onTranslateSelection?(anchor: EditorTextAnchor, targetLanguage: TranslationLanguageId): Promise<string>;
  onCancelTranslation?(): void | Promise<void>;
  translationProviderLabel?: string;
  onStatus?(message: string): void;
  prefixUntitledHeading?: boolean;
  livePreview?: boolean;
  fontFamily?: string;
  readingMaxWidth?: string;
  fontSize?: number;
  wechatThemeDefinition?: WechatThemeDefinition;
  typewriterMode?: boolean;
  darkMode?: boolean;
  spellCheck?: boolean;
}

export function transactionsIncludePaste(transactions: readonly { isUserEvent(event: string): boolean }[]): boolean {
  return transactions.some((transaction) => transaction.isUserEvent("input.paste"));
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
  setBlockType(level: 0 | 1 | 2 | 3 | 4 | 5 | 6): boolean;
}

const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|svg)$/i;
const MARKDOWN_FILE = /\.(?:md|markdown)$/i;
const VIEWPORT_TRACKING_RATIO = 0.3;
const SELECTION_TRANSLATION_TIMEOUT_MS = 60_000;

interface SelectionTranslationAction {
  from: number;
  to: number;
  text: string;
  left: number;
  top: number;
}

interface SelectionTranslationPopover {
  anchor: EditorTextAnchor;
  targetLanguage: TranslationLanguageId;
  busy: boolean;
  retryPending?: boolean;
  result?: string | undefined;
  error?: string | undefined;
  request: number;
  copied: boolean;
}

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
  { value, imagePreviewHtml, documentId, onChange, onImageDrop, onInsertImages, onAiAssist, onDropRejected, onViewportAnchorChange, onSelectionChange, onTranslateSelection, onCancelTranslation, translationProviderLabel = "AI", onStatus, prefixUntitledHeading = false, livePreview = false, fontFamily, readingMaxWidth, fontSize, wechatThemeDefinition, typewriterMode = false, darkMode = false, spellCheck = true },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const anchorsRef = useRef(new Map<string, ImageInsertionAnchor>());
  const anchorSequenceRef = useRef(0);
  const onChangeRef = useRef(onChange);
  const onViewportAnchorChangeRef = useRef(onViewportAnchorChange);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onTranslateSelectionRef = useRef(onTranslateSelection);
  const onCancelTranslationRef = useRef(onCancelTranslation);
  const onInsertImagesRef = useRef(onInsertImages);
  const onAiAssistRef = useRef(onAiAssist);
  const translationProviderLabelRef = useRef(translationProviderLabel);
  const onStatusRef = useRef(onStatus);
  const literalPasteUntilRef = useRef(0);
  const prefixUntitledHeadingRef = useRef(prefixUntitledHeading);
  const livePreviewCompartmentRef = useRef(new Compartment());
  const spellCheckCompartmentRef = useRef(new Compartment());
  const typewriterModeRef = useRef(typewriterMode);
  const typewriterLineRef = useRef<number | null>(null);
  const typewriterPointerRef = useRef(false);
  const lastSentValueRef = useRef(value);
  const mouseSelectionRef = useRef(false);
  const mouseSelectionFinishFrameRef = useRef<number | null>(null);
  const translationSequenceRef = useRef(0);
  const translationOpeningRef = useRef(false);
  const popoverDragRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number; width: number; height: number } | null>(null);
  const contextMenuCleanupRef = useRef<(() => void) | null>(null);
  const [translationOpening, setTranslationOpening] = useState(false);
  const [selectionTranslationAction, setSelectionTranslationAction] = useState<SelectionTranslationAction | null>(null);
  const [selectionTranslationPopover, setSelectionTranslationPopover] = useState<SelectionTranslationPopover | null>(null);
  const [popoverPosition, setPopoverPosition] = useState<{ left: number; top: number } | null>(null);
  typewriterModeRef.current = typewriterMode;
  onChangeRef.current = onChange;
  onViewportAnchorChangeRef.current = onViewportAnchorChange;
  onSelectionChangeRef.current = onSelectionChange;
  onTranslateSelectionRef.current = onTranslateSelection;
  onCancelTranslationRef.current = onCancelTranslation;
  onInsertImagesRef.current = onInsertImages;
  onAiAssistRef.current = onAiAssist;
  translationProviderLabelRef.current = translationProviderLabel;
  onStatusRef.current = onStatus;
  prefixUntitledHeadingRef.current = prefixUntitledHeading;

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

  const dismissSelectionTranslation = () => {
    if (mouseSelectionFinishFrameRef.current !== null) {
      window.cancelAnimationFrame(mouseSelectionFinishFrameRef.current);
      mouseSelectionFinishFrameRef.current = null;
    }
    translationSequenceRef.current += 1;
    popoverDragRef.current = null;
    setSelectionTranslationAction(null);
    setSelectionTranslationPopover(null);
    setPopoverPosition(null);
    onCancelTranslationRef.current?.();
  };

  const translateSelection = async (anchor: EditorTextAnchor, targetLanguage: TranslationLanguageId) => {
    const request = ++translationSequenceRef.current;
    setSelectionTranslationPopover({ anchor, targetLanguage, busy: true, request, copied: false });
    const timeout = window.setTimeout(() => {
      if (request !== translationSequenceRef.current) return;
      translationSequenceRef.current += 1;
      setSelectionTranslationPopover((current) => current?.request === request
        ? { ...current, busy: false, retryPending: true, error: "翻译等待超过 60 秒，正在停止当前请求。请稍候重试。" }
        : current);
      void Promise.resolve().then(() => onCancelTranslationRef.current?.()).catch(() => undefined).finally(() => {
        setSelectionTranslationPopover((current) => current?.request === request
          ? { ...current, retryPending: false, error: "翻译等待超过 60 秒，已停止。请检查网络或更换模型后重试。" }
          : current);
      });
    }, SELECTION_TRANSLATION_TIMEOUT_MS);
    try {
      const result = await onTranslateSelectionRef.current?.(anchor, targetLanguage);
      if (request !== translationSequenceRef.current) return;
      if (!result?.trim()) throw new Error("模型没有返回译文，请重试或更换 AI 设置中的模型。");
      setSelectionTranslationPopover({ anchor, targetLanguage, busy: false, result: result.trim(), request, copied: false });
    } catch (error) {
      if (request !== translationSequenceRef.current) return;
      setSelectionTranslationPopover({ anchor, targetLanguage, busy: false, error: error instanceof Error ? error.message : String(error), request, copied: false });
    } finally {
      window.clearTimeout(timeout);
    }
  };

  const toggleSelectionMark = useCallback((mark: MarkdownSelectionMark): boolean => {
    const view = viewRef.current;
    if (!view) return false;
    const selection = view.state.selection.main;
    const marker = mark === "bold" ? "**" : mark === "italic" ? "*" : mark === "code" ? "`" : "~~";
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
  }, []);
  const insertLink = useCallback((url: string): boolean => {
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
  }, []);
  const setBlockType = useCallback((level: 0 | 1 | 2 | 3 | 4 | 5 | 6): boolean => {
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
    view.dispatch({ changes: changeSet, selection: { anchor: mappedAnchor, head: mappedHead }, userEvent: "input.heading" });
    view.focus();
    return true;
  }, []);

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
    toggleSelectionMark,
    insertLink,
    moveSelection(direction) {
      const view = viewRef.current;
      if (!view) return false;
      const moved = direction === "up" ? moveLineUp(view) : moveLineDownWithSpace(view);
      if (moved) view.focus();
      return moved;
    },
    setBlockType,
  }));

  useEffect(() => {
    if (!hostRef.current) return;
    let viewportFrame: number | null = null;

    const emitSelection = (view: EditorView) => {
      const selection = view.state.selection.main;
      onSelectionChangeRef.current?.(selection.from === selection.to
        ? null
        : { from: selection.from, to: selection.to });
      if (!mouseSelectionRef.current) dismissSelectionTranslation();
    };

    const finishMouseSelection = () => {
      if (!mouseSelectionRef.current) return;
      mouseSelectionRef.current = false;
      mouseSelectionFinishFrameRef.current = window.requestAnimationFrame(() => {
        mouseSelectionFinishFrameRef.current = null;
        const currentView = viewRef.current;
        const selection = currentView?.state.selection.main;
        if (!currentView || !selection || selection.empty) { dismissSelectionTranslation(); return; }
        const text = currentView.state.sliceDoc(selection.from, selection.to);
        const start = currentView.coordsAtPos(selection.from);
        const end = currentView.coordsAtPos(selection.to);
        if (!text.trim() || !start || !end) { dismissSelectionTranslation(); return; }
        const buttonSize = 16;
        const gap = 8;
        const edge = 8;
        const aboveLeft = { left: start.left, top: start.top - buttonSize - gap };
        const belowRight = { left: end.right - buttonSize, top: end.bottom + gap };
        const fits = ({ left, top }: { left: number; top: number }) => left >= edge && left + buttonSize <= window.innerWidth - edge && top >= edge && top + buttonSize <= window.innerHeight - edge;
        const placement = fits(aboveLeft) ? aboveLeft
          : fits(belowRight) ? belowRight
            : start.top - buttonSize - gap >= edge ? aboveLeft : belowRight;
        translationSequenceRef.current += 1;
        setSelectionTranslationPopover(null);
        onCancelTranslationRef.current?.();
        setSelectionTranslationAction({
          from: selection.from,
          to: selection.to,
          text,
          left: Math.max(edge, Math.min(placement.left, window.innerWidth - buttonSize - edge)),
          top: Math.max(edge, Math.min(placement.top, window.innerHeight - buttonSize - edge)),
        });
      });
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
          bracketMatching(), syntaxHighlighting(defaultHighlightStyle, { fallback: true }), markdown({ extensions: [Strikethrough, livePreviewMarkdownHighlight], codeLanguages: languages }),
          spellCheckCompartmentRef.current.of(EditorView.contentAttributes.of({ spellcheck: spellCheck ? "true" : "false", autocorrect: spellCheck ? "on" : "off" })),
          livePreviewCompartmentRef.current.of(livePreview ? [livePreviewExtension, livePreviewImages, livePreviewTables, livePreviewFormulas, livePreviewStructuredCode, livePreviewMermaid] : []),
          Prec.highest(keymap.of([editorTabBinding])), keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap]), EditorView.lineWrapping,
          EditorState.transactionFilter.of((tr) => {
            if (!prefixUntitledHeadingRef.current || !tr.docChanged) return tr;
            const offset = shouldPrefixUntitledHeading(tr.startState.doc.toString(), tr.newDoc.toString(), tr.isUserEvent("input.paste"));
            return offset === null ? tr : [tr, { changes: { from: offset, insert: "# " }, sequential: true }];
          }),
          EditorView.domEventHandlers({
            mousedown: (event) => {
              if (event.button === 0) {
                typewriterPointerRef.current = true;
                mouseSelectionRef.current = true;
                dismissSelectionTranslation();
              }
              return false;
            },
            mouseup: () => {
              typewriterPointerRef.current = false;
              return false;
            },
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
              if (editorView.state.selection.ranges.length !== 1) return false;
              const intent: PasteIntent = literalPasteUntilRef.current >= Date.now() ? "literal" : "normal";
              literalPasteUntilRef.current = 0;
              const resolved = resolveClipboardPaste({
                plainText: event.clipboardData?.getData("text/plain") ?? "",
                htmlText: event.clipboardData?.getData("text/html") ?? "",
                intent,
              });
              if (resolved.rejected) {
                event.preventDefault();
                onStatusRef.current?.(resolved.warnings.join(" "));
                return true;
              }
              if (!resolved.markdown) {
                if (event.clipboardData?.files.length) return false;
                event.preventDefault();
                const source = editorView.state.doc.toString();
                const { from, to } = selection;
                void window.fantasticEditor.readClipboard().then((clipboard) => {
                  if (viewRef.current !== editorView || !editorView.hasFocus) return;
                  const current = editorView.state.selection.main;
                  if (editorView.state.doc.toString() !== source || current.from !== from || current.to !== to) {
                    onStatusRef.current?.("正文或光标已变化；请在当前位置重新粘贴。");
                    return;
                  }
                  const fallback = resolveClipboardPaste({ ...clipboard, intent });
                  if (fallback.rejected || !fallback.markdown) {
                    onStatusRef.current?.(fallback.warnings.join(" ") || "剪贴板中没有可粘贴的文字；请在 Outlook 中重新复制后重试。");
                    return;
                  }
                  editorView.dispatch({
                    changes: { from, to, insert: fallback.markdown },
                    selection: { anchor: from + fallback.markdown.length },
                    userEvent: "input.paste",
                  });
                  if (fallback.warnings.length) onStatusRef.current?.(fallback.warnings.join(" "));
                }).catch(() => onStatusRef.current?.("无法读取系统剪贴板；请重新复制后重试。"));
                return true;
              }
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
              const nextValue = update.state.doc.toString();
              lastSentValueRef.current = nextValue;
              onChangeRef.current(nextValue, transactionsIncludePaste(update.transactions));
            }
            if (update.selectionSet || update.docChanged) emitSelection(update.view);
            if (update.selectionSet && typewriterModeRef.current && !typewriterPointerRef.current) {
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
    const clearTypewriterPointer = () => { typewriterPointerRef.current = false; };
    window.addEventListener("blur", clearLiteralPasteIntent);
    const finishMouseSelectionAndTypewriter = () => { clearTypewriterPointer(); finishMouseSelection(); };
    window.addEventListener("mouseup", finishMouseSelectionAndTypewriter);
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
      if (mouseSelectionFinishFrameRef.current !== null) window.cancelAnimationFrame(mouseSelectionFinishFrameRef.current);
      resizeObserver?.disconnect();
      window.removeEventListener("blur", clearLiteralPasteIntent);
      window.removeEventListener("mouseup", finishMouseSelectionAndTypewriter);
      document.removeEventListener("visibilitychange", clearLiteralPasteIntent);
      hostRef.current?.removeEventListener("contextmenu", clearLiteralPasteIntent);
      view.scrollDOM.removeEventListener("scroll", scheduleViewportAnchor);
      anchorsRef.current.clear();
      mouseSelectionRef.current = false;
      translationSequenceRef.current += 1;
      onCancelTranslationRef.current?.();
      view.destroy();
      viewRef.current = null;
      literalPasteUntilRef.current = 0;
    };
  }, []);

  useEffect(() => {
    dismissSelectionTranslation();
  }, [documentId, livePreview]);

  useEffect(() => {
    if (!selectionTranslationAction && !selectionTranslationPopover) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".selection-translate-trigger, .selection-translate-popover")) return;
      dismissSelectionTranslation();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismissSelectionTranslation();
    };
    const closeOnScroll = () => { if (!selectionTranslationPopover) dismissSelectionTranslation(); };
    const closeOnResize = () => {
      if (!selectionTranslationPopover) { dismissSelectionTranslation(); return; }
      const rect = document.querySelector(".selection-translate-popover")?.getBoundingClientRect();
      if (rect) setPopoverPosition({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8)),
        top: Math.max(8, Math.min(rect.top, window.innerHeight - rect.height - 8)),
      });
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnResize);
    window.addEventListener("scroll", closeOnScroll, true);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnResize);
      window.removeEventListener("scroll", closeOnScroll, true);
    };
  }, [selectionTranslationAction, selectionTranslationPopover?.request, Boolean(selectionTranslationPopover)]);

  const openSelectionTranslation = async () => {
    if (translationOpeningRef.current || selectionTranslationPopover?.busy) return;
    const action = selectionTranslationAction;
    const view = viewRef.current;
    if (!action || !view || !documentId) return;
    const actionSequence = translationSequenceRef.current;
    const selection = view.state.selection.main;
    if (selection.empty || selection.from !== action.from || selection.to !== action.to || view.state.sliceDoc(selection.from, selection.to) !== action.text) {
      dismissSelectionTranslation();
      return;
    }
    translationOpeningRef.current = true;
    setTranslationOpening(true);
    try {
      const anchor = await captureEditorTextAnchor(documentId, view.state);
      if (actionSequence !== translationSequenceRef.current) return;
      if (!anchor || anchor.expectedText !== action.text) {
        dismissSelectionTranslation();
        return;
      }
      const targetLanguage = defaultTranslationLanguage(anchor.expectedText);
      await translateSelection(anchor, targetLanguage);
    } finally {
      translationOpeningRef.current = false;
      setTranslationOpening(false);
    }
  };

  const selectionTranslationOverlay = selectionTranslationAction || selectionTranslationPopover
    ? createPortal(
      <div className={`selection-translate-overlay${darkMode ? " theme-dark" : ""}`}>
        {selectionTranslationAction && !selectionTranslationPopover && <button
          type="button"
          className="selection-translate-trigger"
          aria-label="翻译所选文字"
          aria-busy={translationOpening}
          title="翻译"
          disabled={translationOpening}
          style={{ left: selectionTranslationAction.left, top: selectionTranslationAction.top }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void openSelectionTranslation()}
        ><svg className="selection-translate-glyph" viewBox="0 0 30 25" preserveAspectRatio="none" fill="currentColor" aria-hidden="true" focusable="false">
          <path d="M7 0h3v16H7zM2 3h13v3H2zM2 5h3v6H2zm10 0h3v6h-3zM2 9h13v3H2z" />
          <path d="M18 1h5c3.5 0 5.5 2.4 5.5 5.5V9h-3V6.5c0-1.6-.9-2.5-2.5-2.5H18zM3 17h3v2.5C6 21.1 6.9 22 8.5 22H13v3H8.5C5 25 3 22.6 3 19.5z" />
          <path d="M19.5 24.5h-3.2L21.3 10h3.5L30 24.5h-3.2l-1.1-3.4h-5.3zm1.7-6h3.6L23 12.9z" />
        </svg></button>}
        {selectionTranslationPopover && (() => {
          const popover = selectionTranslationPopover;
          const width = Math.min(430, window.innerWidth - 24);
          const maxHeight = Math.min(450, window.innerHeight * .62);
          const left = popoverPosition?.left ?? Math.max(12, Math.min(selectionTranslationAction?.left ?? 12, window.innerWidth - width - 12));
          const top = popoverPosition?.top ?? Math.max(8, Math.min((selectionTranslationAction?.top ?? 8) + 22, window.innerHeight - maxHeight - 8));
          const startPopoverDrag = (event: ReactPointerEvent<HTMLElement>) => {
            if (event.button !== 0 || (event.target as Element).closest("button, select, label")) return;
            const rect = event.currentTarget.parentElement?.getBoundingClientRect();
            if (!rect) return;
            popoverDragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, width: rect.width, height: rect.height };
            event.currentTarget.setPointerCapture(event.pointerId);
            event.preventDefault();
          };
          const movePopoverDrag = (event: ReactPointerEvent<HTMLElement>) => {
            const drag = popoverDragRef.current;
            if (!drag || drag.pointerId !== event.pointerId) return;
            setPopoverPosition({
              left: Math.max(8, Math.min(drag.left + event.clientX - drag.x, window.innerWidth - drag.width - 8)),
              top: Math.max(8, Math.min(drag.top + event.clientY - drag.y, window.innerHeight - drag.height - 8)),
            });
          };
          const copyTranslation = async () => {
            const result = popover.result;
            if (!result) return;
            try {
              await navigator.clipboard.writeText(result);
              setSelectionTranslationPopover((current) => current?.request === popover.request ? { ...current, copied: true } : current);
            } catch {
              onStatusRef.current?.("无法访问剪贴板，请检查系统剪贴板权限。");
            }
          };
          return <section className="selection-translate-popover" role="dialog" aria-label="划词翻译" style={{ left, top }}>
            <header title="拖动以移动翻译窗口" onPointerDown={startPopoverDrag} onPointerMove={movePopoverDrag} onPointerUp={() => { popoverDragRef.current = null; }} onPointerCancel={() => { popoverDragRef.current = null; }} onLostPointerCapture={() => { popoverDragRef.current = null; }}>
              <strong>翻译</strong>
              <label><span>目标语言</span><select aria-label="翻译目标语言" value={popover.targetLanguage} disabled={popover.busy || popover.retryPending} onChange={(event) => setSelectionTranslationPopover((current) => current ? { ...current, targetLanguage: event.target.value as TranslationLanguageId, result: undefined, error: undefined, copied: false } : current)}>
                {TRANSLATION_LANGUAGES.map((language) => <option key={language.id} value={language.id}>{language.label}</option>)}
              </select></label>
              <button type="button" className="selection-translate-close" aria-label="关闭翻译" title="关闭" onClick={dismissSelectionTranslation}>×</button>
            </header>
            <div className="selection-translate-content">
              <section><h3>原文</h3><pre>{popover.anchor.expectedText}</pre></section>
              <section><h3>译文</h3><div className="selection-translate-result" aria-live="polite">{popover.busy ? <span className="selection-translate-muted">正在调用 {translationProviderLabelRef.current} 翻译…</span> : popover.error ? <span className="selection-translate-error">{popover.error}</span> : popover.result}</div></section>
            </div>
            <footer>
              <span>{translationProviderLabelRef.current}</span>
              <div>
                <button type="button" aria-label="复制译文" title="复制译文" disabled={!popover.result || popover.busy || popover.retryPending} onClick={() => void copyTranslation()}>{popover.copied ? "已复制" : "复制"}</button>
                <button type="button" className="selection-translate-submit" disabled={popover.busy || popover.retryPending} onClick={() => void translateSelection(popover.anchor, popover.targetLanguage)}>{popover.busy ? "正在翻译…" : popover.retryPending ? "正在停止…" : popover.error ? "重试翻译" : popover.result ? "重新翻译" : "翻译"}</button>
              </div>
            </footer>
          </section>;
        })()}
      </div>,
      document.body,
    )
    : null;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const showFormatMenu = (event: MouseEvent) => {
      const view = viewRef.current;
      if (!view) return;
      contextMenuCleanupRef.current?.();
      const target = event.target as Element | null;
      if (target?.closest(".cm-live-table-context-menu, th[data-table-row], td[data-table-row]")) return;
      event.preventDefault();
      event.stopPropagation();
      const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
      const selection = view.state.selection.main;
      const clickInsideSelection = position !== null && position >= selection.from && position <= selection.to;
      if (position !== null && (selection.empty || !clickInsideSelection)) {
        view.dispatch({ selection: { anchor: position }, userEvent: "select.pointer" });
      }
      const closeMenu = () => {
        menu.remove();
        document.removeEventListener("pointerdown", closeOnPointer);
        document.removeEventListener("keydown", closeOnEscape);
        contextMenuCleanupRef.current = null;
      };
      const menu = document.createElement("div");
      menu.className = "editor-context-menu";
      menu.setAttribute("role", "menu");
      const closeOnPointer = (pointerEvent: PointerEvent) => { if (!menu.contains(pointerEvent.target as Node)) closeMenu(); };
      const closeOnEscape = (keyboardEvent: KeyboardEvent) => { if (keyboardEvent.key === "Escape") closeMenu(); };
      const currentSelection = () => view.state.selection.main;
      const toggleInline = (left: string, right = left) => {
        const range = currentSelection();
        const selected = view.state.sliceDoc(range.from, range.to);
        const wrapped = selected.length >= left.length + right.length && selected.startsWith(left) && selected.endsWith(right);
        const content = wrapped ? selected.slice(left.length, selected.length - right.length) : selected || "输入文字";
        const insert = wrapped ? content : `${left}${content}${right}`;
        view.dispatch({ changes: { from: range.from, to: range.to, insert }, selection: selected
          ? { anchor: range.from + (wrapped ? 0 : left.length), head: range.from + (wrapped ? 0 : left.length) + content.length }
          : { anchor: range.from + left.length, head: range.from + left.length + content.length }, userEvent: "input.format" });
        view.focus();
      };
      const insertBlock = (block: string, cursorOffset?: number) => {
        const range = currentSelection();
        const source = view.state.doc.toString();
        const position = range.to;
        const insert = createMarkdownBlockInsertion(source, position, block);
        if (!insert) return;
        const clean = block.replace(/^\n+|\n+$/g, "");
        const contentOffset = Math.max(0, Math.min(cursorOffset ?? clean.length, clean.length));
        view.dispatch({ changes: { from: position, insert }, selection: { anchor: position + insert.indexOf(clean) + contentOffset }, scrollIntoView: true, userEvent: "input" });
        view.focus();
      };
      const toggleLinePrefix = (prefix: string | ((index: number) => string), pattern: RegExp) => {
        const range = currentSelection();
        const firstLine = view.state.doc.lineAt(range.from);
        const lastPos = range.to > range.from && range.to === view.state.doc.lineAt(range.to).from ? range.to - 1 : range.to;
        const lastLine = view.state.doc.lineAt(lastPos);
        const lines = Array.from({ length: lastLine.number - firstLine.number + 1 }, (_, index) => view.state.doc.line(firstLine.number + index));
        const shouldRemove = lines.every((line) => pattern.test(line.text));
        const changes = lines.map((line, index) => {
          const match = pattern.exec(line.text);
          if (shouldRemove && match) return { from: line.from, to: line.from + match[0].length, insert: "" };
          const oldPrefix = /^(?: {0,3}(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?| {0,3}>\s*)/.exec(line.text)?.[0] ?? "";
          return { from: line.from, to: line.from + oldPrefix.length, insert: typeof prefix === "string" ? prefix : prefix(index) };
        }).filter((change) => change.to > change.from || change.insert);
        if (changes.length) view.dispatch({ changes, userEvent: "input.list" });
        view.focus();
      };
      const copySelection = async (cut: boolean) => {
        const range = currentSelection();
        if (range.empty) return;
        const source = view.state.doc.toString();
        const payload = buildClipboardPayload(source.slice(range.from, range.to));
        try {
          if (payload.html && navigator.clipboard.write && typeof ClipboardItem !== "undefined") {
            try {
              await navigator.clipboard.write([new ClipboardItem({
                "text/plain": new Blob([payload.plain], { type: "text/plain" }),
                "text/html": new Blob([payload.html], { type: "text/html" }),
              })]);
            } catch {
              await navigator.clipboard.writeText(payload.plain);
            }
          } else await navigator.clipboard.writeText(payload.plain);
          for (const warning of payload.warnings) onStatusRef.current?.(warning);
          if (cut) {
            const selection = currentSelection();
            if (view.state.doc.toString() !== source || selection.from !== range.from || selection.to !== range.to) {
              onStatusRef.current?.("正文或选区已变化；已复制内容，但未执行剪切。");
              return;
            }
            view.dispatch({ changes: { from: range.from, to: range.to, insert: "" }, selection: { anchor: range.from }, userEvent: "delete.cut" });
          }
        } catch {
          onStatusRef.current?.("无法访问剪贴板；请检查应用的剪贴板权限。");
        }
      };
      const pasteText = async (plainOnly = false) => {
        const range = currentSelection();
        const source = view.state.doc.toString();
        try {
          const clipboard = await window.fantasticEditor.readClipboard();
          if (viewRef.current !== view) return;
          const resolved = resolveClipboardPaste({ ...clipboard, intent: plainOnly ? "literal" : "normal" });
          if (resolved.rejected) {
            onStatusRef.current?.(resolved.warnings.join(" "));
            return;
          }
          const selection = currentSelection();
          if (view.state.doc.toString() !== source || selection.from !== range.from || selection.to !== range.to) {
            onStatusRef.current?.("正文或选区已变化；请重新打开右键菜单后粘贴。");
            return;
          }
          if (!resolved.markdown) {
            onStatusRef.current?.(resolved.warnings.join(" ") || "剪贴板中没有可粘贴的文字；请在 Outlook 中重新复制后重试。");
            return;
          }
          view.dispatch({ changes: { from: range.from, to: range.to, insert: resolved.markdown }, selection: { anchor: range.from + resolved.markdown.length }, userEvent: "input.paste" });
          if (resolved.warnings.length) onStatusRef.current?.(resolved.warnings.join(" "));
          view.focus();
        } catch {
          onStatusRef.current?.("无法读取系统剪贴板；请重新复制后重试。");
        }
      };
      type MenuEntry = { label: string; shortcut?: string; run?: () => void; children?: MenuEntry[]; separator?: true };
      const numberedList = (task = false) => toggleLinePrefix(task ? "- [ ] " : (index) => `${index + 1}. `, task ? /^(?: {0,3}[-+*])\s+\[[ xX]\]\s+/ : /^(?: {0,3}\d+[.)])\s+/);
      const entries: MenuEntry[] = [
        { label: "新增链接", run: () => { insertLink("#标题"); view.focus(); } },
        { label: "新增外部链接", run: () => { insertLink("https://"); view.focus(); } },
        { separator: true, label: "" },
        { label: "文本格式", children: [
          { label: "加粗", shortcut: "Ctrl+B", run: () => toggleSelectionMark("bold") },
          { label: "倾斜", shortcut: "Ctrl+I", run: () => toggleSelectionMark("italic") },
          { label: "删除线", run: () => toggleSelectionMark("strike") },
          { label: "高亮", run: () => toggleInline("==") },
          { label: "代码", run: () => toggleSelectionMark("code") },
          { label: "数学", run: () => toggleInline("$") },
          { label: "注释", run: () => toggleInline("<!-- ", " -->") },
          { label: "清除格式", run: () => {
            const range = currentSelection();
            const selected = view.state.sliceDoc(range.from, range.to);
            const clean = selected.replace(/^(\*\*|~~|==|`|\$|\*|_)([\s\S]*)\1$/, "$2").replace(/^<!--\s*|\s*-->$/g, "");
            view.dispatch({ changes: { from: range.from, to: range.to, insert: clean }, selection: { anchor: range.from, head: range.from + clean.length }, userEvent: "input.format" });
            view.focus();
          } },
        ] },
        { label: "段落设置", children: [
          { label: "无序列表", run: () => toggleLinePrefix("- ", /^(?: {0,3}[-+*])\s+(?!\[[ xX]\]\s+)/) },
          { label: "有序列表", run: () => numberedList() },
          { label: "任务列表", run: () => numberedList(true) },
          ...Array.from({ length: 6 }, (_, index) => ({ label: `${index + 1} 级标题`, run: () => { setBlockType((index + 1) as 1 | 2 | 3 | 4 | 5 | 6); } })),
          { label: "正文", run: () => { setBlockType(0); } },
          { label: "引用", run: () => toggleLinePrefix("> ", /^(?: {0,3}>\s*)+/) },
        ] },
        { label: "插入", children: [
          { label: "脚注", run: () => {
            const source = view.state.doc.toString();
            let index = 1;
            while (source.includes(`[^${index}]`)) index += 1;
            const range = currentSelection();
            const footnote = `[^${index}]`;
            const definition = `\n\n[^${index}]: 脚注内容`;
            const changes = range.to === source.length
              ? { from: range.to, insert: footnote + definition }
              : [{ from: range.to, insert: footnote }, { from: source.length, insert: definition }];
            view.dispatch({ changes, selection: { anchor: range.to + footnote.length }, userEvent: "input" });
            view.focus();
          } },
          { label: "表格", run: () => insertBlock("| 列 1 | 列 2 |\n| --- | --- |\n|  |  |") },
          { label: "标注", run: () => insertBlock("> [!NOTE]\n> 在此输入标注内容") },
          { label: "分隔线", run: () => insertBlock("---") },
          { label: "代码块", run: () => insertBlock("```text\n\n```") },
          { label: "数学块", run: () => insertBlock("$$\n\n$$", 3) },
          { label: "新建数据表", run: () => insertBlock("| 字段 1 | 字段 2 | 字段 3 |\n| --- | --- | --- |\n|  |  |  |") },
          { label: "插入图片", run: () => {
            const anchorId = createAnchor({ x: event.clientX, y: event.clientY });
            if (anchorId) onInsertImagesRef.current?.(anchorId);
          } },
        ] },
        { separator: true, label: "" },
        { label: "剪切", shortcut: "Ctrl+X", run: () => { void copySelection(true); } },
        { label: "复制", shortcut: "Ctrl+C", run: () => { void copySelection(false); } },
        { label: "粘贴", shortcut: "Ctrl+V", run: () => { void pasteText(); } },
        { label: "以纯文本形式粘贴", run: () => { void pasteText(true); } },
        { label: "全选", shortcut: "Ctrl+A", run: () => { view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }); view.focus(); } },
        { separator: true, label: "" },
        { label: "翻译", run: () => onAiAssistRef.current?.("翻译选中的文字；保留原意、事实与 Markdown 结构。请先判断目标语言：中文翻译为英文，其他语言翻译为中文。只返回翻译后的正文。") },
        { label: "检测语言", run: () => onAiAssistRef.current?.("判断选中内容的主要语言，只返回语言名称，不要解释。") },
      ];
      const addEntries = (container: HTMLElement, list: MenuEntry[]) => {
        for (const entry of list) {
          if (entry.separator) {
            const separator = document.createElement("hr");
            separator.setAttribute("role", "separator");
            container.append(separator);
            continue;
          }
          const row = document.createElement("div");
          row.className = `editor-context-menu-row${entry.children ? " has-submenu" : ""}`;
          const button = document.createElement("button");
          button.type = "button";
          button.className = `editor-context-menu-item${entry.children ? " has-submenu" : ""}`;
          button.setAttribute("role", "menuitem");
          button.tabIndex = 0;
          if (entry.shortcut) button.title = entry.shortcut;
          const glyphs: Record<string, string> = {
            "新增链接": "↗", "新增外部链接": "↗", "文本格式": "✎", "段落设置": "¶", "插入": "+",
            "加粗": "B", "倾斜": "I", "删除线": "S", "高亮": "▧", "代码": "</>", "数学": "Σ", "注释": "❞", "清除格式": "⌫",
            "无序列表": "☷", "有序列表": "1·", "任务列表": "☑", "正文": "¶", "引用": "❞", "脚注": "†", "表格": "▦", "标注": "▤", "分隔线": "—", "代码块": "</>", "数学块": "∑", "新建数据表": "▦", "插入图片": "▧",
            "剪切": "✂", "复制": "▢", "粘贴": "▣", "以纯文本形式粘贴": "T", "全选": "⬚", "翻译": "文", "检测语言": "A",
          };
          const icon = document.createElement("span");
          icon.className = "editor-context-menu-icon";
          icon.setAttribute("aria-hidden", "true");
          icon.textContent = glyphs[entry.label] ?? (entry.label.match(/^\d 级标题$/) ? "H" : "·");
          button.append(icon);
          const label = document.createElement("span");
          label.className = "editor-context-menu-label";
          label.textContent = entry.label;
          button.append(label);
          if (entry.children) {
            const arrow = document.createElement("span");
            arrow.className = "editor-context-menu-arrow";
            arrow.textContent = "›";
            button.append(arrow);
            const submenu = document.createElement("div");
            submenu.className = "editor-context-submenu";
            submenu.setAttribute("role", "menu");
            addEntries(submenu, entry.children);
            row.append(button, submenu);
          } else {
            button.onmousedown = (pointerEvent) => pointerEvent.preventDefault();
            button.onclick = () => { closeMenu(); entry.run?.(); };
            row.append(button);
          }
          container.append(row);
        }
      };
      addEntries(menu, entries);
      document.body.append(menu);
      contextMenuCleanupRef.current = closeMenu;
      const width = menu.offsetWidth;
      const height = menu.offsetHeight;
      menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8))}px`;
      for (const submenu of menu.querySelectorAll<HTMLElement>(".editor-context-submenu")) {
        submenu.style.display = "block";
        submenu.style.visibility = "hidden";
        const bounds = submenu.getBoundingClientRect();
        if (bounds.right > window.innerWidth - 8) { submenu.style.left = "auto"; submenu.style.right = "100%"; }
        if (bounds.bottom > window.innerHeight - 8) submenu.style.top = `${Math.min(0, window.innerHeight - bounds.bottom - 8)}px`;
        submenu.style.display = "";
        submenu.style.visibility = "";
      }
      menu.querySelector<HTMLElement>(".editor-context-menu-item")?.focus({ preventScroll: true });
      document.addEventListener("pointerdown", closeOnPointer);
      document.addEventListener("keydown", closeOnEscape);
    };
    host.addEventListener("contextmenu", showFormatMenu);
    return () => {
      host.removeEventListener("contextmenu", showFormatMenu);
      contextMenuCleanupRef.current?.();
    };
  }, [insertLink, toggleSelectionMark, setBlockType]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: livePreviewCompartmentRef.current.reconfigure(livePreview ? [livePreviewExtension, livePreviewImages, livePreviewTables, livePreviewFormulas, livePreviewStructuredCode, livePreviewMermaid] : []),
    });
    view.requestMeasure();
  }, [livePreview]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: spellCheckCompartmentRef.current.reconfigure(EditorView.contentAttributes.of({ spellcheck: spellCheck ? "true" : "false", autocorrect: spellCheck ? "on" : "off" })) });
  }, [spellCheck]);

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
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) {
      lastSentValueRef.current = value;
      return;
    }
    // 本地输入已经通过 onChange 发出 lastSent，父组件滞后的 value 不得整篇回写。
    if (current === lastSentValueRef.current) return;
    lastSentValueRef.current = value;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      annotations: Transaction.addToHistory.of(false),
    });
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !livePreview || !imagePreviewHtml) return;
    view.dispatch({ effects: [
      setImageSnapshot.of(imageSnapshotFromHtml(value, imagePreviewHtml, documentId ?? undefined)),
      setTableSnapshot.of(tableSnapshotFromHtml(value, imagePreviewHtml)),
      setFormulaSnapshot.of(formulaSnapshotFromHtml(value, imagePreviewHtml)),
      setStructuredCodeSnapshot.of(structuredCodeSnapshotFromHtml(value, imagePreviewHtml)),
      setMermaidSnapshot.of(mermaidSnapshotFromHtml(value, imagePreviewHtml, darkMode, fontFamily ?? "sans-serif")),
    ] });
  }, [value, imagePreviewHtml, documentId, livePreview, darkMode, fontFamily]);

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    const files = [...event.dataTransfer.files];
    if (files.length === 0) return;
    // Never let Chromium navigate the editor window to an unsupported dropped
    // file. Non-image files continue bubbling to the application-level handler.
    event.preventDefault();
    const images = files.filter((file) => IMAGE_FILE.test(file.name));
    const markdownFiles = files.filter((file) => MARKDOWN_FILE.test(file.name));
    if (images.length === 0) return;
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
    "--editor-canvas-zoom": fontSize ? String(fontSize / DEFAULT_PREVIEW_FONT_SIZE) : "1",
  } as CSSProperties;

  return <><div className={`editor-host${wechatThemeDefinition ? " wechat-theme-active" : ""}${typewriterMode ? " typewriter-mode" : ""}`} ref={hostRef} style={editorStyle} onDragOverCapture={(event) => {
    if ([...event.dataTransfer.items].some((item) => item.kind === "file")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  }} onDropCapture={handleDrop} />{selectionTranslationOverlay}{livePreview && wechatThemeDefinition && <style>{buildCodeMirrorWechatThemeProjectionCss(wechatThemeDefinition)}</style>}</>;
});
