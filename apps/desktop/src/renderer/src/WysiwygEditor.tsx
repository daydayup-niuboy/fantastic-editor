import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type PointerEvent,
  type ReactEventHandler,
} from "react";
import type { ImportedAssetReceipt } from "@fantastic-editor/shared";
import { createImageMarkdown } from "./image-insertion";
import { renderMermaidPreview } from "./mermaid-preview";
import {
  escapeMarkdownText,
  preserveTrailingLineBreaks,
  sourceRangeFromElement,
  type WysiwygSourceRange,
  type WysiwygTextChange,
} from "./wysiwyg-transactions";

interface WysiwygEditorProps {
  value: string;
  html: string;
  fontFamily: string;
  darkMode: boolean;
  imageImportBusy: boolean;
  onApplyTextChange(change: WysiwygTextChange): string | null;
  onImageDrop?(files: File[], anchorId: string): void;
  onDropRejected?(message: string): void;
  onStatus?(message: string): void;
  onErrorCapture?: ReactEventHandler<HTMLDivElement>;
  onLoadCapture?: ReactEventHandler<HTMLDivElement>;
}

interface ImageAnchor {
  range: WysiwygSourceRange;
  expectedText: string;
}

interface DirectEditState {
  element: HTMLElement;
  range: WysiwygSourceRange;
  expectedText: string;
  originalSource: string;
}

interface SourceEditState {
  range: WysiwygSourceRange;
  expectedText: string;
  source: string;
  committedSource: string;
  label: string;
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
const COMPLEX_SELECTOR = "li, blockquote, table, pre, .preview-formula-block, .mermaid-diagram, [data-source-kind=image]";

function escapeLinkDestination(value: string): string {
  return value.trim().replaceAll(" ", "%20").replaceAll(")", "%29");
}

function serializeInlineNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeMarkdownText(node.textContent ?? "");
  if (!(node instanceof HTMLElement)) return "";
  const content = () => [...node.childNodes].map(serializeInlineNode).join("");
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
    case "P": return `${content()}\n`;
    default: return content();
  }
}

function serializeDirectBlock(element: HTMLElement, originalSource: string, headingLevel?: number): string {
  const inline = [...element.childNodes].map(serializeInlineNode).join("").replace(/\n+$/g, "");
  const currentHeading = /^H([1-6])$/.exec(element.tagName);
  const resolvedHeadingLevel = headingLevel ?? (currentHeading ? Number(currentHeading[1]) : 0);
  const leadingWhitespace = /^[ \t]*/.exec(originalSource)?.[0] ?? "";
  const replacement = resolvedHeadingLevel > 0
    ? `${"#".repeat(resolvedHeadingLevel)} ${inline}`
    : `${leadingWhitespace}${inline}`;
  return preserveTrailingLineBreaks(originalSource, replacement);
}

function complexEditableElement(target: Element, textLength: number): HTMLElement | null {
  const complex = target.closest<HTMLElement>(COMPLEX_SELECTOR);
  if (complex && sourceRangeFromElement(complex, textLength)) return complex;
  return null;
}

function directEditableElement(target: Element, textLength: number): HTMLElement | null {
  const element = target.closest<HTMLElement>("h1, h2, h3, h4, h5, h6, p");
  if (!element || !sourceRangeFromElement(element, textLength)) return null;
  if (element.closest("li, blockquote, table") || element.querySelector("img, .katex, .resource-placeholder")) return null;
  return element;
}

function labelForSourceElement(element: HTMLElement): string {
  if (element.matches(".mermaid-diagram, pre:has(code.language-mermaid)")) return "Mermaid 源码";
  if (element.matches(".preview-formula-block") || element.querySelector(".katex")) return "公式源码";
  if (element.matches("[data-source-kind=image]") || element.querySelector("img, [data-source-kind=image]")) return "图片 Markdown";
  if (element.matches("table")) return "表格 Markdown";
  if (element.matches("li")) return "列表项 Markdown";
  if (element.matches("blockquote")) return "引用 Markdown";
  if (element.matches("pre")) return "代码块 Markdown";
  return "Markdown 源码";
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
  { value, html, fontFamily, darkMode, imageImportBusy, onApplyTextChange, onImageDrop, onDropRejected, onStatus, onErrorCapture, onLoadCapture },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLElement>(null);
  const valueRef = useRef(value);
  const htmlRef = useRef(html);
  const directEditRef = useRef<DirectEditState | null>(null);
  const sourceEditRef = useRef<SourceEditState | null>(null);
  const sourceTextRef = useRef("");
  const imageAnchorsRef = useRef(new Map<string, ImageAnchor>());
  const anchorSequenceRef = useRef(0);
  const commitTimerRef = useRef<number | null>(null);
  const renderSequenceRef = useRef(0);
  const [sourceEdit, setSourceEdit] = useState<SourceEditState | null>(null);

  valueRef.current = value;
  htmlRef.current = html;
  sourceEditRef.current = sourceEdit;

  const clearCommitTimer = () => {
    if (commitTimerRef.current !== null) window.clearTimeout(commitTimerRef.current);
    commitTimerRef.current = null;
  };

  const commitDirectEdit = (headingLevel?: number): boolean => {
    clearCommitTimer();
    const edit = directEditRef.current;
    if (!edit) return true;
    const insert = serializeDirectBlock(edit.element, edit.originalSource, headingLevel);
    if (insert === edit.originalSource) return true;
    const next = onApplyTextChange({ ...edit.range, insert, expectedText: edit.expectedText });
    if (next === null) {
      onStatus?.("所见即所得编辑基于旧文档版本，已拒绝写入；请重新选择该段落。");
      return false;
    }
    edit.expectedText = next;
    edit.originalSource = insert;
    edit.range = { from: edit.range.from, to: edit.range.from + insert.length };
    valueRef.current = next;
    return true;
  };

  const finishDirectEdit = (): boolean => {
    const edit = directEditRef.current;
    if (!edit) return true;
    const committed = commitDirectEdit();
    edit.element.contentEditable = "false";
    edit.element.classList.remove("wysiwyg-direct-edit");
    directEditRef.current = null;
    return committed;
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
    }
    return committed;
  };

  const commitPending = (): boolean => {
    const directCommitted = finishDirectEdit();
    const sourceCommitted = finishSourceEdit();
    if (directCommitted && sourceCommitted) window.requestAnimationFrame(renderHtml);
    return directCommitted && sourceCommitted;
  };

  const renderHtml = () => {
    const content = contentRef.current;
    if (!content || directEditRef.current || sourceEditRef.current) return;
    const sequence = ++renderSequenceRef.current;
    content.innerHTML = htmlRef.current;
    void renderMermaidPreview(content, { darkMode, fontFamily }).then(() => {
      if (sequence !== renderSequenceRef.current) return;
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
      const insert = imageInsertionText(anchor.expectedText, anchor.range.from, receipts);
      return onApplyTextChange({ ...anchor.range, insert, expectedText: anchor.expectedText }) !== null;
    },
    commitPending,
    focus() { (directEditRef.current?.element ?? contentRef.current)?.focus(); },
  }));

  useEffect(() => { if (!directEditRef.current && !sourceEditRef.current) renderHtml(); }, [html, darkMode, fontFamily]);
  useEffect(() => () => clearCommitTimer(), []);

  const selectBlock = (target: Element) => {
    const content = contentRef.current;
    if (!content) return;
    for (const selected of content.querySelectorAll(".wysiwyg-selected")) selected.classList.remove("wysiwyg-selected");
    const complex = complexEditableElement(target, valueRef.current.length);
    if (complex) {
      finishDirectEdit();
      const range = sourceRangeFromElement(complex, valueRef.current.length);
      if (!range) return;
      complex.classList.add("wysiwyg-selected");
      const next = {
        range,
        expectedText: valueRef.current,
        source: valueRef.current.slice(range.from, range.to),
        committedSource: valueRef.current.slice(range.from, range.to),
        label: labelForSourceElement(complex),
      };
      sourceTextRef.current = next.source;
      sourceEditRef.current = next;
      setSourceEdit(next);
      return;
    }
    const direct = directEditableElement(target, valueRef.current.length);
    if (!direct) return;
    finishSourceEdit();
    if (directEditRef.current?.element !== direct) finishDirectEdit();
    const range = sourceRangeFromElement(direct, valueRef.current.length);
    if (!range) return;
    direct.classList.add("wysiwyg-selected", "wysiwyg-direct-edit");
    direct.contentEditable = "true";
    direct.spellcheck = true;
    directEditRef.current = {
      element: direct,
      range,
      expectedText: valueRef.current,
      originalSource: valueRef.current.slice(range.from, range.to),
    };
    direct.focus({ preventScroll: true });
  };

  const runCommand = (command: "bold" | "italic" | "strikeThrough" | "createLink", value?: string) => {
    const edit = directEditRef.current;
    if (!edit) {
      onStatus?.("请先选择一个可直接编辑的标题或段落。");
      return;
    }
    edit.element.focus({ preventScroll: true });
    document.execCommand(command, false, value);
    commitTimerRef.current = window.setTimeout(commitDirectEdit, 500);
  };

  const setBlockType = (headingLevel: number) => {
    const edit = directEditRef.current;
    if (!edit) {
      onStatus?.("请先选择一个可直接编辑的标题或段落。");
      return;
    }
    if (!commitDirectEdit(headingLevel)) return;
    edit.element.contentEditable = "false";
    edit.element.classList.remove("wysiwyg-direct-edit");
    directEditRef.current = null;
    window.requestAnimationFrame(renderHtml);
  };

  const handlePaste = (event: ClipboardEvent<HTMLElement>) => {
    if (!directEditRef.current) return;
    event.preventDefault();
    document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
  };

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

  return (
    <div className="markdown-preview wysiwyg-editor" ref={containerRef} style={{ fontFamily }} onErrorCapture={onErrorCapture} onLoadCapture={onLoadCapture} onDropCapture={handleDrop} onDragOverCapture={(event) => {
      if ([...event.dataTransfer.items].some((item) => item.kind === "file")) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }
    }}>
      <div className="wysiwyg-toolbar" role="toolbar" aria-label="所见即所得格式工具栏" onMouseDown={(event) => event.preventDefault()}>
        <button type="button" title="粗体" onClick={() => runCommand("bold")}><strong>B</strong></button>
        <button type="button" title="斜体" onClick={() => runCommand("italic")}><em>I</em></button>
        <button type="button" title="删除线" onClick={() => runCommand("strikeThrough")}><s>S</s></button>
        <button type="button" title="正文" onClick={() => setBlockType(0)}>正文</button>
        <button type="button" title="一级标题" onClick={() => setBlockType(1)}>H1</button>
        <button type="button" title="二级标题" onClick={() => setBlockType(2)}>H2</button>
        <button type="button" title="三级标题" onClick={() => setBlockType(3)}>H3</button>
        <button type="button" title="添加链接" onClick={() => {
          const href = window.prompt("输入链接地址", "https://");
          if (href) runCommand("createLink", href);
        }}>链接</button>
        <span>点击正文直接编辑；图片、公式、流程图、列表、表格和代码块使用源码卡片。</span>
      </div>
      {sourceEdit && (
        <section className="wysiwyg-source-card" aria-label={sourceEdit.label}>
          <header><strong>{sourceEdit.label}</strong><span>字符 {sourceEdit.range.from}–{sourceEdit.range.to}</span></header>
          <textarea
            value={sourceTextRef.current}
            spellCheck={false}
            onChange={(event) => {
              sourceTextRef.current = event.target.value;
              setSourceEdit((current) => current ? { ...current, source: event.target.value } : current);
            }}
            onKeyDown={(event) => {
              if (event.ctrlKey && event.key === "Enter") {
                event.preventDefault();
                if (commitSourceEdit()) onStatus?.("源码块修改已写回 Markdown。");
              }
              if (event.key === "Escape") {
                event.preventDefault();
                sourceTextRef.current = sourceEdit.source;
                sourceEditRef.current = null;
                setSourceEdit(null);
                renderHtml();
              }
            }}
          />
          <div><button type="button" onClick={() => { if (commitSourceEdit()) onStatus?.("源码块修改已写回 Markdown。"); }}>应用</button><button type="button" onClick={() => { if (finishSourceEdit()) window.requestAnimationFrame(renderHtml); }}>完成</button></div>
        </section>
      )}
      <article
        className="preview-content wysiwyg-content"
        ref={contentRef}
        tabIndex={0}
        onPointerDown={(event: PointerEvent<HTMLElement>) => {
          const target = event.target;
          if (target instanceof Element) selectBlock(target);
        }}
        onInput={() => {
          if (!directEditRef.current) return;
          clearCommitTimer();
          commitTimerRef.current = window.setTimeout(commitDirectEdit, 700);
        }}
        onBlurCapture={(event) => {
          const edit = directEditRef.current;
          if (!edit || edit.element.contains(event.relatedTarget as Node | null)) return;
          if (finishDirectEdit()) window.requestAnimationFrame(renderHtml);
        }}
        onPaste={handlePaste}
        data-document-length={value.length}
        data-testid="wysiwyg-editor-content"
      />
      {imageImportBusy && <div className="wysiwyg-busy" role="status">正在导入图片…</div>}
    </div>
  );
});
