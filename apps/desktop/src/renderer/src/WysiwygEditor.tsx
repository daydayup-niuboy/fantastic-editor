import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent,
  type ReactEventHandler,
} from "react";
import type { ImportedAssetReceipt } from "@fantastic-editor/shared";
import katex from "katex";
import { createImageMarkdown } from "./image-insertion";
import { renderMermaidPreview } from "./mermaid-preview";
import {
  createMarkdownBlockInsertion,
  createMarkdownBlockMove,
  createMarkdownListSibling,
  exitMarkdownListItemLevel,
  createCrossBlockFormatChange,
  createCrossBlockReplacement,
  escapeMarkdownText,
  mergeMarkdownBlocks,
  mergeListItems,
  normalizeCrossBlockPlainText,
  markdownBlockPreset,
  markdownBlockDuplicateInsertion,
  markdownFenceDetails,
  markdownFormulaDetails,
  markdownImageAlt,
  markdownInlineCodeDetails,
  markdownInlineLinkDetails,
  markdownListItemDetails,
  replaceMarkdownFence,
  replaceMarkdownFormulaLatex,
  replaceMarkdownImageAlt,
  replaceMarkdownInlineCode,
  replaceMarkdownInlineLink,
  replaceMarkdownListItemOwnContent,
  replacePrefixedMarkdownContent,
  transformMarkdownTable,
  shiftMarkdownListItemIndent,
  swapMarkdownListSubtrees,
  escapeMarkdownTableCell,
  preserveTrailingLineBreaks,
  sourceRangeFromElement,
  type MarkdownBlockPreset,
  type MarkdownBlockSelectionFragment,
  type MarkdownSelectionMark,
  type MarkdownTableOperation,
  type WysiwygSourceRange,
  type WysiwygTextChange,
} from "./wysiwyg-transactions";

interface WysiwygEditorProps {
  value: string;
  html: string;
  htmlReady: boolean;
  fontFamily: string;
  darkMode: boolean;
  imageImportBusy: boolean;
  onApplyTextChange(change: WysiwygTextChange): string | null;
  onImageDrop?(files: File[], anchorId: string): void;
  onRequestImageReplacement?(anchorId: string): void;
  onDropRejected?(message: string): void;
  onStatus?(message: string): void;
  onErrorCapture?: ReactEventHandler<HTMLDivElement>;
  onLoadCapture?: ReactEventHandler<HTMLDivElement>;
}

interface ImageAnchor {
  range: WysiwygSourceRange;
  expectedText: string;
  replacementAlt?: string;
}

interface DirectEditState {
  element: HTMLElement;
  range: WysiwygSourceRange;
  expectedText: string;
  originalSource: string;
  isNewBlock?: boolean;
}

interface SourceEditState {
  element?: HTMLElement;
  range: WysiwygSourceRange;
  expectedText: string;
  source: string;
  committedSource: string;
  label: string;
}

interface ImageEditState {
  element: HTMLElement;
  range: WysiwygSourceRange;
  expectedText: string;
  source: string;
  alt: string;
}

interface TableEditContext {
  rowIndex: number;
  columnIndex: number;
  rowCount: number;
  columnCount: number;
  isHeader: boolean;
}

interface ListEditContext {
  nested: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
}
interface BlockEditContext {
  label: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
}

interface BlockDropTarget {
  element: HTMLElement;
  position: "before" | "after";
}

export interface WysiwygEditorHandle {
  createInsertionAnchor(coordinates?: { x: number; y: number }): string | null;
  discardInsertionAnchor(anchorId: string): void;
  insertImages(anchorId: string, receipts: readonly ImportedAssetReceipt[]): boolean;
  commitPending(): boolean;
  focus(): void;
}

const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|svg)$/i;
const MARKDOWN_FILE = /\.(?:md|markdown)$/i;
const SOURCE_SELECTOR = "[data-source-from][data-source-to]";
const INLINE_ATOM_SELECTOR = ".preview-formula-inline, [data-source-kind=image], [data-source-kind=inline-code], [data-source-kind=inline-link]";
const INTERACTIVE_INLINE_ATOM_SELECTOR = INLINE_ATOM_SELECTOR;
const COMPLEX_SELECTOR = "li, blockquote, table, pre, .preview-formula-block, .preview-formula-inline, .mermaid-diagram, [data-source-kind=image], [data-wysiwyg-editability=source]";
const inlineSourceByElement = new WeakMap<HTMLElement, string>();

function escapeLinkDestination(value: string): string {
  return value.trim().replaceAll(" ", "%20").replaceAll(")", "%29");
}

function serializeInlineNode(node: Node, sourceText?: string): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeMarkdownText(node.textContent ?? "");
  if (!(node instanceof HTMLElement)) return "";
  const protectedRange = typeof sourceText === "string" && node.matches(".wysiwyg-inline-atom")
    ? sourceRangeFromElement(node, sourceText.length)
    : null;
  const protectedSource = inlineSourceByElement.get(node)
    ?? (protectedRange ? sourceText!.slice(protectedRange.from, protectedRange.to) : undefined);
  if (protectedSource !== undefined) return protectedSource;
  const content = () => [...node.childNodes].map((child) => serializeInlineNode(child, sourceText)).join("");
  switch (node.tagName) {
    case "BR": return "  \n";
    case "STRONG":
    case "B": return `**${content()}**`;
    case "EM":
    case "I": return `*${content()}*`;
    case "DEL":
    case "S": return `~~${content()}~~`;
    case "CODE": {
      const value = node.textContent ?? "";
      const fence = value.includes("`") ? "``" : "`";
      return `${fence}${value}${fence}`;
    }
    case "A": {
      const href = node.getAttribute("href") ?? "";
      return href ? `[${content()}](${escapeLinkDestination(href)})` : content();
    }
    case "DIV":
    case "P": return `\n\n${content()}`;
    default: return content();
  }
}

function preservePlainBlockLeadingSyntax(value: string): string {
  return value.split("\n").map((line) => line
    .replace(/^(\s*)([#>+-])(?=\s)/, "$1\\$2")
    .replace(/^(\s*\d+)([.)])(?=\s)/, "$1\\$2")).join("\n");
}
function serializeDirectBlock(element: HTMLElement, originalSource: string, headingLevel?: number, sourceText?: string): string {
  const inline = element.dataset.wysiwygNewBlock === "true" && !(element.textContent ?? "").trim()
    ? ""
    : [...element.childNodes].map((child) => serializeInlineNode(child, sourceText)).join("").replace(/^\s+|\s+$/g, "");
  if (element.matches("th, td")) return escapeMarkdownTableCell(inline);
  const safeInline = preservePlainBlockLeadingSyntax(inline);
  if (element.matches("[data-wysiwyg-list-own-content]")) {
    const checkbox = element.querySelector<HTMLInputElement>('input[type="checkbox"]');
    return replaceMarkdownListItemOwnContent(originalSource, safeInline, checkbox?.checked) ?? originalSource;
  }  if (element.matches("li")) {
    const checkbox = element.querySelector<HTMLInputElement>('input[type="checkbox"]');
    return replacePrefixedMarkdownContent(originalSource, safeInline, "list-item", checkbox?.checked);
  }
  if (element.matches("p") && element.closest("blockquote")) {
    return replacePrefixedMarkdownContent(originalSource, safeInline, "blockquote");
  }
  const currentHeading = /^H([1-6])$/.exec(element.tagName);
  const resolvedHeadingLevel = headingLevel ?? (currentHeading ? Number(currentHeading[1]) : 0);
  const leadingWhitespace = /^[ \t]*/.exec(originalSource)?.[0] ?? "";
  const replacement = resolvedHeadingLevel > 0
    ? `${"#".repeat(resolvedHeadingLevel)} ${inline}`
    : `${leadingWhitespace}${safeInline}`;
  return preserveTrailingLineBreaks(originalSource, replacement);
}

function complexEditableElement(target: Element, textLength: number): HTMLElement | null {
  const complex = target.closest<HTMLElement>(COMPLEX_SELECTOR);
  if (complex && sourceRangeFromElement(complex, textLength)) return complex;
  return null;
}

function containsUnsafeDirectContent(element: HTMLElement): boolean {
  if (element.querySelector("pre, .preview-formula-block, .mermaid-diagram")) return true;
  return [...element.querySelectorAll<HTMLElement>("img, .resource-placeholder, .katex, a, code")]
    .some((candidate) => !candidate.closest(".wysiwyg-inline-atom"));
}

function directEditableElement(target: Element, textLength: number): HTMLElement | null {
  const listOwnContent = target.closest<HTMLElement>("[data-wysiwyg-list-own-content]");
  if (listOwnContent && sourceRangeFromElement(listOwnContent, textLength) && !containsUnsafeDirectContent(listOwnContent)) return listOwnContent;
  const cell = target.closest<HTMLElement>("th, td");
  if (cell && sourceRangeFromElement(cell, textLength, true) && !containsUnsafeDirectContent(cell)) return cell;
  const item = target.closest<HTMLElement>("li");
  if (item && sourceRangeFromElement(item, textLength)
    && !item.querySelector(":scope > ul, :scope > ol")
    && !containsUnsafeDirectContent(item)) return item;
  const element = target.closest<HTMLElement>("h1, h2, h3, h4, h5, h6, p");
  if (!element || !sourceRangeFromElement(element, textLength)) return null;
  if (element.closest("li, table") || containsUnsafeDirectContent(element)) return null;
  return element;
}

function listEditContextForElement(element: HTMLElement): ListEditContext | null {
  const item = listItemForEditable(element);
  if (!item) return null;
  return {
    nested: Boolean(item.parentElement?.closest("li")),
    canMoveUp: item.previousElementSibling instanceof HTMLLIElement,
    canMoveDown: item.nextElementSibling instanceof HTMLLIElement,
  };
}
function blockElementForEditable(element: HTMLElement): HTMLElement | null {
  const item = listItemForEditable(element);
  if (item) return item;
  const table = element.closest<HTMLElement>("table[data-source-from][data-source-to]");
  if (table) return table;
  const quote = element.closest<HTMLElement>("blockquote[data-source-from][data-source-to]");
  if (quote) return quote;
  const block = element.closest<HTMLElement>("[data-source-block=true][data-source-from][data-source-to]");
  return block ?? (element.matches(SOURCE_SELECTOR) ? element : null);
}

function blockLabel(element: HTMLElement): string {
  if (element.matches("h1, h2, h3, h4, h5, h6")) return "标题";
  if (element.matches("li")) return "列表子树";
  if (element.matches("blockquote")) return "引用";
  if (element.matches("table")) return "表格";
  if (element.matches("pre")) return element.querySelector("code.language-mermaid") ? "Mermaid" : "代码块";
  if (element.matches(".preview-formula-block")) return "公式";
  if (element.matches("[data-source-kind=image]")) return "图片";
  return "内容块";
}

function blockPeers(element: HTMLElement, content: HTMLElement, textLength: number): HTMLElement[] {
  if (element instanceof HTMLLIElement && element.parentElement) {
    return [...element.parentElement.children].filter((candidate): candidate is HTMLElement =>
      candidate instanceof HTMLLIElement && Boolean(sourceRangeFromElement(candidate, textLength)));
  }
  const seen = new Set<HTMLElement>();
  const candidates: HTMLElement[] = [];
  for (const source of content.querySelectorAll<HTMLElement>("[data-source-block=true][data-source-from][data-source-to]")) {
    const block = blockElementForEditable(source);
    if (!block || seen.has(block) || !sourceRangeFromElement(block, textLength)) continue;
    const parentBlock = block.parentElement?.closest<HTMLElement>("[data-source-block=true][data-source-from][data-source-to]");
    if (parentBlock && blockElementForEditable(parentBlock) !== block) continue;
    seen.add(block);
    candidates.push(block);
  }
  return candidates.sort((left, right) => (sourceRangeFromElement(left, textLength)?.from ?? 0) - (sourceRangeFromElement(right, textLength)?.from ?? 0));
}
function tableEditContextForCell(cell: HTMLElement): TableEditContext | null {
  const row = cell.closest("tr");
  const table = cell.closest("table");
  if (!(row instanceof HTMLTableRowElement) || !(table instanceof HTMLTableElement)) return null;
  const rows = [...table.querySelectorAll<HTMLTableRowElement>(":scope > thead > tr, :scope > tbody > tr")];
  const cells = [...row.querySelectorAll<HTMLElement>(":scope > th, :scope > td")];
  const rowIndex = rows.indexOf(row);
  const columnIndex = cells.indexOf(cell);
  if (rowIndex < 0 || columnIndex < 0) return null;
  return { rowIndex, columnIndex, rowCount: rows.length, columnCount: cells.length, isHeader: cell.matches("th") };
}

interface CrossBlockSelectionDetails {
  fragments: MarkdownBlockSelectionFragment[];
  selectedText: string;
}

function boundaryElement(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}

function boundaryInsideStructuredInline(node: Node, block: HTMLElement): boolean {
  const structured = boundaryElement(node)?.closest("strong, b, em, i, del, s, a, code, .wysiwyg-inline-atom");
  return Boolean(structured && structured !== block && block.contains(structured));
}

function rangeIntersectsNode(range: Range, node: Node): boolean {
  try { return range.intersectsNode(node); } catch { return true; }
}

function serializedInlineChildren(element: HTMLElement, sourceText: string): string {
  return [...element.childNodes].map((child) => serializeInlineNode(child, sourceText)).join("");
}

function serializedInlinePrefix(
  element: HTMLElement,
  container: Node,
  offset: number,
  sourceText: string,
): string | null {
  const range = document.createRange();
  try {
    range.selectNodeContents(element);
    range.setEnd(container, offset);
  } catch {
    return null;
  }
  const holder = document.createElement("div");
  holder.append(range.cloneContents());
  return serializedInlineChildren(holder, sourceText);
}

function blockSelectionFragment(
  element: HTMLElement,
  sourceText: string,
  startBoundary?: { container: Node; offset: number },
  endBoundary?: { container: Node; offset: number },
): MarkdownBlockSelectionFragment | null {
  const range = sourceRangeFromElement(element, sourceText.length);
  if (!range) return null;
  const originalSource = sourceText.slice(range.from, range.to);
  const rawInline = serializedInlineChildren(element, sourceText);
  const leadingTrim = /^\s*/.exec(rawInline)?.[0].length ?? 0;
  const inline = rawInline.replace(/^\s+|\s+$/g, "");
  if (!inline) return null;
  const source = serializeDirectBlock(element, originalSource, undefined, sourceText);
  const inlineStart = source.indexOf(inline);
  if (inlineStart < 0) return null;
  const inlineEnd = inlineStart + inline.length;
  let selectionFrom = inlineStart;
  let selectionTo = inlineEnd;
  if (startBoundary) {
    const prefix = serializedInlinePrefix(element, startBoundary.container, startBoundary.offset, sourceText);
    if (prefix === null) return null;
    selectionFrom = inlineStart + Math.max(0, Math.min(inline.length, prefix.length - leadingTrim));
  }
  if (endBoundary) {
    const prefix = serializedInlinePrefix(element, endBoundary.container, endBoundary.offset, sourceText);
    if (prefix === null) return null;
    selectionTo = inlineStart + Math.max(0, Math.min(inline.length, prefix.length - leadingTrim));
  }
  if (selectionTo < selectionFrom) return null;
  return { range, source, selectionFrom, selectionTo };
}

function currentCrossBlockSelection(content: HTMLElement, sourceText: string): CrossBlockSelectionDetails | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  const startBlock = boundaryElement(range.startContainer)?.closest<HTMLElement>('[data-wysiwyg-editability="direct"]');
  const endBlock = boundaryElement(range.endContainer)?.closest<HTMLElement>('[data-wysiwyg-editability="direct"]');
  if (!startBlock || !endBlock || startBlock === endBlock || !content.contains(startBlock) || !content.contains(endBlock)) return null;
  if (startBlock.matches("th, td") || endBlock.matches("th, td")
    || boundaryInsideStructuredInline(range.startContainer, startBlock)
    || boundaryInsideStructuredInline(range.endContainer, endBlock)) return null;

  for (const unsafe of content.querySelectorAll<HTMLElement>(
    ".wysiwyg-inline-atom, pre, table, .preview-formula-block, .mermaid-diagram, [data-wysiwyg-editability=source]",
  )) {
    if (!rangeIntersectsNode(range, unsafe)) continue;
    if (unsafe.matches("[data-wysiwyg-editability=source]")
      && (unsafe.matches("blockquote") || unsafe.closest('[data-wysiwyg-editability="direct"]'))) continue;
    return null;
  }

  const directBlocks = [...content.querySelectorAll<HTMLElement>('[data-wysiwyg-editability="direct"]')];
  const startIndex = directBlocks.indexOf(startBlock);
  const endIndex = directBlocks.indexOf(endBlock);
  if (startIndex < 0 || endIndex <= startIndex) return null;
  const selectedBlocks = directBlocks.slice(startIndex, endIndex + 1).filter((block) => rangeIntersectsNode(range, block));
  if (selectedBlocks.length < 2 || selectedBlocks[0] !== startBlock || selectedBlocks[selectedBlocks.length - 1] !== endBlock
    || selectedBlocks.some((block) => block.matches("th, td"))) return null;

  const fragments = selectedBlocks.map((block, index) => blockSelectionFragment(
    block,
    sourceText,
    index === 0 ? { container: range.startContainer, offset: range.startOffset } : undefined,
    index === selectedBlocks.length - 1 ? { container: range.endContainer, offset: range.endOffset } : undefined,
  ));
  if (fragments.some((fragment) => fragment === null)) return null;
  return { fragments: fragments as MarkdownBlockSelectionFragment[], selectedText: selection.toString().replace(/\r\n?/g, "\n") };
}

function placeCaretAtPoint(element: HTMLElement, x: number, y: number): void {
  const selection = window.getSelection();
  if (!selection) return;
  const hitRange = document.caretRangeFromPoint?.(x, y);
  const range = hitRange && element.contains(hitRange.startContainer)
    ? hitRange
    : document.createRange();
  if (!hitRange || !element.contains(hitRange.startContainer)) {
    range.selectNodeContents(element);
    range.collapse(false);
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

function mapRenderedSourceRanges(content: HTMLElement | null, change: WysiwygSourceRange, insertLength: number): void {
  if (!content) return;
  const delta = insertLength - (change.to - change.from);
  for (const element of content.querySelectorAll<HTMLElement>(SOURCE_SELECTOR)) {
    const from = Number(element.dataset.sourceFrom);
    const to = Number(element.dataset.sourceTo);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= change.from) continue;
    if (from >= change.to) {
      element.dataset.sourceFrom = String(from + delta);
      element.dataset.sourceTo = String(to + delta);
      continue;
    }
    if (from <= change.from && to >= change.to) {
      element.dataset.sourceTo = String(to + delta);
      continue;
    }
    element.dataset.sourceFrom = String(change.from);
    element.dataset.sourceTo = String(change.from + insertLength);
  }
  const currentLength = Number(content.dataset.documentLength);
  if (Number.isFinite(currentLength)) content.dataset.documentLength = String(currentLength + delta);
}

function selectionBelongsTo(element: HTMLElement): boolean {
  const selection = window.getSelection();
  return Boolean(selection?.anchorNode && selection.focusNode
    && element.contains(selection.anchorNode)
    && element.contains(selection.focusNode));
}

function selectionIntersectsInlineAtom(element: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !selectionBelongsTo(element)) return false;
  const range = selection.getRangeAt(0);
  for (const atom of element.querySelectorAll<HTMLElement>(".wysiwyg-inline-atom")) {
    try {
      if (range.intersectsNode(atom)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

function nodeContainsInlineAtom(node: Node | null): boolean {
  return node instanceof HTMLElement
    && (node.matches(".wysiwyg-inline-atom") || Boolean(node.querySelector(".wysiwyg-inline-atom")));
}

function caretAdjacentToInlineAtom(element: HTMLElement, direction: "previous" | "next"): boolean {
  const selection = window.getSelection();
  if (!selection || !selection.isCollapsed || !selectionBelongsTo(element) || !selection.anchorNode) return false;
  let current: Node = selection.anchorNode;
  if (current.nodeType === Node.TEXT_NODE) {
    const length = current.textContent?.length ?? 0;
    if ((direction === "previous" && selection.anchorOffset > 0)
      || (direction === "next" && selection.anchorOffset < length)) return false;
  } else if (current instanceof Element) {
    const candidate = current.childNodes[selection.anchorOffset + (direction === "previous" ? -1 : 0)] ?? null;
    if (nodeContainsInlineAtom(candidate)) return true;
    if (candidate?.textContent) return false;
  }
  while (current !== element) {
    const sibling = direction === "previous" ? current.previousSibling : current.nextSibling;
    if (sibling) return nodeContainsInlineAtom(sibling);
    const parent = current.parentNode;
    if (!parent) break;
    current = parent;
  }
  return false;
}

function caretAtBoundary(element: HTMLElement, edge: "start" | "end"): boolean {
  const selection = window.getSelection();
  if (!selection || !selection.isCollapsed || !selectionBelongsTo(element)) return false;
  const range = document.createRange();
  range.selectNodeContents(element);
  if (edge === "start") {
    range.setEnd(selection.anchorNode!, selection.anchorOffset);
    return range.toString().length === 0;
  }
  range.setStart(selection.anchorNode!, selection.anchorOffset);
  return range.toString().length === 0;
}

function prepareInlineAtoms(content: HTMLElement, text: string): void {
  for (const atom of content.querySelectorAll<HTMLElement>(INLINE_ATOM_SELECTOR)) {
    const range = sourceRangeFromElement(atom, text.length);
    if (!range) continue;
    atom.classList.add("wysiwyg-inline-atom");
    atom.contentEditable = "false";
    atom.draggable = false;
    inlineSourceByElement.set(atom, text.slice(range.from, range.to));
    atom.title = atom.matches(".preview-formula-inline")
      ? "行内公式：点击打开 LaTeX 面板"
      : atom.matches("[data-source-kind=image]")
        ? "图片：点击打开属性面板"
        : atom.matches("[data-source-kind=inline-link]")
          ? "链接：点击编辑显示文字、地址和标题"
          : "行内代码：点击编辑代码内容";
  }
}

function listItemForEditable(element: HTMLElement): HTMLLIElement | null {
  return element instanceof HTMLLIElement ? element : element.closest<HTMLLIElement>("li");
}

function isSafeListSubtree(item: HTMLLIElement): boolean {
  return !item.querySelector("pre, table, .preview-formula-block, .mermaid-diagram");
}

function prepareNestedListOwnContent(content: HTMLElement, textLength: number): void {
  for (const item of content.querySelectorAll<HTMLLIElement>("li")) {
    const nested = item.querySelector<HTMLElement>(":scope > ul, :scope > ol");
    const itemRange = sourceRangeFromElement(item, textLength);
    if (!nested || !itemRange || !isSafeListSubtree(item)) continue;
    const ownNodes: Node[] = [];
    for (const node of [...item.childNodes]) {
      if (node === nested) break;
      ownNodes.push(node);
    }
    if (ownNodes.length === 0) continue;
    const wrapper = document.createElement("span");
    wrapper.dataset.wysiwygListOwnContent = "true";
    wrapper.dataset.sourceFrom = String(itemRange.from);
    wrapper.dataset.sourceTo = String(itemRange.to);
    wrapper.dataset.sourceKind = "list-item-own-content";
    wrapper.contentEditable = "false";
    for (const node of ownNodes) wrapper.append(node);
    item.insertBefore(wrapper, nested);
  }
}
function decorateEditability(content: HTMLElement, text: string): void {
  const textLength = text.length;
  prepareNestedListOwnContent(content, textLength);
  prepareInlineAtoms(content, text);
  for (const element of content.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6, p, li, th, td, [data-wysiwyg-list-own-content]")) {
    if (directEditableElement(element, textLength) === element) {
      element.dataset.wysiwygEditability = "direct";
      element.title = element.matches("th, td") ? "点击后编辑表格单元格" : element.matches("li") ? "点击后编辑列表项" : element.closest("blockquote") ? "点击后编辑引用" : "点击后直接编辑；行内结构受到保护";
    } else if (sourceRangeFromElement(element, textLength)) {
      element.dataset.wysiwygEditability = "source";
      element.title = "此块包含尚不能安全拆分的语法，请使用源码卡片";
    }
  }
  for (const element of content.querySelectorAll<HTMLElement>(COMPLEX_SELECTOR)) {
    if (element.hasAttribute("data-source-from") && element.dataset.wysiwygEditability !== "direct") {
      element.dataset.wysiwygEditability = "source";
      if (!element.title) element.title = "点击后使用源码卡片编辑";
    }
  }
}

function labelForSourceElement(element: HTMLElement): string {
  if (element.matches(".mermaid-diagram, pre:has(code.language-mermaid)")) return "Mermaid 源码";
  if (element.matches(".preview-formula-block") || element.querySelector(".katex")) return "公式源码";
  if (element.matches("[data-source-kind=image]") || element.querySelector("img, [data-source-kind=image]")) return "图片 Markdown";
  if (element.matches("[data-source-kind=inline-link]")) return "链接编辑";
  if (element.matches("[data-source-kind=inline-code]")) return "行内代码编辑";
  if (element.matches("table")) return "表格 Markdown";
  if (element.matches("li")) return "列表项 Markdown";
  if (element.matches("blockquote")) return "引用 Markdown";
  if (element.matches("pre")) return "代码块 Markdown";
  return "Markdown 源码";
}

function formulaPreviewResult(latex: string, displayMode: boolean): { html: string; error: string | null } {
  try {
    return {
      html: katex.renderToString(latex, { displayMode, throwOnError: true, trust: false, strict: "warn" }),
      error: null,
    };
  } catch (error) {
    return { html: "", error: error instanceof Error ? error.message : "公式语法无效" };
  }
}

function imageInsertionText(text: string, position: number, receipts: readonly ImportedAssetReceipt[]): string {
  const markdown = createImageMarkdown(receipts);
  const before = text.slice(0, position);
  const after = text.slice(position);
  const prefix = before.length === 0 || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const suffix = after.length === 0 || after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
  return `${prefix}${markdown}${suffix}`;
}

export const WysiwygEditor = forwardRef<WysiwygEditorHandle, WysiwygEditorProps>(function WysiwygEditor(
  { value, html, htmlReady, fontFamily, darkMode, imageImportBusy, onApplyTextChange, onImageDrop, onRequestImageReplacement, onDropRejected, onStatus, onErrorCapture, onLoadCapture },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLElement>(null);
  const structuredPreviewRef = useRef<HTMLDivElement>(null);
  const valueRef = useRef(value);
  const htmlRef = useRef(html);
  const directEditRef = useRef<DirectEditState | null>(null);
  const sourceEditRef = useRef<SourceEditState | null>(null);
  const imageEditRef = useRef<ImageEditState | null>(null);
  const sourceTextRef = useRef("");
  const imageAnchorsRef = useRef(new Map<string, ImageAnchor>());
  const anchorSequenceRef = useRef(0);
  const renderSequenceRef = useRef(0);
  const structuredPreviewSequenceRef = useRef(0);
  const isComposingRef = useRef(false);
  const pendingCompositionBlurRef = useRef(false);
  const activeBlockRef = useRef<HTMLElement | null>(null);
  const draggedBlockRangeRef = useRef<{ range: WysiwygSourceRange; expectedText: string } | null>(null);
  const blockDropTargetRef = useRef<BlockDropTarget | null>(null);
  const [sourceEdit, setSourceEdit] = useState<SourceEditState | null>(null);
  const [imageEdit, setImageEdit] = useState<ImageEditState | null>(null);
  const [activeEditKind, setActiveEditKind] = useState<"direct" | "source" | "image" | null>(null);
  const [tableEditContext, setTableEditContext] = useState<TableEditContext | null>(null);
  const [listEditContext, setListEditContext] = useState<ListEditContext | null>(null);
  const [blockEditContext, setBlockEditContext] = useState<BlockEditContext | null>(null);
  const [blockInsertKind, setBlockInsertKind] = useState<MarkdownBlockPreset>("paragraph");

  valueRef.current = value;
  htmlRef.current = html;
  sourceEditRef.current = sourceEdit;
  imageEditRef.current = imageEdit;

  const updateSourceDraft = (source: string): void => {
    sourceTextRef.current = source;
    setSourceEdit((current) => current ? { ...current, source } : current);
  };

  const cancelSourceEdit = (): void => {
    sourceEditRef.current = null;
    sourceTextRef.current = "";
    setSourceEdit(null);
    setActiveEditKind(null);
    window.requestAnimationFrame(renderHtml);
  };

  const commitDirectEdit = (headingLevel?: number): boolean => {
    const edit = directEditRef.current;
    if (!edit) return true;
    if (isComposingRef.current) {
      onStatus?.("中文输入尚未确认，请先完成输入法组合文本。");
      return false;
    }
    const serialized = serializeDirectBlock(edit.element, edit.originalSource, headingLevel);
    const insert = edit.isNewBlock
      ? createMarkdownBlockInsertion(edit.expectedText, edit.range.from, serialized)
      : serialized;
    if ((!edit.isNewBlock && insert === edit.originalSource) || (edit.isNewBlock && !insert)) return true;
    const next = onApplyTextChange({ ...edit.range, insert, expectedText: edit.expectedText });
    if (next === null) {
      onStatus?.("所见即所得编辑基于旧文档版本，已拒绝写入；请重新选择该段落。");
      return false;
    }
    mapRenderedSourceRanges(contentRef.current, edit.range, insert.length);
    edit.expectedText = next;
    edit.originalSource = insert;
    edit.range = { from: edit.range.from, to: edit.range.from + insert.length };
    edit.isNewBlock = false;
    edit.element.removeAttribute("data-wysiwyg-new-block");
    valueRef.current = next;
    return true;
  };

  const finishDirectEdit = (): boolean => {
    const edit = directEditRef.current;
    if (!edit) return true;
    if (edit.isNewBlock && !(edit.element.textContent ?? "").trim()) {
      edit.element.remove();
      directEditRef.current = null;
      setActiveEditKind(null);
      setTableEditContext(null);
      setListEditContext(null);
      return true;
    }
    const committed = commitDirectEdit();
    if (!committed) return false;
    edit.element.contentEditable = "false";
    edit.element.classList.remove("wysiwyg-direct-edit");
    directEditRef.current = null;
    setActiveEditKind(null);
    setTableEditContext(null);
    setListEditContext(null);
    return true;
  };

  const commitSourceEdit = (): boolean => {
    const edit = sourceEditRef.current;
    if (!edit) return true;
    const insert = sourceTextRef.current;
    if (insert === edit.committedSource) return true;
    const next = onApplyTextChange({ ...edit.range, insert, expectedText: edit.expectedText });
    if (next === null) {
      onStatus?.("源码块基于旧文档版本，已拒绝写入；请关闭后重新选择。");
      return false;
    }
    mapRenderedSourceRanges(contentRef.current, edit.range, insert.length);
    if (edit.element?.matches(".wysiwyg-inline-atom")) inlineSourceByElement.set(edit.element, insert);
    const updated = {
      ...edit,
      expectedText: next,
      source: insert,
      committedSource: insert,
      range: { from: edit.range.from, to: edit.range.from + insert.length },
    };
    valueRef.current = next;
    sourceTextRef.current = insert;
    sourceEditRef.current = updated;
    setSourceEdit(updated);
    return true;
  };

  const finishSourceEdit = (): boolean => {
    const committed = commitSourceEdit();
    if (committed) {
      sourceEditRef.current = null;
      sourceTextRef.current = "";
      setSourceEdit(null);
      setActiveEditKind(null);
    }
    return committed;
  };
  const commitImageAlt = (): boolean => {
    const edit = imageEditRef.current;
    if (!edit) return true;
    const insert = replaceMarkdownImageAlt(edit.source, edit.alt);
    if (insert === null) {
      onStatus?.("该图片语法不支持可视化 alt 编辑，请使用源码卡片。");
      return false;
    }
    if (insert === edit.source) return true;
    const next = onApplyTextChange({ ...edit.range, insert, expectedText: edit.expectedText });
    if (next === null) {
      onStatus?.("图片基于旧文档版本，已拒绝写入；请重新选择图片。");
      return false;
    }
    mapRenderedSourceRanges(contentRef.current, edit.range, insert.length);
    if (edit.element?.matches(".wysiwyg-inline-atom")) inlineSourceByElement.set(edit.element, insert);
    const updated = {
      ...edit,
      expectedText: next,
      source: insert,
      range: { from: edit.range.from, to: edit.range.from + insert.length },
    };
    valueRef.current = next;
    edit.element.setAttribute("alt", updated.alt);
    inlineSourceByElement.set(edit.element, insert);
    imageEditRef.current = updated;
    setImageEdit(updated);
    return true;
  };

  const finishImageEdit = (): boolean => {
    const committed = commitImageAlt();
    if (committed) {
      imageEditRef.current = null;
      setImageEdit(null);
      setActiveEditKind(null);
    }
    return committed;
  };

  const requestImageReplacement = (): void => {
    if (!commitImageAlt()) return;
    const edit = imageEditRef.current;
    if (!edit) return;
    const anchorId = "wysiwyg-image-replace-" + Date.now() + "-" + ++anchorSequenceRef.current;
    imageAnchorsRef.current.set(anchorId, {
      range: edit.range,
      expectedText: edit.expectedText,
      replacementAlt: edit.alt,
    });
    imageEditRef.current = null;
    setImageEdit(null);
    setActiveEditKind(null);
    onRequestImageReplacement?.(anchorId);
  };

  const deleteSelectedImage = (): void => {
    const edit = imageEditRef.current;
    if (!edit || !window.confirm("删除这张图片引用？图片资源文件会保留在 assets 中。")) return;
    const next = onApplyTextChange({ ...edit.range, insert: "", expectedText: edit.expectedText });
    if (next === null) {
      onStatus?.("图片基于旧文档版本，未执行删除。");
      return;
    }
    valueRef.current = next;
    imageEditRef.current = null;
    setImageEdit(null);
    setActiveEditKind(null);
    onStatus?.("图片引用已删除；assets 中的原文件未删除。");
    window.requestAnimationFrame(renderHtml);
  };

  const commitPending = (): boolean => {
    if (isComposingRef.current) {
      onStatus?.("请先确认中文输入，再保存或切换模式。");
      return false;
    }
    const directCommitted = finishDirectEdit();
    const sourceCommitted = finishSourceEdit();
    const imageCommitted = finishImageEdit();
    if (directCommitted && sourceCommitted && imageCommitted) window.requestAnimationFrame(renderHtml);
    return directCommitted && sourceCommitted && imageCommitted;
  };

  const renderHtml = () => {
    const content = contentRef.current;
    if (!content || !htmlReady || directEditRef.current || sourceEditRef.current || imageEditRef.current || value !== valueRef.current) return;
    const sequence = ++renderSequenceRef.current;
    activeBlockRef.current = null;
    draggedBlockRangeRef.current = null;
    setBlockEditContext(null);
    content.innerHTML = htmlRef.current;
    decorateEditability(content, valueRef.current);
    void renderMermaidPreview(content, { darkMode, fontFamily }).then(() => {
      if (sequence !== renderSequenceRef.current) return;
      decorateEditability(content, valueRef.current);
    }).catch(() => onStatus?.("Mermaid 所见即所得预览未能完成。"));
  };

  useImperativeHandle(ref, () => ({
    createInsertionAnchor(coordinates) {
      const content = contentRef.current;
      if (!content) return null;
      const hit = coordinates ? document.elementFromPoint(coordinates.x, coordinates.y) : document.activeElement;
      const sourceElement = (hit instanceof Element ? hit.closest<HTMLElement>(SOURCE_SELECTOR) : null)
        ?? content.querySelector<HTMLElement>(`${SOURCE_SELECTOR}.wysiwyg-selected`);
      const range = sourceRangeFromElement(sourceElement, valueRef.current.length);
      const position = range?.to ?? valueRef.current.length;
      const anchorId = `wysiwyg-image-anchor-${Date.now()}-${++anchorSequenceRef.current}`;
      imageAnchorsRef.current.set(anchorId, {
        range: { from: position, to: position },
        expectedText: valueRef.current,
      });
      return anchorId;
    },
    discardInsertionAnchor(anchorId) { imageAnchorsRef.current.delete(anchorId); },
    insertImages(anchorId, receipts) {
      const anchor = imageAnchorsRef.current.get(anchorId);
      imageAnchorsRef.current.delete(anchorId);
      if (!anchor || receipts.length === 0) return false;
      const markdown = createImageMarkdown(receipts);
      const insert = anchor.range.from === anchor.range.to
        ? imageInsertionText(anchor.expectedText, anchor.range.from, receipts)
        : replaceMarkdownImageAlt(markdown, anchor.replacementAlt ?? "") ?? markdown;
      const next = onApplyTextChange({ ...anchor.range, insert, expectedText: anchor.expectedText });
      if (next !== null) valueRef.current = next;
      return next !== null;
    },
    commitPending,
    focus() { (directEditRef.current?.element ?? contentRef.current)?.focus(); },
  }));

  useEffect(() => { if (htmlReady && !directEditRef.current && !sourceEditRef.current && !imageEditRef.current) renderHtml(); }, [html, htmlReady, darkMode, fontFamily]);

  useEffect(() => {
    const host = structuredPreviewRef.current;
    if (!host) return;
    const sequence = ++structuredPreviewSequenceRef.current;
    host.replaceChildren();
    host.classList.remove("has-error");
    const fence = sourceEdit ? markdownFenceDetails(sourceEdit.source) : null;
    if (!fence || fence.language.toLowerCase() !== "mermaid") return;
    host.textContent = "正在渲染 Mermaid…";
    const staging = document.createElement("div");
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.className = "language-mermaid";
    code.textContent = fence.content;
    pre.append(code);
    staging.append(pre);
    void renderMermaidPreview(staging, { darkMode, fontFamily }).then(() => {
      if (sequence !== structuredPreviewSequenceRef.current || !structuredPreviewRef.current) return;
      structuredPreviewRef.current.replaceChildren(...staging.childNodes);
    }).catch((error) => {
      if (sequence !== structuredPreviewSequenceRef.current || !structuredPreviewRef.current) return;
      structuredPreviewRef.current.textContent = error instanceof Error ? error.message : "Mermaid 语法无效";
      structuredPreviewRef.current.classList.add("has-error");
    });
  }, [sourceEdit?.source, darkMode, fontFamily]);

  const activateStructuralBlock = (element: HTMLElement | null): void => {
    const content = contentRef.current;
    const block = element ? blockElementForEditable(element) : null;
    if (!content || !block || !sourceRangeFromElement(block, valueRef.current.length)) {
      activeBlockRef.current = null;
      setBlockEditContext(null);
      return;
    }
    for (const selected of content.querySelectorAll(".wysiwyg-block-active")) selected.classList.remove("wysiwyg-block-active");
    block.classList.add("wysiwyg-block-active");
    const peers = blockPeers(block, content, valueRef.current.length);
    const index = peers.indexOf(block);
    activeBlockRef.current = block;
    setBlockEditContext({ label: blockLabel(block), canMoveUp: index > 0, canMoveDown: index >= 0 && index < peers.length - 1 });
  };
  const selectBlock = (target: Element, coordinates?: { x: number; y: number }): "direct" | "complex" | "image" | null => {
    const content = contentRef.current;
    if (!content) return null;
    const existingDirect = directEditRef.current;
    const inlineStructured = target.closest<HTMLElement>(INTERACTIVE_INLINE_ATOM_SELECTOR);
    const direct = inlineStructured && sourceRangeFromElement(inlineStructured, valueRef.current.length)
      ? null
      : directEditableElement(target, valueRef.current.length);
    if (existingDirect?.element === direct && direct) {
      direct.focus({ preventScroll: true });
      if (coordinates) placeCaretAtPoint(direct, coordinates.x, coordinates.y);
      return "direct";
    }
    const complex = direct ? null : inlineStructured ?? complexEditableElement(target, valueRef.current.length);
    const candidateElement = complex ?? direct;
    let candidateRange = sourceRangeFromElement(candidateElement, valueRef.current.length, Boolean(candidateElement?.matches("th, td")));
    if (!candidateRange) return null;
    const previousRange = directEditRef.current?.range ?? sourceEditRef.current?.range ?? imageEditRef.current?.range ?? null;
    const previousLength = valueRef.current.length;
    if (!finishDirectEdit() || !finishSourceEdit() || !finishImageEdit()) return null;
    const delta = valueRef.current.length - previousLength;
    if (previousRange && candidateRange.from >= previousRange.to && delta !== 0) {
      candidateRange = { from: candidateRange.from + delta, to: candidateRange.to + delta };
    }
    for (const selected of content.querySelectorAll(".wysiwyg-selected")) selected.classList.remove("wysiwyg-selected");
    activateStructuralBlock(candidateElement);
    if (complex) {
      complex.classList.add("wysiwyg-selected");
      const source = valueRef.current.slice(candidateRange.from, candidateRange.to);
      const fence = markdownFenceDetails(source);
      const formula = markdownFormulaDetails(source);
      const structuredRangeMatches = complex.matches(".mermaid-diagram")
        ? fence?.language.toLowerCase() === "mermaid"
        : complex.matches("pre")
          ? fence !== null
          : complex.matches(".preview-formula-block")
            ? formula?.displayMode === true
            : complex.matches(".preview-formula-inline")
              ? formula?.displayMode === false
              : true;
      if (!structuredRangeMatches) {
        complex.classList.remove("wysiwyg-selected");
        onStatus?.("内容定位正在更新，请等待预览同步后重试。");
        window.requestAnimationFrame(renderHtml);
        return null;
      }
      const alt = markdownImageAlt(source);
      if (complex.matches("[data-source-kind=image]") && alt === null && !source.startsWith("![[")) {
        complex.classList.remove("wysiwyg-selected");
        onStatus?.("图片定位正在更新，请稍候后重试。");
        window.requestAnimationFrame(renderHtml);
        return null;
      }
      if (complex.matches("[data-source-kind=image]") && alt !== null) {
        const nextImage = {
          element: complex,
          range: candidateRange,
          expectedText: valueRef.current,
          source,
          alt,
        };
        imageEditRef.current = nextImage;
        setImageEdit(nextImage);
        setActiveEditKind("image");
        return "image";
      }
      const next = {
        element: complex,
        range: candidateRange,
        expectedText: valueRef.current,
        source,
        committedSource: source,
        label: labelForSourceElement(complex),
      };
      sourceTextRef.current = next.source;
      sourceEditRef.current = next;
      setSourceEdit(next);
      setActiveEditKind("source");
      return "complex";
    }
    if (!direct) return null;
    direct.classList.add("wysiwyg-selected", "wysiwyg-direct-edit");
    direct.contentEditable = "true";
    direct.spellcheck = true;
    directEditRef.current = {
      element: direct,
      range: candidateRange,
      expectedText: valueRef.current,
      originalSource: valueRef.current.slice(candidateRange.from, candidateRange.to),
    };
    direct.focus({ preventScroll: true });
    if (coordinates) placeCaretAtPoint(direct, coordinates.x, coordinates.y);
    setActiveEditKind("direct");
    setTableEditContext(direct.matches("th, td") ? tableEditContextForCell(direct) : null);
    setListEditContext(listEditContextForElement(direct));
    return "direct";
  };

  const createBlankParagraph = (clientY: number) => {
    const content = contentRef.current;
    if (!content || isComposingRef.current) return;
    if (!finishDirectEdit() || !finishSourceEdit() || !finishImageEdit()) return;
    const blocks = [...content.children].filter((element): element is HTMLElement =>
      element instanceof HTMLElement && element.hasAttribute("data-source-from"));
    const before = blocks.find((element) => clientY < element.getBoundingClientRect().top + element.getBoundingClientRect().height / 2) ?? null;
    const beforeRange = sourceRangeFromElement(before, valueRef.current.length);
    const position = beforeRange?.from ?? valueRef.current.length;
    const paragraph = document.createElement("p");
    paragraph.dataset.sourceFrom = String(position);
    paragraph.dataset.sourceTo = String(position);
    paragraph.dataset.wysiwygEditability = "direct";
    paragraph.dataset.wysiwygNewBlock = "true";
    paragraph.className = "wysiwyg-selected wysiwyg-direct-edit";
    paragraph.contentEditable = "true";
    paragraph.spellcheck = true;
    paragraph.setAttribute("aria-label", "新段落");
    paragraph.innerHTML = "<br>";
    content.insertBefore(paragraph, before);
    directEditRef.current = {
      element: paragraph,
      range: { from: position, to: position },
      expectedText: valueRef.current,
      originalSource: "",
      isNewBlock: true,
    };
    setActiveEditKind("direct");
    paragraph.focus({ preventScroll: true });
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    onStatus?.("已创建新段落；输入内容后会写回 Markdown。");
  };

  const toggleTaskItem = (item: HTMLElement, checkbox: HTMLInputElement): boolean => {
    if (!finishDirectEdit() || !finishSourceEdit() || !finishImageEdit()) return false;
    const range = sourceRangeFromElement(item, valueRef.current.length);
    if (!range) return false;
    const original = valueRef.current.slice(range.from, range.to);
    if (!/\[[ xX]\]/.test(original)) return false;
    const checked = !checkbox.checked;
    const insert = original.replace(/\[[ xX]\]/, checked ? "[x]" : "[ ]");
    const next = onApplyTextChange({ ...range, insert, expectedText: valueRef.current });
    if (next === null) {
      onStatus?.("任务列表项已变化，未切换完成状态。");
      return false;
    }
    mapRenderedSourceRanges(contentRef.current, range, insert.length);
    valueRef.current = next;
    checkbox.checked = checked;
    onStatus?.(checked ? "任务已标记为完成。" : "任务已标记为未完成。");
    return true;
  };

  const mergeDirectNeighbor = (direction: "previous" | "next"): boolean => {
    const edit = directEditRef.current;
    if (!edit || edit.isNewBlock || edit.element.matches("th, td") || edit.element.closest("blockquote")) return false;
    const sibling = direction === "previous" ? edit.element.previousElementSibling : edit.element.nextElementSibling;
    if (!(sibling instanceof HTMLElement)) return false;
    const siblingElement = directEditableElement(sibling, edit.expectedText.length);
    const siblingRange = sourceRangeFromElement(siblingElement, edit.expectedText.length);
    if (!siblingElement || !siblingRange || siblingElement.tagName !== edit.element.tagName && edit.element.matches("li")) return false;
    const currentSource = serializeDirectBlock(edit.element, edit.originalSource);
    const siblingSource = edit.expectedText.slice(siblingRange.from, siblingRange.to);
    const range = direction === "previous"
      ? { from: siblingRange.from, to: edit.range.to }
      : { from: edit.range.from, to: siblingRange.to };
    const listMerge = edit.element.matches("li");
    const insert = direction === "previous"
      ? listMerge ? mergeListItems(siblingSource, currentSource) : mergeMarkdownBlocks(siblingSource, currentSource)
      : listMerge ? mergeListItems(currentSource, siblingSource) : mergeMarkdownBlocks(currentSource, siblingSource);
    const next = onApplyTextChange({ ...range, insert, expectedText: edit.expectedText });
    if (next === null) {
      onStatus?.("相邻内容已变化，未执行合并。");
      return false;
    }
    valueRef.current = next;
    edit.element.contentEditable = "false";
    edit.element.classList.remove("wysiwyg-direct-edit");
    directEditRef.current = null;
    setActiveEditKind(null);
    onStatus?.(direction === "previous" ? "已与上一项合并。" : "已与下一项合并。");
    return true;
  };

  const resetDirectListEdit = (): void => {
    const edit = directEditRef.current;
    if (edit) {
      edit.element.contentEditable = "false";
      edit.element.classList.remove("wysiwyg-direct-edit");
    }
    directEditRef.current = null;
    setActiveEditKind(null);
    setListEditContext(null);
  };

  const shiftCurrentListItem = (direction: "indent" | "outdent"): boolean => {
    const edit = directEditRef.current;
    const item = edit ? listItemForEditable(edit.element) : null;
    if (!edit || !item) return false;
    if (direction === "indent" && !(item.previousElementSibling instanceof HTMLLIElement)) {
      onStatus?.("第一项不能继续缩进；请先在它前面保留一个同级列表项。");
      return true;
    }
    const currentSource = serializeDirectBlock(edit.element, edit.originalSource);
    const insert = shiftMarkdownListItemIndent(currentSource, direction);
    if (insert === null) {
      onStatus?.(direction === "outdent" ? "该列表项已处于顶层。" : "无法调整该列表项层级。");
      return true;
    }
    const next = onApplyTextChange({ ...edit.range, insert, expectedText: edit.expectedText });
    if (next === null) {
      onStatus?.("列表项基于旧文档版本，未调整层级。");
      return true;
    }
    mapRenderedSourceRanges(contentRef.current, edit.range, insert.length);
    valueRef.current = next;
    resetDirectListEdit();
    onStatus?.(direction === "indent" ? "列表项及其全部子项已缩进一级；可用一次撤销恢复。" : "列表项及其全部子项已提升一级；可用一次撤销恢复。");
    window.requestAnimationFrame(renderHtml);
    return true;
  };

  const moveCurrentListSubtree = (direction: "up" | "down"): boolean => {
    const edit = directEditRef.current;
    const item = edit ? listItemForEditable(edit.element) : null;
    if (!edit || !item || !isSafeListSubtree(item)) return false;
    const sibling = direction === "up" ? item.previousElementSibling : item.nextElementSibling;
    if (!(sibling instanceof HTMLLIElement) || !isSafeListSubtree(sibling)) {
      onStatus?.("当前方向没有可安全交换的同级列表项。");
      return true;
    }
    const currentSource = serializeDirectBlock(edit.element, edit.originalSource);
    const siblingRange = sourceRangeFromElement(sibling, edit.expectedText.length);
    if (!siblingRange) { onStatus?.("相邻列表项定位已过期，请等待刷新。"); return true; }
    const siblingSource = edit.expectedText.slice(siblingRange.from, siblingRange.to);
    const range = direction === "up"
      ? { from: siblingRange.from, to: edit.range.to }
      : { from: edit.range.from, to: siblingRange.to };
    const insert = direction === "up"
      ? swapMarkdownListSubtrees(siblingSource, currentSource)
      : swapMarkdownListSubtrees(currentSource, siblingSource);
    const next = onApplyTextChange({ ...range, insert, expectedText: edit.expectedText });
    if (next === null) { onStatus?.("列表项基于旧文档版本，未执行移动。"); return true; }
    valueRef.current = next;
    resetDirectListEdit();
    onStatus?.(`列表项及其全部子项已${direction === "up" ? "上移" : "下移"}；可用一次撤销恢复。`);
    window.requestAnimationFrame(renderHtml);
    return true;
  };

  const insertListSiblingAfterCurrent = (): boolean => {
    const edit = directEditRef.current;
    const item = edit ? listItemForEditable(edit.element) : null;
    if (!edit || !item) return false;
    const currentSource = serializeDirectBlock(edit.element, edit.originalSource);
    if (!(edit.element.textContent ?? "").trim()) {
      const insert = exitMarkdownListItemLevel(currentSource);
      if (insert === null) return false;
      const next = onApplyTextChange({ ...edit.range, insert, expectedText: edit.expectedText });
      if (next === null) { onStatus?.("列表项基于旧文档版本，未退出当前层级。"); return true; }
      valueRef.current = next;
      resetDirectListEdit();
      onStatus?.("空列表项已退出当前层级；其子项保持原有相对结构。");
      window.requestAnimationFrame(renderHtml);
      return true;
    }
    const siblingPrefix = createMarkdownListSibling(currentSource);
    if (!siblingPrefix) return false;
    const separator = currentSource.endsWith("\n") ? "" : "\n";
    const insert = `${currentSource}${separator}${siblingPrefix}新列表项\n`;
    const next = onApplyTextChange({ ...edit.range, insert, expectedText: edit.expectedText });
    if (next === null) { onStatus?.("列表项基于旧文档版本，未新建同级项。"); return true; }
    valueRef.current = next;
    resetDirectListEdit();
    onStatus?.("已在当前子树后新建同级列表项；点击占位文字即可继续输入。");
    window.requestAnimationFrame(renderHtml);
    return true;
  };  const clearBlockDropTarget = (): void => {
    const target = blockDropTargetRef.current?.element;
    target?.classList.remove("wysiwyg-drop-before", "wysiwyg-drop-after");
    blockDropTargetRef.current = null;
  };

  const finishEditorsForBlockAction = (): boolean => {
    if (isComposingRef.current) {
      onStatus?.("中文输入尚未确认，暂不能执行块结构操作。");
      return false;
    }
    return finishDirectEdit() && finishSourceEdit() && finishImageEdit();
  };

  const finishBlockAction = (change: WysiwygTextChange, message: string): boolean => {
    const next = onApplyTextChange(change);
    if (next === null) {
      onStatus?.("内容块基于旧文档版本，已拒绝结构修改；请重新选择后重试。");
      return false;
    }
    valueRef.current = next;
    activeBlockRef.current = null;
    draggedBlockRangeRef.current = null;
    clearBlockDropTarget();
    setBlockEditContext(null);
    setListEditContext(null);
    setTableEditContext(null);
    contentRef.current?.replaceChildren();
    onStatus?.(message);
    window.requestAnimationFrame(renderHtml);
    return true;
  };

  const activeBlockAndRange = (): { block: HTMLElement; range: WysiwygSourceRange } | null => {
    const block = activeBlockRef.current;
    const range = sourceRangeFromElement(block, valueRef.current.length);
    return block && range ? { block, range } : null;
  };

  const moveActiveBlock = (direction: "up" | "down"): boolean => {
    if (!finishEditorsForBlockAction()) return false;
    const current = activeBlockAndRange();
    const content = contentRef.current;
    if (!current || !content) return false;
    const peers = blockPeers(current.block, content, valueRef.current.length);
    const index = peers.indexOf(current.block);
    const target = peers[index + (direction === "up" ? -1 : 1)];
    if (!target) { onStatus?.("当前方向没有可移动到的同级内容块。"); return true; }
    const targetRange = sourceRangeFromElement(target, valueRef.current.length);
    if (!targetRange) { onStatus?.("当前方向没有可移动到的同级内容块。"); return true; }
    const change = createMarkdownBlockMove(valueRef.current, current.range, targetRange, direction === "up" ? "before" : "after");
    if (!change) { onStatus?.("当前块与目标结构重叠，未执行移动。"); return true; }
    return finishBlockAction(change, `内容块已${direction === "up" ? "上移" : "下移"}；可用一次撤销恢复。`);
  };

  const duplicateActiveBlock = (): boolean => {
    if (!finishEditorsForBlockAction()) return false;
    const current = activeBlockAndRange();
    if (!current) return false;
    const source = valueRef.current.slice(current.range.from, current.range.to);
    const insert = markdownBlockDuplicateInsertion(source);
    return finishBlockAction({ from: current.range.to, to: current.range.to, insert, expectedText: valueRef.current }, "已复制当前内容块；副本位于原块下方。");
  };

  const deleteActiveBlock = (): boolean => {
    const current = activeBlockAndRange();
    if (!current || !window.confirm(`删除当前${blockLabel(current.block)}？可使用撤销恢复。`)) return false;
    if (!finishEditorsForBlockAction()) return false;
    const refreshed = activeBlockAndRange();
    if (!refreshed) return false;
    return finishBlockAction({ ...refreshed.range, insert: "", expectedText: valueRef.current }, "内容块已删除；可用一次撤销恢复。");
  };

  const insertBlockAfterActive = (): boolean => {
    if (!finishEditorsForBlockAction()) return false;
    const current = activeBlockAndRange();
    if (!current) return false;
    const insert = createMarkdownBlockInsertion(valueRef.current, current.range.to, markdownBlockPreset(blockInsertKind));
    if (!insert) return false;
    return finishBlockAction({ from: current.range.to, to: current.range.to, insert, expectedText: valueRef.current }, "已在当前块下方插入新内容；可继续点击编辑。");
  };

  const moveDraggedBlock = (target: HTMLElement, position: "before" | "after"): boolean => {
    const moving = draggedBlockRangeRef.current;
    if (moving && moving.expectedText !== valueRef.current) {
      draggedBlockRangeRef.current = null;
      clearBlockDropTarget();
      onStatus?.("拖拽期间文档已变化，旧块范围已拒绝；请重新拖动。");
      return true;
    }
    const targetBlock = blockElementForEditable(target);
    const targetRange = sourceRangeFromElement(targetBlock, valueRef.current.length);
    if (!moving || !targetBlock || !targetRange) return false;
    const change = createMarkdownBlockMove(valueRef.current, moving.range, targetRange, position);
    if (!change) { clearBlockDropTarget(); onStatus?.("不能将内容块放到自身或其后代范围内。"); return true; }
    return finishBlockAction(change, "内容块已拖动到新位置；可用一次撤销恢复。");
  };

  const startActiveBlockDrag = (event: DragEvent<HTMLElement>): void => {
    if (!finishEditorsForBlockAction()) { event.preventDefault(); return; }
    const current = activeBlockAndRange();
    if (!current) { event.preventDefault(); return; }
    draggedBlockRangeRef.current = { range: current.range, expectedText: valueRef.current };
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-fantastic-editor-block", `${current.range.from}:${current.range.to}`);
    onStatus?.("正在拖动内容块；放到目标块上半部或下半部。");
  };

  const updateBlockDropTarget = (event: DragEvent<HTMLElement>): boolean => {
    if (!event.dataTransfer.types.includes("application/x-fantastic-editor-block")) return false;
    const target = event.target instanceof Element ? blockElementForEditable(event.target as HTMLElement) : null;
    if (!target) return true;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const position = event.clientY < target.getBoundingClientRect().top + target.getBoundingClientRect().height / 2 ? "before" : "after";
    const previous = blockDropTargetRef.current;
    if (previous?.element !== target || previous.position !== position) {
      clearBlockDropTarget();
      target.classList.add(position === "before" ? "wysiwyg-drop-before" : "wysiwyg-drop-after");
      blockDropTargetRef.current = { element: target, position };
    }
    return true;
  };
  const applyCurrentTableOperation = (operation: MarkdownTableOperation): boolean => {
    const edit = directEditRef.current;
    if (!edit?.element.matches("th, td")) return false;
    const table = edit.element.closest<HTMLElement>("table[data-source-from][data-source-to]");
    if (!table || !commitDirectEdit()) return false;
    const range = sourceRangeFromElement(table, valueRef.current.length);
    if (!range) { onStatus?.("表格定位已过期，请等待重新解析后重试。"); return false; }
    const source = valueRef.current.slice(range.from, range.to);
    const insert = transformMarkdownTable(source, operation);
    if (insert === null) { onStatus?.("当前表格结构不支持该操作，未修改 Markdown。"); return false; }
    const next = onApplyTextChange({ ...range, insert, expectedText: valueRef.current });
    if (next === null) { onStatus?.("表格基于旧文档版本，已拒绝结构修改。"); return false; }
    valueRef.current = next;
    edit.element.contentEditable = "false";
    edit.element.classList.remove("wysiwyg-direct-edit");
    directEditRef.current = null;
    setActiveEditKind(null);
    setTableEditContext(null);
    contentRef.current?.replaceChildren();
    onStatus?.("表格结构已更新，正在刷新可视投影；可使用撤销恢复。");
    window.requestAnimationFrame(renderHtml);
    return true;
  };

  const moveTableCell = (direction: "previous" | "next", appendRowAtEnd = false): boolean => {
    const edit = directEditRef.current;
    if (!edit?.element.matches("th, td")) return false;
    const table = edit.element.closest("table");
    const cells = table ? [...table.querySelectorAll<HTMLElement>("th[data-source-from], td[data-source-from]")] : [];
    const index = cells.indexOf(edit.element);
    const nextCell = cells[index + (direction === "previous" ? -1 : 1)];
    if (!nextCell) {
      const context = tableEditContextForCell(edit.element);
      if (appendRowAtEnd && direction === "next" && context && context.rowIndex === context.rowCount - 1 && context.columnIndex === context.columnCount - 1) {
        return applyCurrentTableOperation({ kind: "insert-row", rowIndex: context.rowIndex, position: "after" });
      }
      if (finishDirectEdit()) window.requestAnimationFrame(renderHtml);
      return true;
    }
    if (selectBlock(nextCell) !== "direct") return false;
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(nextCell);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    onStatus?.("已切换到相邻表格单元格。");
    return true;
  };

  const finishCrossBlockTransaction = (change: WysiwygTextChange, message: string): boolean => {
    const next = onApplyTextChange(change);
    if (next === null) {
      onStatus?.("跨块选择基于旧文档版本，已拒绝写入；请重新选择后重试。");
      return false;
    }
    const edit = directEditRef.current;
    if (edit) {
      edit.element.contentEditable = "false";
      edit.element.classList.remove("wysiwyg-direct-edit");
    }
    valueRef.current = next;
    directEditRef.current = null;
    setActiveEditKind(null);
    setTableEditContext(null);
    window.getSelection()?.removeAllRanges();
    contentRef.current?.replaceChildren();
    onStatus?.(message);
    window.requestAnimationFrame(renderHtml);
    return true;
  };

  const crossBlockSelectionAfterCommit = (): CrossBlockSelectionDetails | null => {
    const content = contentRef.current;
    if (isComposingRef.current || !directEditRef.current || !content) return null;
    if (!currentCrossBlockSelection(content, valueRef.current)) return null;
    if (!commitDirectEdit()) return null;
    return currentCrossBlockSelection(content, valueRef.current);
  };

  const replaceCurrentCrossBlockSelection = (insert: string, message: string): boolean => {
    const selected = crossBlockSelectionAfterCommit();
    if (!selected) {
      onStatus?.("该跨块选择经过图片、公式、代码、表格、复杂结构或格式边界；请缩小范围或使用源代码模式。");
      return false;
    }
    const first = selected.fragments[0]!;
    const last = selected.fragments[selected.fragments.length - 1]!;
    const change = createCrossBlockReplacement(valueRef.current, first, last, insert);
    if (!change) {
      onStatus?.("跨块范围无法安全映射到当前 Markdown，未执行修改。");
      return false;
    }
    return finishCrossBlockTransaction(change, message);
  };

  const formatCurrentCrossBlockSelection = (mark: MarkdownSelectionMark): boolean => {
    const selected = crossBlockSelectionAfterCommit();
    if (!selected) {
      onStatus?.("不能跨受保护结构或格式边界批量设置样式；请缩小选择范围。");
      return false;
    }
    const fragments = selected.fragments.filter((fragment) => fragment.selectionTo > fragment.selectionFrom);
    const change = createCrossBlockFormatChange(valueRef.current, fragments, mark);
    if (!change) {
      onStatus?.("跨块格式化至少需要覆盖两个安全文本块。");
      return false;
    }
    const label = mark === "bold" ? "粗体" : mark === "italic" ? "斜体" : "删除线";
    return finishCrossBlockTransaction(change, `已对跨块选择设置${label}；可用一次撤销恢复。`);
  };
  const handleDirectKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const edit = directEditRef.current;
    if (!edit || event.nativeEvent.isComposing || isComposingRef.current) return;
    if (
      edit.isNewBlock
      && !(edit.element.textContent ?? "").trim()
      && (event.key === "Backspace" || event.key === "Delete")
    ) {
      event.preventDefault();
      if (finishDirectEdit()) {
        contentRef.current?.focus({ preventScroll: true });
        onStatus?.("已移除空段落。");
        window.requestAnimationFrame(renderHtml);
      }
      return;
    }
    const hasCrossBlockSelection = Boolean(window.getSelection()?.isCollapsed === false && !selectionBelongsTo(edit.element));
    if (hasCrossBlockSelection) {
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && !event.altKey && (key === "b" || key === "i")) {
        event.preventDefault();
        formatCurrentCrossBlockSelection(key === "b" ? "bold" : "italic");
        return;
      }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && key === "k") {
        event.preventDefault();
        onStatus?.("跨块选择暂不创建单个链接；可使用粗体、斜体、删除线或切换源代码模式。");
        return;
      }
      if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        replaceCurrentCrossBlockSelection("", "已删除跨块选择；可用一次撤销恢复。");
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        replaceCurrentCrossBlockSelection("\n\n", "已用新段落替换跨块选择。");
        return;
      }
    }
    if (event.key === "Escape") {
      event.preventDefault();
      edit.element.contentEditable = "false";
      edit.element.classList.remove("wysiwyg-direct-edit");
      directEditRef.current = null;
      activeBlockRef.current = null;
      setActiveEditKind(null);
      setListEditContext(null);
      setTableEditContext(null);
      setBlockEditContext(null);
      onStatus?.("已取消当前未提交的可视编辑。");
      window.requestAnimationFrame(renderHtml);
      return;
    }    if ((event.key === "Backspace" || event.key === "Delete")
      && (selectionIntersectsInlineAtom(edit.element)
        || caretAdjacentToInlineAtom(edit.element, event.key === "Backspace" ? "previous" : "next"))) {
      event.preventDefault();
      onStatus?.("公式、图片、链接和行内代码是受保护节点；请点击节点使用专用面板或源码模式。");
      return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      const key = event.key.toLowerCase();
      const command = key === "b" ? "bold" : key === "i" ? "italic" : null;
      if (command) {
        event.preventDefault();
        edit.element.focus({ preventScroll: true });
        document.execCommand(command);
        onStatus?.(key === "b" ? "已切换粗体格式。" : "已切换斜体格式。");
        return;
      }
      if (key === "k") {
        event.preventDefault();
        const href = window.prompt("输入链接地址", "https://");
        if (href) {
          edit.element.focus({ preventScroll: true });
          document.execCommand("createLink", false, href);
          onStatus?.("链接已应用；离开当前块时写回 Markdown。");
        }
        return;
      }
    }
    if (event.altKey && !event.ctrlKey && !event.metaKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      moveActiveBlock(event.key === "ArrowUp" ? "up" : "down");
      return;
    }    const destructive = event.key === "Enter" || event.key === "Backspace" || event.key === "Delete";
    if (destructive && !selectionBelongsTo(edit.element)) {
      event.preventDefault();
      onStatus?.("跨块修改请先缩小选择范围，或切换到源代码模式。");
      return;
    }
    const currentListItem = listItemForEditable(edit.element);
    if (currentListItem && event.key === "Tab") {
      event.preventDefault();
      shiftCurrentListItem(event.shiftKey ? "outdent" : "indent");
      return;
    }
    if (currentListItem && edit.element.dataset.wysiwygListOwnContent === "true" && event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      insertListSiblingAfterCurrent();
      return;
    }
    if (currentListItem && event.key === "Backspace" && caretAtBoundary(edit.element, "start")) {
      const details = markdownListItemDetails(edit.originalSource);
      if (details?.indent) {
        event.preventDefault();
        shiftCurrentListItem("outdent");
        return;
      }
    }    if (edit.element.matches("th, td") && (event.key === "Tab" || event.key === "Enter")) {
      event.preventDefault();
      moveTableCell(event.key === "Tab" && event.shiftKey ? "previous" : "next", event.key === "Tab" && !event.shiftKey);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      document.execCommand(event.shiftKey ? "insertLineBreak" : "insertParagraph");
      return;
    }
    if (event.key === "Backspace" && caretAtBoundary(edit.element, "start")) {
      if (mergeDirectNeighbor("previous")) event.preventDefault();
      return;
    }
    if (event.key === "Delete" && caretAtBoundary(edit.element, "end")) {
      if (mergeDirectNeighbor("next")) event.preventDefault();
    }
  };

  const runCommand = (command: "bold" | "italic" | "strikeThrough" | "createLink", value?: string) => {
    const edit = directEditRef.current;
    if (!edit) {
      onStatus?.("请先选择一个可直接编辑的标题或段落。");
      return;
    }
    if (window.getSelection()?.isCollapsed === false && !selectionBelongsTo(edit.element)) {
      if (command === "bold" || command === "italic" || command === "strikeThrough") {
        formatCurrentCrossBlockSelection(command === "strikeThrough" ? "strike" : command);
      } else {
        onStatus?.("跨块选择不能创建单个链接；请缩小到一个文本块。");
      }
      return;
    }
    if (selectionIntersectsInlineAtom(edit.element)) {
      onStatus?.("不能跨受保护的公式、图片、链接或行内代码应用格式。");
      return;
    }
    edit.element.focus({ preventScroll: true });
    if (isComposingRef.current) {
      onStatus?.("请先确认中文输入，再应用格式。");
      return;
    }
    document.execCommand(command, false, value);
  };

  const setBlockType = (headingLevel: number) => {
    const edit = directEditRef.current;
    if (!edit) {
      onStatus?.("请先选择一个可直接编辑的标题或段落。");
      return;
    }
    if (!edit.element.matches("h1, h2, h3, h4, h5, h6, p") || edit.element.closest("blockquote")) {
      onStatus?.("列表、引用和表格单元格不能转换为标题。");
      return;
    }
    if (!commitDirectEdit(headingLevel)) return;
    edit.element.contentEditable = "false";
    edit.element.classList.remove("wysiwyg-direct-edit");
    directEditRef.current = null;
    setActiveEditKind(null);
    window.requestAnimationFrame(renderHtml);
  };

  const handleDirectBeforeInput = (event: FormEvent<HTMLElement>): void => {
    const edit = directEditRef.current;
    if (!edit) return;
    const nativeEvent = event.nativeEvent as InputEvent;
    const inputType = nativeEvent.inputType ?? "";
    if (window.getSelection()?.isCollapsed === false && !selectionBelongsTo(edit.element)) {
      if (inputType.startsWith("insert") || inputType.startsWith("delete")) {
        event.preventDefault();
        const insert = inputType.startsWith("insert") ? normalizeCrossBlockPlainText(nativeEvent.data ?? "") : "";
        replaceCurrentCrossBlockSelection(insert, insert ? "已用输入文本替换跨块选择。" : "已删除跨块选择；可用一次撤销恢复。");
      }
      return;
    }
    if (!selectionIntersectsInlineAtom(edit.element)) return;
    if (inputType.startsWith("insert") || inputType.startsWith("delete")) {
      event.preventDefault();
      onStatus?.("当前选择包含受保护的行内结构，请缩小选择范围。");
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLElement>) => {
    const edit = directEditRef.current;
    if (!edit) return;
    if (isComposingRef.current) {
      event.preventDefault();
      onStatus?.("请先确认中文输入，再粘贴文本。");
      return;
    }
    const plainText = event.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
    if (window.getSelection()?.isCollapsed === false && !selectionBelongsTo(edit.element)) {
      event.preventDefault();
      const insert = normalizeCrossBlockPlainText(plainText);
      replaceCurrentCrossBlockSelection(insert, "已用规范化纯文本替换跨块选择；可用一次撤销恢复。");
      return;
    }
    if (selectionIntersectsInlineAtom(edit.element)) {
      event.preventDefault();
      onStatus?.("不能用粘贴内容覆盖受保护的行内结构。");
      return;
    }
    event.preventDefault();
    document.execCommand("insertText", false, edit.element.matches("th, td") ? plainText.replace(/\n+/g, " ") : plainText);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    if (event.dataTransfer.types.includes("application/x-fantastic-editor-block")) {
      event.preventDefault();
      event.stopPropagation();
      const target = blockDropTargetRef.current;
      if (target) moveDraggedBlock(target.element, target.position);
      else clearBlockDropTarget();
      return;
    }
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
    const content = contentRef.current;
    const hit = document.elementFromPoint(event.clientX, event.clientY);
    const sourceElement = hit instanceof Element ? hit.closest<HTMLElement>(SOURCE_SELECTOR) : null;
    const range = sourceRangeFromElement(sourceElement, valueRef.current.length);
    const position = range?.to ?? valueRef.current.length;
    const anchorId = `wysiwyg-image-anchor-${Date.now()}-${++anchorSequenceRef.current}`;
    imageAnchorsRef.current.set(anchorId, { range: { from: position, to: position }, expectedText: valueRef.current });
    if (!content?.contains(hit)) imageAnchorsRef.current.set(anchorId, { range: { from: valueRef.current.length, to: valueRef.current.length }, expectedText: valueRef.current });
    onImageDrop?.(images, anchorId);
  };

  const sourceFormula = sourceEdit ? markdownFormulaDetails(sourceEdit.source) : null;
  const sourceFence = sourceEdit ? markdownFenceDetails(sourceEdit.source) : null;
  const sourceInlineLink = sourceEdit ? markdownInlineLinkDetails(sourceEdit.source) : null;
  const sourceInlineCode = sourceEdit ? markdownInlineCodeDetails(sourceEdit.source) : null;
  const sourceIsMermaid = sourceFence?.language.toLowerCase() === "mermaid";
  const formulaPreview = sourceFormula ? formulaPreviewResult(sourceFormula.latex, sourceFormula.displayMode) : null;
  const handleSourceCardKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      if (commitSourceEdit()) onStatus?.("结构化内容已写回 Markdown。");
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancelSourceEdit();
    }
  };

  return (
    <div className="markdown-preview wysiwyg-editor" ref={containerRef} style={{ fontFamily }} onErrorCapture={onErrorCapture} onLoadCapture={onLoadCapture} onDropCapture={handleDrop} onDragOverCapture={(event) => {
      if ([...event.dataTransfer.items].some((item) => item.kind === "file")) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }
      if (updateBlockDropTarget(event)) return;
    }}>
      <div className="wysiwyg-toolbar" role="toolbar" aria-label="所见即所得格式工具栏" onMouseDown={(event) => event.preventDefault()}>
        <button type="button" title="粗体（Ctrl+B）" onClick={() => runCommand("bold")}><strong>B</strong></button>
        <button type="button" title="斜体（Ctrl+I）" onClick={() => runCommand("italic")}><em>I</em></button>
        <button type="button" title="删除线" onClick={() => runCommand("strikeThrough")}><s>S</s></button>
        <button type="button" title="正文" onClick={() => setBlockType(0)}>正文</button>
        <button type="button" title="一级标题" onClick={() => setBlockType(1)}>H1</button>
        <button type="button" title="二级标题" onClick={() => setBlockType(2)}>H2</button>
        <button type="button" title="三级标题" onClick={() => setBlockType(3)}>H3</button>
        <button type="button" title="添加链接（Ctrl+K）" onClick={() => {
          const href = window.prompt("输入链接地址", "https://");
          if (href) runCommand("createLink", href);
        }}>链接</button>
        <span>{activeEditKind === "direct" ? "直接编辑中 · 可跨安全文本块框选、剪切、粘贴和批量格式化" : activeEditKind === "image" ? "图片编辑中 · 可修改说明、替换或删除" : activeEditKind === "source" ? "结构化内容编辑中 · Ctrl+Enter 应用" : "正文、列表、引用和表格单元格可直接编辑；公式、流程图和代码块支持专用面板"}</span>
      </div>
      {blockEditContext && (
        <div className="wysiwyg-block-toolbar" role="toolbar" aria-label="内容块操作工具栏" onMouseDown={(event) => event.preventDefault()}>
          <button
            type="button"
            className="wysiwyg-block-grip"
            draggable
            aria-label={`拖动${blockEditContext.label}`}
            title="拖动内容块"
            onMouseDown={(event) => event.stopPropagation()}
            onDragStart={startActiveBlockDrag}
            onDragEnd={() => { draggedBlockRangeRef.current = null; clearBlockDropTarget(); }}
          >⋮⋮</button>
          <span>{blockEditContext.label}</span>
          <button type="button" disabled={!blockEditContext.canMoveUp} onClick={() => moveActiveBlock("up")}>上移</button>
          <button type="button" disabled={!blockEditContext.canMoveDown} onClick={() => moveActiveBlock("down")}>下移</button>
          <button type="button" onClick={duplicateActiveBlock}>复制</button>
          <button type="button" className="danger" onClick={deleteActiveBlock}>删除</button>
          <label>
            <span className="sr-only">插入内容类型</span>
            <select value={blockInsertKind} onMouseDown={(event) => event.stopPropagation()} onChange={(event) => setBlockInsertKind(event.target.value as MarkdownBlockPreset)}>
              <option value="paragraph">正文</option>
              <option value="heading">标题</option>
              <option value="bullet-list">列表</option>
              <option value="quote">引用</option>
              <option value="code">代码块</option>
              <option value="formula">公式</option>
              <option value="mermaid">Mermaid</option>
              <option value="table">表格</option>
              <option value="image">图片引用</option>
            </select>
          </label>
          <button type="button" onClick={insertBlockAfterActive}>下方插入</button>
        </div>
      )}      {listEditContext && (
        <div className="wysiwyg-list-toolbar" role="toolbar" aria-label="列表结构工具栏" onMouseDown={(event) => event.preventDefault()}>
          <span>{listEditContext.nested ? "嵌套列表项" : "顶层列表项"} · 结构操作包含全部子项</span>
          <button type="button" onClick={() => shiftCurrentListItem("indent")}>缩进</button>
          <button type="button" onClick={() => shiftCurrentListItem("outdent")}>提升</button>
          <button type="button" disabled={!listEditContext.canMoveUp} onClick={() => moveCurrentListSubtree("up")}>上移</button>
          <button type="button" disabled={!listEditContext.canMoveDown} onClick={() => moveCurrentListSubtree("down")}>下移</button>
          <button type="button" onClick={insertListSiblingAfterCurrent}>新建同级项</button>
        </div>
      )}
      {tableEditContext && (
        <div className="wysiwyg-table-toolbar" role="toolbar" aria-label="表格结构工具栏" onMouseDown={(event) => event.preventDefault()}>
          <span>表格：第 {tableEditContext.rowIndex + 1} 行，第 {tableEditContext.columnIndex + 1} 列</span>
          <button type="button" onClick={() => applyCurrentTableOperation({ kind: "insert-row", rowIndex: tableEditContext.rowIndex, position: "before" })}>上方插行</button>
          <button type="button" onClick={() => applyCurrentTableOperation({ kind: "insert-row", rowIndex: tableEditContext.rowIndex, position: "after" })}>下方插行</button>
          <button type="button" disabled={tableEditContext.isHeader} onClick={() => applyCurrentTableOperation({ kind: "delete-row", rowIndex: tableEditContext.rowIndex })}>删除行</button>
          <button type="button" onClick={() => applyCurrentTableOperation({ kind: "insert-column", columnIndex: tableEditContext.columnIndex, position: "before" })}>左侧插列</button>
          <button type="button" onClick={() => applyCurrentTableOperation({ kind: "insert-column", columnIndex: tableEditContext.columnIndex, position: "after" })}>右侧插列</button>
          <button type="button" disabled={tableEditContext.columnCount <= 1} onClick={() => applyCurrentTableOperation({ kind: "delete-column", columnIndex: tableEditContext.columnIndex })}>删除列</button>
          <button type="button" title="左对齐" onClick={() => applyCurrentTableOperation({ kind: "set-alignment", columnIndex: tableEditContext.columnIndex, alignment: "left" })}>左齐</button>
          <button type="button" title="居中对齐" onClick={() => applyCurrentTableOperation({ kind: "set-alignment", columnIndex: tableEditContext.columnIndex, alignment: "center" })}>居中</button>
          <button type="button" title="右对齐" onClick={() => applyCurrentTableOperation({ kind: "set-alignment", columnIndex: tableEditContext.columnIndex, alignment: "right" })}>右齐</button>
        </div>
      )}
      {imageEdit && (
        <section className="wysiwyg-source-card wysiwyg-image-card" aria-label="图片属性">
          <header><strong>图片属性</strong><span>字符 {imageEdit.range.from}–{imageEdit.range.to}</span></header>
          <label>
            <span>替代文本（alt）</span>
            <input
              data-testid="wysiwyg-image-alt"
              value={imageEdit.alt}
              onChange={(event) => {
                const updated = { ...imageEdit, alt: event.target.value };
                imageEditRef.current = updated;
                setImageEdit(updated);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (commitImageAlt()) onStatus?.("图片替代文本已写回 Markdown。");
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  imageEditRef.current = null;
                  setImageEdit(null);
                  setActiveEditKind(null);
                  renderHtml();
                }
              }}
            />
          </label>
          <div>
            <button type="button" onClick={() => { if (commitImageAlt()) onStatus?.("图片替代文本已写回 Markdown。"); }}>应用</button>
            <button type="button" disabled={imageImportBusy} onClick={requestImageReplacement}>替换图片</button>
            <button type="button" className="danger" onClick={deleteSelectedImage}>删除图片</button>
            <button type="button" onClick={() => { if (finishImageEdit()) window.requestAnimationFrame(renderHtml); }}>完成</button>
          </div>
        </section>
      )}
      {sourceEdit && (
        <section className={`wysiwyg-source-card${sourceFormula || sourceFence || sourceInlineLink || sourceInlineCode ? " wysiwyg-structured-card" : ""}`} aria-label={sourceEdit.label}>
          <header>
            <strong>{sourceFormula ? "公式编辑" : sourceIsMermaid ? "Mermaid 流程图编辑" : sourceFence ? "代码块编辑" : sourceInlineLink ? "链接编辑" : sourceInlineCode ? "行内代码编辑" : sourceEdit.label}</strong>
            <span>字符 {sourceEdit.range.from}–{sourceEdit.range.to}</span>
          </header>
          {sourceInlineLink ? (
            <>
              <label>
                <span>显示文字</span>
                <input
                  data-testid="wysiwyg-link-label"
                  value={sourceInlineLink.label}
                  onChange={(event) => {
                    const replacement = replaceMarkdownInlineLink(sourceTextRef.current, { label: event.target.value });
                    if (replacement === null) { onStatus?.("链接文字无法安全写回。"); return; }
                    updateSourceDraft(replacement);
                  }}
                  onKeyDown={handleSourceCardKeyDown}
                />
              </label>
              <label>
                <span>链接地址</span>
                <input
                  data-testid="wysiwyg-link-destination"
                  value={sourceInlineLink.destination}
                  spellCheck={false}
                  onChange={(event) => {
                    const replacement = replaceMarkdownInlineLink(sourceTextRef.current, { destination: event.target.value });
                    if (replacement === null) { onStatus?.("链接地址包含不允许的字符，未修改。"); return; }
                    updateSourceDraft(replacement);
                  }}
                  onKeyDown={handleSourceCardKeyDown}
                />
              </label>
              <label>
                <span>链接标题（可选）</span>
                <input
                  data-testid="wysiwyg-link-title"
                  value={sourceInlineLink.title ?? ""}
                  onChange={(event) => {
                    const replacement = replaceMarkdownInlineLink(sourceTextRef.current, { title: event.target.value || null });
                    if (replacement === null) { onStatus?.("链接标题无法安全写回。"); return; }
                    updateSourceDraft(replacement);
                  }}
                  onKeyDown={handleSourceCardKeyDown}
                />
              </label>
            </>
          ) : sourceInlineCode ? (
            <label>
              <span>代码内容 · 分隔符 {sourceInlineCode.fence}</span>
              <input
                data-testid="wysiwyg-inline-code-source"
                value={sourceInlineCode.content}
                spellCheck={false}
                onChange={(event) => {
                  const replacement = replaceMarkdownInlineCode(sourceTextRef.current, event.target.value);
                  if (replacement === null) { onStatus?.("行内代码不支持换行，未修改。"); return; }
                  updateSourceDraft(replacement);
                }}
                onKeyDown={handleSourceCardKeyDown}
              />
            </label>
          ) : sourceFormula ? (
            <>
              <label>
                <span>LaTeX · {sourceFormula.displayMode ? "块级" : "行内"} · 分隔符 {sourceFormula.delimiter}</span>
                <textarea
                  data-testid="wysiwyg-formula-source"
                  value={sourceFormula.latex}
                  spellCheck={false}
                  onChange={(event) => {
                    const replacement = replaceMarkdownFormulaLatex(sourceTextRef.current, event.target.value);
                    if (replacement === null) {
                      onStatus?.("公式内容包含当前分隔符，无法安全写回。");
                      return;
                    }
                    updateSourceDraft(replacement);
                  }}
                  onKeyDown={handleSourceCardKeyDown}
                />
              </label>
              <div className={`wysiwyg-structured-preview formula${formulaPreview?.error ? " has-error" : ""}`} aria-live="polite">
                {formulaPreview?.error
                  ? <span>公式语法提示：{formulaPreview.error}</span>
                  : <span dangerouslySetInnerHTML={{ __html: formulaPreview?.html ?? "" }} />}
              </div>
            </>
          ) : sourceFence ? (
            <>
              <label>
                <span>语言</span>
                <input
                  data-testid="wysiwyg-code-language"
                  value={sourceFence.language}
                  disabled={sourceIsMermaid}
                  spellCheck={false}
                  onChange={(event) => {
                    const replacement = replaceMarkdownFence(sourceTextRef.current, { language: event.target.value });
                    if (replacement === null) {
                      onStatus?.("代码块语言标识无效，未修改。");
                      return;
                    }
                    updateSourceDraft(replacement);
                  }}
                  onKeyDown={handleSourceCardKeyDown}
                />
              </label>
              <label>
                <span>{sourceIsMermaid ? "Mermaid 源码" : "代码内容"}</span>
                <textarea
                  data-testid={sourceIsMermaid ? "wysiwyg-mermaid-source" : "wysiwyg-code-source"}
                  value={sourceFence.content}
                  spellCheck={false}
                  onChange={(event) => {
                    const replacement = replaceMarkdownFence(sourceTextRef.current, { content: event.target.value });
                    if (replacement === null) {
                      onStatus?.("代码围栏已变化，无法安全更新内容。");
                      return;
                    }
                    updateSourceDraft(replacement);
                  }}
                  onKeyDown={handleSourceCardKeyDown}
                />
              </label>
              {sourceIsMermaid && <div className="wysiwyg-structured-preview mermaid" ref={structuredPreviewRef} aria-live="polite" />}
            </>
          ) : (
            <textarea
              data-testid="wysiwyg-markdown-source"
              value={sourceTextRef.current}
              spellCheck={false}
              onChange={(event) => updateSourceDraft(event.target.value)}
              onKeyDown={handleSourceCardKeyDown}
            />
          )}
          <div>
            <button type="button" onClick={() => { if (commitSourceEdit()) onStatus?.("结构化内容已写回 Markdown。"); }}>应用</button>
            <button type="button" onClick={() => { if (finishSourceEdit()) window.requestAnimationFrame(renderHtml); }}>完成</button>
          </div>
        </section>
      )}
      <article
        className="preview-content wysiwyg-content"
        ref={contentRef}
        tabIndex={0}
        onPointerDown={(event: PointerEvent<HTMLElement>) => {
          const target = event.target;
          if (target === event.currentTarget) {
            event.preventDefault();
            const pending = directEditRef.current;
            if (pending?.isNewBlock && !(pending.element.textContent ?? "").trim()) {
              pending.element.focus({ preventScroll: true });
              return;
            }
            createBlankParagraph(event.clientY);
            return;
          }
          if (target instanceof HTMLInputElement && target.type === "checkbox") {
            const item = target.closest<HTMLElement>("li[data-source-from]");
            if (item) {
              event.preventDefault();
              toggleTaskItem(item, target);
              return;
            }
          }
          if (target instanceof Element) {
            const selected = selectBlock(target, { x: event.clientX, y: event.clientY });
            if (selected !== null && selected !== "direct") event.preventDefault();
          }
        }}
        onKeyDown={handleDirectKeyDown}
        onBeforeInput={handleDirectBeforeInput}
        onCompositionStart={() => {
          isComposingRef.current = true;
          pendingCompositionBlurRef.current = false;
        }}
        onCompositionEnd={() => {
          isComposingRef.current = false;
          const edit = directEditRef.current;
          if (!edit) return;
          if (pendingCompositionBlurRef.current) {
            pendingCompositionBlurRef.current = false;
            if (finishDirectEdit()) window.requestAnimationFrame(renderHtml);
            return;
          }
          onStatus?.("中文输入已确认；离开当前块时写回 Markdown。");
        }}
        onInput={() => {
          if (directEditRef.current && !isComposingRef.current) onStatus?.("正在编辑；离开当前块时写回 Markdown。");
        }}
        onBlurCapture={(event) => {
          const edit = directEditRef.current;
          if (!edit || edit.element.contains(event.relatedTarget as Node | null)) return;
          if (isComposingRef.current) {
            pendingCompositionBlurRef.current = true;
            return;
          }
          if (finishDirectEdit()) window.requestAnimationFrame(renderHtml);
        }}
        onPaste={handlePaste}
        onCopy={(event) => {
          const edit = directEditRef.current;
          const selection = window.getSelection();
          if (!edit || !selection || selection.isCollapsed || selectionBelongsTo(edit.element)) return;
          event.preventDefault();
          event.clipboardData.setData("text/plain", selection.toString().replace(/\r\n?/g, "\n"));
          onStatus?.("已复制跨块纯文本；不会复制编辑器内部 DOM。");
        }}
        onCut={(event) => {
          const edit = directEditRef.current;
          const selection = window.getSelection();
          if (!edit || !selection || selection.isCollapsed || selectionBelongsTo(edit.element)) return;
          event.preventDefault();
          const selectedText = selection.toString().replace(/\r\n?/g, "\n");
          if (replaceCurrentCrossBlockSelection("", "已剪切跨块选择；可用一次撤销恢复。")) {
            event.clipboardData.setData("text/plain", selectedText);
          }
        }}
        data-document-length={value.length}
        data-projection-ready={htmlReady ? "true" : "false"}
        data-testid="wysiwyg-editor-content"
      />
      {imageImportBusy && <div className="wysiwyg-busy" role="status">正在导入图片…</div>}
    </div>
  );
});
