import { normalizeLineEndings } from "@fantastic-editor/document-core";

export interface WebMarkdownRepairResult {
  markdown: string;
  changed: boolean;
  repairedMarkers: number;
  repairedInlinePairs: number;
  removedBlankLines: number;
  repairedTableGaps: number;
}

export interface MarkdownDocumentFenceResult {
  markdown: string;
  detected: boolean;
}

export function nextWebMarkdownRepairSource(current: string | null, pasted: boolean, value: string): string | null {
  return pasted ? value : current;
}

const MARKDOWN_FENCE_LANGUAGE = /^(?:markdown|md|mkd|mdown)$/i;
const LEADING_WEB_SPACE_BEFORE_MARKDOWN = /^([\u00A0\u202F]+)(?=(?:#{1,6}(?:\s|$)|>(?:\s|$)|(?:[-+*]|\d{1,9}[.)])\s|(?:-{3,}|\*{3,}|_{3,})\s*$|\|.*\|\s*$|`{3,}|~{3,}))/;

function normalizeLeadingWebSpace(line: string): string {
  return line.replace(LEADING_WEB_SPACE_BEFORE_MARKDOWN, (spaces) => " ".repeat(spaces.length));
}

export function unwrapMarkdownDocumentFence(source: string): MarkdownDocumentFenceResult {
  const normalized = normalizeLineEndings(source);
  const lines = normalized.split("\n");
  const firstContent = lines.findIndex((line) => line.trim().length > 0);
  if (firstContent < 0) return { markdown: normalized, detected: false };
  const opening = /^\uFEFF?\s*(`{3,}|~{3,})\s*([\w-]+)\s*$/.exec(lines[firstContent]!);
  if (!opening || !MARKDOWN_FENCE_LANGUAGE.test(opening[2]!)) return { markdown: normalized, detected: false };

  const lastContent = lines.findLastIndex((line) => line.trim().length > 0);
  let internalFence: { marker: string; length: number } | null = null;
  let wrapperClosing = -1;
  let structureSignals = 0;
  for (let index = firstContent + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const info = fence[2]!.trim();
      if (internalFence) {
        if (marker[0] === internalFence.marker && marker.length >= internalFence.length && !info) internalFence = null;
      } else if (info || index !== lastContent) {
        internalFence = { marker: marker[0]!, length: marker.length };
      } else if (marker[0] === opening[1]![0] && marker.length >= opening[1]!.length) {
        wrapperClosing = index;
      }
      continue;
    }
    if (internalFence) continue;
    if (/^\s{0,3}#{1,6}\s+\S/.test(line)
      || /^\s{0,3}(?:[-+*]|\d+[.)])\s+\S/.test(line)
      || /^\s{0,3}>\s+\S/.test(line)
      || /^\s*\|.*\|\s*$/.test(line)
      || /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)
      || /!\[[^\]]*]\([^)]+\)/.test(line)) structureSignals += 1;
  }
  if (structureSignals < 2) return { markdown: normalized, detected: false };

  const output = lines.filter((_line, index) => index !== firstContent && index !== wrapperClosing);
  return { markdown: output.join("\n"), detected: true };
}

function replaceCounted(value: string, pattern: RegExp, replacement: string, increment: () => void): string {
  return value.replace(pattern, (...args: unknown[]) => {
    increment();
    return replacement.replace(/\$(\d+)/g, (_match, index: string) => String(args[Number(index)] ?? ""));
  });
}

export function repairWebMarkdown(source: string): WebMarkdownRepairResult {
  const input = normalizeLineEndings(source).split("\n");
  const output: string[] = [];
  let fence: { marker: string; length: number } | null = null;
  let repairedMarkers = 0;
  let repairedInlinePairs = 0;
  let removedBlankLines = 0;
  let repairedTableGaps = 0;

  for (const originalLine of input) {
    const normalizedLine = normalizeLeadingWebSpace(originalLine);
    const escapedFence = /^(\s*)((?:\\`){3,}|(?:\\~){3,})(.*)$/.exec(normalizedLine);
    if (escapedFence) {
      const marker = escapedFence[2]!.replaceAll("\\", "");
      const repaired = `${escapedFence[1]}${marker}${escapedFence[3]}`;
      const current = { marker: marker[0]!, length: marker.length };
      if (!fence) fence = current;
      else if (fence.marker === current.marker && current.length >= fence.length) fence = null;
      output.push(repaired);
      repairedMarkers += normalizedLine === originalLine ? 1 : 2;
      continue;
    }
    const existingFence = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(normalizedLine);
    if (existingFence) {
      const marker = existingFence[2]!;
      const current = { marker: marker[0]!, length: marker.length };
      if (!fence) fence = current;
      else if (fence.marker === current.marker && current.length >= fence.length) fence = null;
      output.push(normalizedLine);
      if (normalizedLine !== originalLine) repairedMarkers += 1;
      continue;
    }
    if (fence) {
      output.push(originalLine);
      continue;
    }

    let line = normalizedLine;
    const incrementMarker = () => { repairedMarkers += 1; };
    const incrementInline = () => { repairedInlinePairs += 1; };
    if (normalizedLine !== originalLine) incrementMarker();
    line = line.replace(/^(\s*)((?:\\#){1,6})(?=\s)/, (_match, indent: string, markers: string) => {
      incrementMarker();
      return `${indent}${markers.replaceAll("\\", "")}`;
    });
    line = replaceCounted(line, /^(\s*)\\([-+*])(?=\s)/, "$1$2", incrementMarker);
    line = replaceCounted(line, /^(\s*)(\d{1,9})\\([.)])(?=\s)/, "$1$2$3", incrementMarker);
    line = replaceCounted(line, /^(\s*)\\>(?=\s)/, "$1>", incrementMarker);
    line = replaceCounted(line, /^(\s*[-+*]\s+)\\\[([ xX])\\\](?=\s)/, "$1[$2]", incrementMarker);
    line = line.replace(/^(\s*)((?:\\-){3,}|(?:\\\*){3,}|(?:\\_){3,})\s*$/, (_match, indent: string, markers: string) => {
      incrementMarker();
      return `${indent}${markers.replaceAll("\\", "")}`;
    });
    line = replaceCounted(line, /\\\*\\\*([^\n]+?)\\\*\\\*/g, "**$1**", incrementInline);
    line = replaceCounted(line, /\\_\\_([^\n]+?)\\_\\_/g, "__$1__", incrementInline);
    line = replaceCounted(line, /\\~\\~([^\n]+?)\\~\\~/g, "~~$1~~", incrementInline);
    line = replaceCounted(line, /\\`([^`\n]+?)\\`/g, "`$1`", incrementInline);

    if (!line.trim()) {
      if (output.at(-1) === "") removedBlankLines += 1;
      else {
        if (line.length > 0) removedBlankLines += 1;
        output.push("");
      }
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && output.at(-1) === "" && /^\s*\|.*\|\s*$/.test(output.at(-2) ?? "")) {
      output.pop();
      repairedTableGaps += 1;
    }
    output.push(line);
  }
  while (output.at(-1) === "") output.pop();
  const markdown = output.join("\n");
  return {
    markdown,
    changed: repairedMarkers > 0 || repairedInlinePairs > 0 || removedBlankLines > 0 || repairedTableGaps > 0,
    repairedMarkers,
    repairedInlinePairs,
    removedBlankLines,
    repairedTableGaps,
  };
}
