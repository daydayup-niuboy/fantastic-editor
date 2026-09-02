import { formatClipboardImagePlaceholder, normalizeLineEndings } from "@fantastic-editor/document-core";

export const MAX_EXTERNAL_HTML_INPUT_CODE_UNITS = 512 * 1024;
export const MAX_DOM_NODES = 8000;
export const MAX_DOM_DEPTH = 64;
export const MAX_MARKDOWN_OUTPUT_CODE_UNITS = 512 * 1024;

export interface HtmlToMarkdownResult {
  markdown: string;
  warnings: string[];
  truncated: boolean;
}

interface ConvertState {
  nodes: number;
  warnings: Set<string>;
  truncated: boolean;
}

const FORBIDDEN = new Set(["script", "style", "iframe", "object", "embed", "base", "form", "noscript", "template", "svg", "canvas", "head", "meta", "link"]);
const BLOCK = new Set(["address", "article", "aside", "div", "dl", "dt", "dd", "fieldset", "figcaption", "figure", "footer", "header", "main", "nav", "p", "section", "summary"]);

function escapeText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/([`*_\[\]<>])/g, "\\$1");
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, " ");
}

export function normalizeExternalMarkdown(value: string): string {
  return normalizeLineEndings(value)
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function attr(element: Element, name: string): string {
  return element.getAttribute(name)?.trim() ?? "";
}

function safeHref(value: string): string | null {
  const href = value.trim();
  if (!/^(?:https?:|mailto:|#)/i.test(href)) return null;
  if (/^(?:https?:\/\/)?(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(href)) return null;
  return href;
}

function appendBlock(value: string): string {
  const normalized = value.replace(/\n{3,}/g, "\n\n").trim();
  return normalized ? `${normalized}\n\n` : "";
}

function children(element: Element, state: ConvertState, depth: number, context?: string): string {
  let result = "";
  for (const child of Array.from(element.childNodes)) result += convertNode(child, state, depth + 1, context);
  return result;
}

function convertTable(element: Element, state: ConvertState, depth: number): string {
  const rows = Array.from(element.querySelectorAll("tr"));
  if (rows.length === 0) return appendBlock(children(element, state, depth));
  const matrix = rows.map((row) => Array.from(row.children).filter((cell) => /^(?:th|td)$/i.test(cell.tagName)).map((cell) => children(cell, state, depth + 1, "table-cell").replace(/\n+/g, " ").replace(/\|/g, "\\|").trim()));
  const width = Math.max(1, ...matrix.map((row) => row.length));
  const normalized = matrix.map((row) => [...row, ...Array.from({ length: width - row.length }, () => "")]);
  const header = normalized[0] ?? Array.from({ length: width }, () => "");
  const lines = [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`];
  for (const row of normalized.slice(1)) lines.push(`| ${row.join(" | ")} |`);
  return appendBlock(lines.join("\n"));
}

function convertList(element: Element, state: ConvertState, depth: number): string {
  const ordered = element.tagName.toLowerCase() === "ol";
  const items = Array.from(element.children).filter((item) => item.tagName.toLowerCase() === "li");
  const lines: string[] = [];
  let nextNumber = ordered && /^\d+$/.test(attr(element, "start")) ? Number(attr(element, "start")) : 1;
  for (const item of items) {
    let own = "";
    const nested: Element[] = [];
    for (const child of Array.from(item.childNodes)) {
      if (child instanceof Element && /^(?:ul|ol)$/i.test(child.tagName)) nested.push(child);
      else own += convertNode(child, state, depth + 1, "list-item");
    }
    const checkbox = Array.from(item.children).find((child) => child instanceof HTMLInputElement && child.type === "checkbox") as HTMLInputElement | undefined;
    const explicitNumber = ordered && /^\d+$/.test(attr(item, "value")) ? Number(attr(item, "value")) : null;
    const itemNumber = explicitNumber ?? nextNumber;
    const marker = ordered ? `${itemNumber}.` : checkbox ? `- [${checkbox.checked ? "x" : " "}]` : "-";
    if (ordered) nextNumber = itemNumber + 1;
    lines.push(`${marker} ${own.trim()}`.trimEnd());
    for (const child of nested) {
      lines.push(...convertList(child, state, depth + 1).trim().split("\n").map((line) => `  ${line}`));
    }
  }
  return appendBlock(lines.join("\n"));
}

function convertNode(node: Node, state: ConvertState, depth: number, context?: string): string {
  if (state.truncated) return "";
  if (depth > MAX_DOM_DEPTH) {
    state.warnings.add("外部 HTML 嵌套层级超过限制，已停止深入解析。");
    state.truncated = true;
    return "";
  }
  state.nodes += 1;
  if (state.nodes > MAX_DOM_NODES) {
    state.warnings.add("外部 HTML 节点数量超过限制，已截断粘贴内容。");
    state.truncated = true;
    return "";
  }
  if (node.nodeType === Node.TEXT_NODE) return escapeText(cleanText(node.nodeValue ?? ""));
  if (!(node instanceof Element)) return "";
  const tag = node.tagName.toLowerCase();
  if (FORBIDDEN.has(tag)) {
    state.warnings.add(`已移除不安全 HTML：${tag}`);
    return "";
  }
  if (tag === "br") return "\n";
  if (tag === "hr") return appendBlock("---");
  if (/^h[1-6]$/.test(tag)) return appendBlock(`${"#".repeat(Number(tag[1]))} ${children(node, state, depth).trim()}`);
  if (tag === "p") return appendBlock(children(node, state, depth).trim());
  if (tag === "strong" || tag === "b") return `**${children(node, state, depth).trim()}**`;
  if (tag === "em" || tag === "i") return `*${children(node, state, depth).trim()}*`;
  if (tag === "del" || tag === "s" || tag === "strike") return `~~${children(node, state, depth).trim()}~~`;
  if (tag === "code" && node.parentElement?.tagName.toLowerCase() !== "pre") return `\`${(node.textContent ?? "").replace(/`/g, "\\`")}\``;
  if (tag === "pre") {
    const code = node.querySelector("code");
    const language = code ? (attr(code, "class").match(/(?:^|\s)language-([\w+-]+)/i)?.[1] ?? "") : "";
    const content = (code?.textContent ?? node.textContent ?? "").replace(/\r\n?/g, "\n").replace(/\n+$/, "");
    return appendBlock(`\`\`\`${language}\n${content}\n\`\`\``);
  }
  if (tag === "blockquote") {
    const inner = children(node, state, depth).trim();
    return appendBlock(inner.split("\n").map((line) => line ? `> ${line}` : "> ").join("\n"));
  }
  if (tag === "a") {
    const label = children(node, state, depth).trim();
    const href = safeHref(attr(node, "href"));
    return href && label ? `[${label}](${href})` : label;
  }
  if (tag === "img") return formatClipboardImagePlaceholder(attr(node, "alt") || "图片");
  if (tag === "table") return convertTable(node, state, depth);
  if (tag === "ul" || tag === "ol") return convertList(node, state, depth);
  if (tag === "li") return children(node, state, depth);
  const value = children(node, state, depth, context);
  return BLOCK.has(tag) ? appendBlock(value) : value;
}

function fallbackHtmlToMarkdown(html: string): HtmlToMarkdownResult {
  const warnings = ["当前运行环境无法构造 DOM，已将外部 HTML 降级为纯文本。"];
  const text = html.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]*>/g, "").replace(/&nbsp;/gi, " ").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&amp;/gi, "&");
  return { markdown: normalizeExternalMarkdown(text), warnings, truncated: false };
}

export function htmlToMarkdown(html: string): HtmlToMarkdownResult {
  if (html.length > MAX_EXTERNAL_HTML_INPUT_CODE_UNITS) {
    return { markdown: "", warnings: ["外部 HTML 超过输入限制，已拒绝粘贴。"], truncated: true };
  }
  if (typeof DOMParser === "undefined") return fallbackHtmlToMarkdown(html);
  const document = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const root = document.body.firstElementChild;
  if (!root) return { markdown: "", warnings: ["外部 HTML 为空。"], truncated: false };
  const state: ConvertState = { nodes: 0, warnings: new Set(), truncated: false };
  let markdown = normalizeExternalMarkdown(convertNode(root, state, 0));
  if (markdown.length > MAX_MARKDOWN_OUTPUT_CODE_UNITS) {
    markdown = markdown.slice(0, MAX_MARKDOWN_OUTPUT_CODE_UNITS);
    state.warnings.add("转换后的 Markdown 超过输出限制，已截断。");
    state.truncated = true;
  }
  return { markdown, warnings: [...state.warnings], truncated: state.truncated };
}
