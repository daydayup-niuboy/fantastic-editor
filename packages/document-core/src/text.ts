import type { SourcePrecision, SourceRange } from "./model.js";

export function canonicalizeEditorText(input: string): string {
  return input.replace(/\r\n?/g, "\n");
}

export function detectLineSeparator(input: string): "lf" | "crlf" | "mixed" {
  const crlfCount = (input.match(/\r\n/g) ?? []).length;
  const bareLfCount = (input.match(/(?<!\r)\n/g) ?? []).length;
  const bareCrCount = (input.match(/\r(?!\n)/g) ?? []).length;
  if ((crlfCount > 0 && (bareLfCount > 0 || bareCrCount > 0)) || bareCrCount > 0) return "mixed";
  return crlfCount > 0 ? "crlf" : "lf";
}

export function createLineStarts(text: string): number[] {
  const lineStarts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lineStarts.push(index + 1);
  }
  return lineStarts;
}

export function createSourceLocator(
  text: string,
): (from: number, to: number, precision?: SourcePrecision) => SourceRange {
  const lineStarts = createLineStarts(text);
  const pointAt = (offset: number): { line: number; column: number } => {
    const bounded = Math.max(0, Math.min(offset, text.length));
    let low = 0;
    let high = lineStarts.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      if ((lineStarts[middle] ?? 0) <= bounded) low = middle + 1;
      else high = middle - 1;
    }
    const lineIndex = Math.max(0, high);
    return { line: lineIndex + 1, column: bounded - (lineStarts[lineIndex] ?? 0) + 1 };
  };
  return (from, to, precision = "exact") => {
    const start = pointAt(from);
    const end = pointAt(to);
    return {
      from,
      to,
      startLine: start.line,
      startColumn: start.column,
      endLine: end.line,
      endColumn: end.column,
      precision,
    };
  };
}