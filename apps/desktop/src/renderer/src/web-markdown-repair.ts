import { normalizeLineEndings } from "@fantastic-editor/document-core";

export interface WebMarkdownRepairResult {
  markdown: string;
  changed: boolean;
  repairedMarkers: number;
  repairedInlinePairs: number;
  removedBlankLines: number;
  repairedTableGaps: number;
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
    const escapedFence = /^(\s*)((?:\\`){3,}|(?:\\~){3,})(.*)$/.exec(originalLine);
    if (escapedFence) {
      const marker = escapedFence[2]!.replaceAll("\\", "");
      const repaired = `${escapedFence[1]}${marker}${escapedFence[3]}`;
      const current = { marker: marker[0]!, length: marker.length };
      if (!fence) fence = current;
      else if (fence.marker === current.marker && current.length >= fence.length) fence = null;
      output.push(repaired);
      repairedMarkers += 1;
      continue;
    }
    const existingFence = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(originalLine);
    if (existingFence) {
      const marker = existingFence[2]!;
      const current = { marker: marker[0]!, length: marker.length };
      if (!fence) fence = current;
      else if (fence.marker === current.marker && current.length >= fence.length) fence = null;
      output.push(originalLine);
      continue;
    }
    if (fence) {
      output.push(originalLine);
      continue;
    }

    let line = originalLine;
    const incrementMarker = () => { repairedMarkers += 1; };
    const incrementInline = () => { repairedInlinePairs += 1; };
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
    changed: markdown !== normalizeLineEndings(source),
    repairedMarkers,
    repairedInlinePairs,
    removedBlankLines,
    repairedTableGaps,
  };
}
