import MarkdownIt, { type Token } from "markdown-it";
import { katex } from "@mdit/plugin-katex";
import { auditGeneratedHtmlMarkup } from "./generated-html-security.js";

export const MAX_RICH_COPY_MARKDOWN_CODE_UNITS = 512 * 1024;
export const MAX_RICH_COPY_HTML_CODE_UNITS = 1024 * 1024;
export const MAX_PASTE_PLAIN_CODE_UNITS = 1024 * 1024;

export interface ClipboardPayload {
  plain: string;
  html?: string;
  warnings: string[];
}

export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function formatClipboardImagePlaceholder(alt: string): string {
  const safeAlt = normalizeLineEndings(alt).replace(/[\[\]]/g, "").replace(/\n+/g, " ").trim() || "图片";
  return `![${safeAlt}]（图片未包含）`;
}

function isUnsafeTarget(value: string): boolean {
  const target = value.trim();
  if (/^(?:file|blob|data|app|fantastic-asset):/i.test(target)) return true;
  if (/^[a-z]:[\\/]/i.test(target) || /^(?:\\\\|\/\/)/.test(target)) return true;
  if (/^\/(?!\/)/.test(target)) return true;
  if (/^(?:https?:\/\/)?(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(target)) return true;
  return false;
}

function allowedLinkTarget(value: string): boolean {
  const target = value.trim();
  return !isUnsafeTarget(target) && /^(?:https?:|mailto:|#)/i.test(target);
}

function sanitizeInlineMarkdown(line: string): string {
  const chunks: string[] = [];
  let cursor = 0;
  const codePattern = /(`+)([\s\S]*?)\1/g;
  for (const match of line.matchAll(codePattern)) {
    const index = match.index ?? 0;
    chunks.push(sanitizeLinksAndImages(line.slice(cursor, index)));
    chunks.push(match[0]);
    cursor = index + match[0].length;
  }
  chunks.push(sanitizeLinksAndImages(line.slice(cursor)));
  return chunks.join("");
}

function sanitizeLinksAndImages(value: string): string {
  let result = value;
  result = result.replace(/!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["']([^"']*)["'])?\s*\)/g, (_full, alt: string, angle: string | undefined, bare: string | undefined) => {
    void angle;
    void bare;
    return formatClipboardImagePlaceholder(alt);
  });
  result = result.replace(/\[([^\]]+)\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["']([^"']*)["'])?\s*\)/g, (full, label: string, angle: string | undefined, bare: string | undefined) => {
    const target = angle ?? bare ?? "";
    return allowedLinkTarget(target) ? full : label;
  });
  return result;
}

export function sanitizeClipboardMarkdown(markdown: string): string {
  const lines = normalizeLineEndings(markdown).split("\n");
  let fence: string | null = null;
  return lines.map((line) => {
    const opening = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1] ?? null;
    if (fence) {
      if (opening && opening[0] === fence[0] && opening.length >= fence.length) fence = null;
      return line;
    }
    if (opening) {
      fence = opening;
      return line;
    }
    return sanitizeInlineMarkdown(line);
  }).join("\n");
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function createClipboardMarkdownEngine() {
  const options = { html: false, breaks: false, linkify: false, typographer: false };
  const engine = new MarkdownIt(options).use(katex);
  engine.renderer.rules.math_inline = (tokens: Token[], index: number) => `<span><code>${escapeHtml(`$${tokens[index]?.content ?? ""}$`)}</code></span>`;
  engine.renderer.rules.math_block = (tokens: Token[], index: number) => `<div><code>${escapeHtml(`$$\n${tokens[index]?.content ?? ""}$$`)}</code></div>\n`;
  engine.renderer.rules.image = (tokens: Token[], index: number) => {
    const alt = tokens[index]?.content ?? "图片";
    return `<span>${escapeHtml(formatClipboardImagePlaceholder(alt))}</span>`;
  };
  return engine;
}

const clipboardMarkdown = createClipboardMarkdownEngine();

export function clipboardPlainHash(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function renderMarkdownFragmentHtml(
  markdown: string,
  options: { clipboardOrigin?: "fantastic-editor-v1" } = {},
): string {
  const plain = sanitizeClipboardMarkdown(markdown);
  const rendered = clipboardMarkdown.render(plain);
  if (options.clipboardOrigin !== "fantastic-editor-v1") return rendered;
  const hash = `fnv1a32:${clipboardPlainHash(plain)}`;
  return `<div data-fantastic-clipboard="v1" data-fantastic-plain-length="${plain.length}" data-fantastic-plain-hash="${hash}">${rendered}</div>`;
}

export function buildClipboardPayload(markdown: string): ClipboardPayload {
  const plain = sanitizeClipboardMarkdown(markdown);
  if (!plain.trim()) return { plain: "", warnings: [] };
  if (plain.length > MAX_RICH_COPY_MARKDOWN_CODE_UNITS) return { plain, warnings: ["富文本复制内容超过渲染限制，已仅保留 Markdown。"] };
  const html = renderMarkdownFragmentHtml(plain, { clipboardOrigin: "fantastic-editor-v1" });
  if (html.length > MAX_RICH_COPY_HTML_CODE_UNITS) return { plain, warnings: ["富文本复制 HTML 超过体积限制，已仅保留 Markdown。"] };
  if (auditGeneratedHtmlMarkup(html).length > 0) return { plain, warnings: ["富文本复制安全审计未通过，已仅保留 Markdown。"] };
  return { plain, html, warnings: [] };
}

export function escapePlainTextForMarkdown(text: string): string {
  return normalizeLineEndings(text).replace(/[\\`*_[\]{}<>#+.!|~-]/g, "\\$&");
}
