export interface SearchNavigationResult {
  index: number;
  total: number;
}

export interface TextSearchOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
}

interface TextSegment {
  node: Text;
  from: number;
  to: number;
}

export interface VisibleTextMatch {
  ranges: Range[];
}

function visibleTextSegments(root: HTMLElement): TextSegment[] {
  const segments: TextSegment[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest("[aria-hidden=\"true\"], button, script, style, .preview-code-toolbar")) return NodeFilter.FILTER_REJECT;
      if (!node.textContent) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let offset = 0;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.textContent ?? "";
    segments.push({ node: node as Text, from: offset, to: offset + text.length });
    offset += text.length;
  }
  return segments;
}

const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

function isWholeWord(text: string, from: number, to: number): boolean {
  return !WORD_CHARACTER.test(text[from - 1] ?? "") && !WORD_CHARACTER.test(text[to] ?? "");
}

export function findVisibleTextMatches(root: HTMLElement, query: string, options: TextSearchOptions = {}): VisibleTextMatch[] {
  const normalized = query.trim();
  if (!normalized) return [];
  const segments = visibleTextSegments(root);
  const text = segments.map((segment) => segment.node.textContent ?? "").join("");
  const searchableText = options.caseSensitive ? text : text.toLocaleLowerCase();
  const searchableQuery = options.caseSensitive ? normalized : normalized.toLocaleLowerCase();
  const matches: VisibleTextMatch[] = [];
  let cursor = 0;
  while (cursor <= text.length - normalized.length) {
    const found = searchableText.indexOf(searchableQuery, cursor);
    if (found < 0) break;
    const end = found + normalized.length;
    if (options.wholeWord && !isWholeWord(text, found, end)) {
      cursor = found + 1;
      continue;
    }
    const ranges: Range[] = [];
    for (const segment of segments) {
      const overlapFrom = Math.max(found, segment.from);
      const overlapTo = Math.min(end, segment.to);
      if (overlapTo <= overlapFrom) continue;
      const range = document.createRange();
      range.setStart(segment.node, overlapFrom - segment.from);
      range.setEnd(segment.node, overlapTo - segment.from);
      ranges.push(range);
    }
    if (ranges.length > 0) matches.push({ ranges });
    cursor = Math.max(end, found + 1);
  }
  return matches;
}

function clearHighlights(): void {
  const css = (globalThis as typeof globalThis & { CSS?: { highlights?: { delete(name: string): void } } }).CSS;
  css?.highlights?.delete("fantastic-editor-search");
  css?.highlights?.delete("fantastic-editor-search-current");
}

export function clearVisibleTextSearch(): void {
  clearHighlights();
  window.getSelection()?.removeAllRanges();
}

export function applyVisibleTextSearch(root: HTMLElement, query: string, direction = 1, previousIndex = -1, options: TextSearchOptions = {}): SearchNavigationResult {
  clearHighlights();
  const matches = findVisibleTextMatches(root, query, options);
  if (matches.length === 0) return { index: 0, total: 0 };
  const index = previousIndex >= 0
    ? (previousIndex + (direction < 0 ? matches.length - 1 : 1)) % matches.length
    : direction < 0 ? matches.length - 1 : 0;
  const current = matches[index]!;
  const css = (globalThis as typeof globalThis & { CSS?: { highlights?: { set(name: string, value: unknown): void } } }).CSS;
  const Highlight = (globalThis as typeof globalThis & { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (css?.highlights && Highlight) {
    const allRanges = matches.flatMap((match) => match.ranges);
    css.highlights.set("fantastic-editor-search", new Highlight(...allRanges));
    css.highlights.set("fantastic-editor-search-current", new Highlight(...current.ranges));
  }
  const firstRange = current.ranges[0];
  if (firstRange) {
    firstRange.startContainer.parentElement?.scrollIntoView({ block: "center", behavior: "smooth" });
    if (!css?.highlights || !Highlight) {
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(firstRange);
    }
  }
  return { index: index + 1, total: matches.length };
}
