import {
  clipboardPlainHash,
  escapePlainTextForMarkdown,
  MAX_PASTE_PLAIN_CODE_UNITS,
  normalizeLineEndings,
  sanitizeClipboardMarkdown,
} from "@fantastic-editor/document-core";
import { htmlToMarkdown, normalizeExternalMarkdown } from "./html-to-markdown";

export type PasteIntent = "normal" | "literal";

export interface ResolvedClipboardPaste {
  markdown: string;
  source: "internal" | "html" | "markdown" | "plain" | "literal" | "empty";
  warnings: string[];
  rejected: boolean;
}

interface InternalMarker {
  length: number;
  hash: string;
}

function markerFromHtml(html: string): InternalMarker | null {
  const markers = [...html.matchAll(/<[^>]*\bdata-fantastic-clipboard\s*=\s*["']v1["'][^>]*>/gi)];
  if (markers.length === 0) return null;
  const values = markers.map((match) => {
    const tag = match[0];
    const length = /\bdata-fantastic-plain-length\s*=\s*["'](\d+)["']/i.exec(tag)?.[1];
    const hash = /\bdata-fantastic-plain-hash\s*=\s*["'](fnv1a32:[0-9a-f]{8})["']/i.exec(tag)?.[1];
    return length && hash ? { length: Number(length), hash } : null;
  });
  if (values.some((value) => value === null)) return null;
  const first = values[0]!;
  return values.every((value) => value!.length === first.length && value!.hash === first.hash) ? first : null;
}

function limitPlain(value: string): { text: string; rejected: boolean } {
  const text = normalizeLineEndings(value);
  if (text.length > MAX_PASTE_PLAIN_CODE_UNITS) return { text: "", rejected: true };
  return { text, rejected: false };
}

function looksLikeMarkdown(value: string): boolean {
  const text = normalizeExternalMarkdown(value);
  let signals = 0;
  if (/^ {0,3}#{1,6}\s+\S/m.test(text)) signals += 1;
  if (/^\s*(?:[-+*]|\d+[.)])\s+\S/m.test(text)) signals += 1;
  if (/^ {0,3}>\s+\S/m.test(text)) signals += 1;
  if (/^ {0,3}(?:`{3,}|~{3,})/m.test(text)) signals += 2;
  if (/^\s*\|.*\|\s*\n\s*\|(?:\s*:?-{3,}:?\s*\|)+/m.test(text)) signals += 2;
  if (/\*\*\S[^\n]*?\*\*/.test(text) || /(?<!!)\[[^\]]+\]\((?:https?:|mailto:|#)/i.test(text)) signals += 1;
  return signals >= 2;
}

function restoreEscapedMarkdown(value: string): string {
  const restored = value.replace(/\\([\\`*_[\]{}<>#+.!|~-])/g, "$1");
  return looksLikeMarkdown(restored) ? restored : value;
}

function comparableText(value: string): string {
  return normalizeExternalMarkdown(value)
    .replace(/\\([\\`*_[\]{}<>#+.!|~-])/g, "$1")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function repeatsPlainText(converted: string, plain: string): boolean {
  const needle = comparableText(plain);
  if (needle.length < 80) return false;
  const haystack = comparableText(converted);
  const first = haystack.indexOf(needle);
  return first >= 0 && haystack.indexOf(needle, first + needle.length) >= 0;
}

function hasSemanticDocumentHtml(value: string): boolean {
  return /<(?:h[1-6]|ul|ol|table|blockquote|pre)\b/i.test(value);
}

function reconcileConvertedHtml(converted: string, plain: string): { markdown: string; incomplete: boolean } {
  const repaired = restoreEscapedMarkdown(converted);
  const plainComparable = comparableText(plain);
  const convertedComparable = comparableText(repaired);
  const incomplete = plainComparable.length >= 80 && convertedComparable.length < plainComparable.length * 0.85;
  return { markdown: repaired, incomplete };
}

export function resolveClipboardPaste(input: {
  plainText?: string;
  htmlText?: string;
  intent?: PasteIntent;
}): ResolvedClipboardPaste {
  const plainInput = input.plainText ?? "";
  const htmlInput = input.htmlText ?? "";
  const limited = limitPlain(plainInput);
  if (limited.rejected) return { markdown: "", source: "empty", warnings: ["剪贴板纯文本超过 1 MiB 限制，已拒绝粘贴。"], rejected: true };
  if (input.intent === "literal") {
    return { markdown: escapePlainTextForMarkdown(limited.text), source: "literal", warnings: [], rejected: false };
  }
  const marker = markerFromHtml(htmlInput);
  const markerPresent = /\bdata-fantastic-clipboard\s*=/i.test(htmlInput);
  if (marker && limited.text.length === marker.length && clipboardPlainHash(limited.text) === marker.hash.slice("fnv1a32:".length)) {
    return { markdown: sanitizeClipboardMarkdown(limited.text), source: "internal", warnings: [], rejected: false };
  }
  const warnings: string[] = [];
  const externalPlain = normalizeExternalMarkdown(limited.text);
  const semanticHtml = htmlInput.trim() && !markerPresent && hasSemanticDocumentHtml(htmlInput);
  let convertedHtml: ReturnType<typeof htmlToMarkdown> | null = null;
  if (semanticHtml) {
    convertedHtml = htmlToMarkdown(htmlInput);
    warnings.push(...convertedHtml.warnings);
    if (convertedHtml.markdown.trim()) {
      const reconciled = reconcileConvertedHtml(convertedHtml.markdown, externalPlain);
      if (!reconciled.incomplete) {
        return { markdown: sanitizeClipboardMarkdown(reconciled.markdown), source: "html", warnings, rejected: false };
      }
      warnings.push("富文本剪贴板正文不完整，已优先保留较完整的纯文本内容。");
    }
  }
  const externalMarkdown = restoreEscapedMarkdown(externalPlain);
  if (externalMarkdown && looksLikeMarkdown(externalMarkdown)) {
    return { markdown: sanitizeClipboardMarkdown(externalMarkdown), source: "markdown", warnings, rejected: false };
  }
  if (htmlInput.trim() && !markerPresent) {
    const converted = convertedHtml ?? htmlToMarkdown(htmlInput);
    warnings.push(...converted.warnings);
    const reconciled = reconcileConvertedHtml(converted.markdown, externalPlain);
    if (externalPlain && repeatsPlainText(reconciled.markdown, externalPlain)) {
      warnings.push("检测到网页富文本包含重复正文，已改用单份纯文本内容。");
      return { markdown: sanitizeClipboardMarkdown(externalPlain), source: "plain", warnings, rejected: false };
    }
    if (reconciled.markdown.trim() && !reconciled.incomplete) {
      return { markdown: sanitizeClipboardMarkdown(reconciled.markdown), source: "html", warnings, rejected: false };
    }
  } else if (markerPresent) {
    warnings.push("内部剪贴板完整性校验未通过，已回退到安全纯文本。");
  }
  if (externalPlain) return { markdown: sanitizeClipboardMarkdown(externalPlain), source: "plain", warnings, rejected: false };
  return { markdown: "", source: "empty", warnings, rejected: false };
}
