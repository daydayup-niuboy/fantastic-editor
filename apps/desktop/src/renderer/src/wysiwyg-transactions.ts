export interface WysiwygTextChange {
  from: number;
  to: number;
  insert: string;
  expectedText: string;
}

export interface WysiwygSourceRange {
  from: number;
  to: number;
}

export function isValidSourceRange(range: WysiwygSourceRange, textLength: number): boolean {
  return Number.isInteger(range.from)
    && Number.isInteger(range.to)
    && range.from >= 0
    && range.to >= range.from
    && range.to <= textLength;
}

export function applyWysiwygTextChange(currentText: string, change: WysiwygTextChange): string | null {
  if (currentText !== change.expectedText || !isValidSourceRange(change, currentText.length)) return null;
  return currentText.slice(0, change.from) + change.insert + currentText.slice(change.to);
}

export function sourceRangeFromElement(element: Element | null, textLength: number): WysiwygSourceRange | null {
  if (!(element instanceof HTMLElement)) return null;
  const from = Number(element.dataset.sourceFrom);
  const to = Number(element.dataset.sourceTo);
  const range = { from, to };
  return isValidSourceRange(range, textLength) && to > from ? range : null;
}

export function preserveTrailingLineBreaks(originalSource: string, replacement: string): string {
  const trailing = /\n+$/.exec(originalSource)?.[0] ?? "";
  return replacement.replace(/\n+$/g, "") + trailing;
}

export function escapeMarkdownText(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replace(/([\[\]*_~`])/g, "\\$1");
}
