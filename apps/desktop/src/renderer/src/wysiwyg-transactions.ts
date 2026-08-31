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

export interface MarkdownBlockSelectionFragment {
  range: WysiwygSourceRange;
  source: string;
  selectionFrom: number;
  selectionTo: number;
}

export type MarkdownSelectionMark = "bold" | "italic" | "strike";

function isValidBlockSelectionFragment(fragment: MarkdownBlockSelectionFragment, textLength: number): boolean {
  return isValidSourceRange(fragment.range, textLength)
    && Number.isInteger(fragment.selectionFrom)
    && Number.isInteger(fragment.selectionTo)
    && fragment.selectionFrom >= 0
    && fragment.selectionTo >= fragment.selectionFrom
    && fragment.selectionTo <= fragment.source.length;
}

export function normalizeCrossBlockPlainText(value: string): string {
  const normalized = value.replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "");
  if (!normalized) return "";
  return normalized.split(/\n+/).map((line) => escapeMarkdownText(line)
    .replace(/^(\s*)([#>+-])(?=\s)/, "$1\\$2")
    .replace(/^(\s*\d+)([.)])(?=\s)/, "$1\\$2")).join("\n\n");
}

export function createCrossBlockReplacement(
  text: string,
  first: MarkdownBlockSelectionFragment,
  last: MarkdownBlockSelectionFragment,
  insert: string,
): WysiwygTextChange | null {
  if (!isValidBlockSelectionFragment(first, text.length)
    || !isValidBlockSelectionFragment(last, text.length)
    || first.range.from > last.range.from
    || first.range.to > last.range.to) return null;
  return {
    from: first.range.from,
    to: last.range.to,
    insert: first.source.slice(0, first.selectionFrom) + insert + last.source.slice(last.selectionTo),
    expectedText: text,
  };
}

export function createCrossBlockFormatChange(
  text: string,
  fragments: readonly MarkdownBlockSelectionFragment[],
  mark: MarkdownSelectionMark,
): WysiwygTextChange | null {
  if (fragments.length < 2) return null;
  const marker = mark === "bold" ? "**" : mark === "italic" ? "*" : "~~";
  let previousTo = -1;
  for (const fragment of fragments) {
    if (!isValidBlockSelectionFragment(fragment, text.length)
      || fragment.range.from < previousTo
      || fragment.selectionFrom === fragment.selectionTo) return null;
    previousTo = fragment.range.to;
  }
  const from = fragments[0]!.range.from;
  const to = fragments[fragments.length - 1]!.range.to;
  const parts: string[] = [];
  let cursor = from;
  for (const fragment of fragments) {
    parts.push(text.slice(cursor, fragment.range.from));
    parts.push(fragment.source.slice(0, fragment.selectionFrom));
    parts.push(marker, fragment.source.slice(fragment.selectionFrom, fragment.selectionTo), marker);
    parts.push(fragment.source.slice(fragment.selectionTo));
    cursor = fragment.range.to;
  }
  parts.push(text.slice(cursor, to));
  return { from, to, insert: parts.join(""), expectedText: text };
}

export function sourceRangeFromElement(element: Element | null, textLength: number, allowEmpty = false): WysiwygSourceRange | null {
  if (!(element instanceof HTMLElement)) return null;
  const from = Number(element.dataset.sourceFrom);
  const to = Number(element.dataset.sourceTo);
  const range = { from, to };
  return isValidSourceRange(range, textLength) && (allowEmpty || to > from) ? range : null;
}

export function preserveTrailingLineBreaks(originalSource: string, replacement: string): string {
  const trailing = /\n+$/.exec(originalSource)?.[0] ?? "";
  return replacement.replace(/\n+$/g, "") + trailing;
}

export function createMarkdownBlockInsertion(text: string, position: number, block: string): string {
  if (!Number.isInteger(position) || position < 0 || position > text.length) return "";
  const cleanBlock = block.replace(/^\n+|\n+$/g, "");
  if (!cleanBlock) return "";
  const before = text.slice(0, position);
  const after = text.slice(position);
  const prefix = before.length === 0 || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const suffix = after.length === 0 || after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
  return `${prefix}${cleanBlock}${suffix}`;
}

export type MarkdownBlockPreset = "paragraph" | "heading" | "bullet-list" | "quote" | "code" | "formula" | "mermaid" | "table" | "image";

export function markdownBlockPreset(kind: MarkdownBlockPreset): string {
  return {
    paragraph: "新段落",
    heading: "## 新标题",
    "bullet-list": "- 新列表项",
    quote: "> 新引用",
    code: "```text\n\n```",
    formula: "$$\n\n$$",
    mermaid: "```mermaid\ngraph TD\n  A --> B\n```",
    table: "| 列 1 | 列 2 |\n| --- | --- |\n|  |  |",
    image: "![图片说明](assets/image.png)",
  }[kind];
}

export function markdownBlockDuplicateInsertion(source: string): string {
  const separator = source.endsWith("\n\n") ? "" : source.endsWith("\n") ? "\n" : "\n\n";
  return separator + source;
}
export function createMarkdownBlockMove(
  text: string,
  moving: WysiwygSourceRange,
  target: WysiwygSourceRange,
  position: "before" | "after",
): WysiwygTextChange | null {
  if (!isValidSourceRange(moving, text.length) || !isValidSourceRange(target, text.length)
    || moving.from === target.from && moving.to === target.to
    || moving.from < target.to && target.from < moving.to) return null;
  const movingSource = text.slice(moving.from, moving.to);
  const targetSource = text.slice(target.from, target.to);
  if (moving.to <= target.from) {
    const between = text.slice(moving.to, target.from);
    const insert = position === "before"
      ? `${between}${movingSource}${targetSource}`
      : `${between}${targetSource}${movingSource}`;
    return { from: moving.from, to: target.to, insert, expectedText: text };
  }
  const between = text.slice(target.to, moving.from);
  const insert = position === "before"
    ? `${movingSource}${targetSource}${between}`
    : `${targetSource}${movingSource}${between}`;
  return { from: target.from, to: moving.to, insert, expectedText: text };
}
export function mergeMarkdownBlocks(left: string, right: string): string {
  const trailing = /\n+$/.exec(right)?.[0] ?? "";
  return left.replace(/\n+$/g, "") + right.replace(/^\n+|\n+$/g, "") + trailing;
}


export function replacePrefixedMarkdownContent(
  originalSource: string,
  content: string,
  kind: "list-item" | "blockquote",
  checked?: boolean,
): string {
  const trailing = /\n+$/.exec(originalSource)?.[0] ?? "";
  const source = originalSource.replace(/\n+$/g, "");
  const match = kind === "list-item"
    ? /^(\s*(?:[-+*]|\d+[.)])\s+)(?:\[([ xX])\]\s+)?/.exec(source)
    : /^(\s*(?:>\s*)+)/.exec(source);
  if (!match) return originalSource;
  const basePrefix = match[1]!;
  const taskPrefix = kind === "list-item" && match[2] !== undefined ? `[${checked ? "x" : " "}] ` : "";
  const parts = content.replace(/^\s+|\s+$/g, "").split(/\n{2,}/).filter(Boolean);
  if (parts.length === 0) return trailing;
  const ordered = /^(\s*)(\d+)([.)]\s+)$/.exec(basePrefix);
  const lines = parts.map((part, index) => {
    let prefix = basePrefix;
    if (ordered && index > 0) prefix = `${ordered[1]}${Number(ordered[2]) + index}${ordered[3]}`;
    const continuation = kind === "blockquote" ? prefix : " ".repeat(prefix.length + taskPrefix.length);
    return `${prefix}${taskPrefix}${part.replace(/\n+/g, `  \n${continuation}`)}`;
  });
  return lines.join("\n") + trailing;
}

export function mergeListItems(left: string, right: string): string {
  const trailing = /\n+$/.exec(right)?.[0] ?? "";
  const rightContent = right.replace(/\n+$/g, "").replace(/^\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "");
  return left.replace(/\n+$/g, "") + rightContent + trailing;
}

export function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/\n+/g, " ").replace(/(^|[^\\])\|/g, "$1\\|");
}
export function shiftMarkdownListItemIndent(
  source: string,
  direction: "indent" | "outdent",
  indentSize = 2,
): string | null {
  if (!Number.isInteger(indentSize) || indentSize < 1 || indentSize > 8) return null;
  const lines = source.split("\n");
  if (direction === "indent") {
    const prefix = " ".repeat(indentSize);
    return lines.map((line) => line.length > 0 ? prefix + line : line).join("\n");
  }
  const first = lines[0] ?? "";
  if (first.startsWith("\t")) {
    return lines.map((line) => line.startsWith("\t") ? line.slice(1) : line).join("\n");
  }
  let available = 0;
  while (available < first.length && first[available] === " ") available += 1;
  if (available === 0) return null;
  const remove = Math.min(indentSize, available);
  return lines.map((line) => {
    let count = 0;
    while (count < remove && line[count] === " ") count += 1;
    return line.slice(count);
  }).join("\n");
}
export interface MarkdownListItemDetails {
  indent: string;
  marker: string;
  ordered: boolean;
  task: boolean;
  checked: boolean;
  content: string;
}

export function markdownListItemDetails(source: string): MarkdownListItemDetails | null {
  const firstLine = source.split("\n", 1)[0] ?? "";
  const match = /^(\s*)((?:[-+*]|\d+[.)]))\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(firstLine);
  if (!match) return null;
  return {
    indent: match[1] ?? "",
    marker: match[2]!,
    ordered: /^\d/.test(match[2]!),
    task: match[3] !== undefined,
    checked: /[xX]/.test(match[3] ?? ""),
    content: match[4] ?? "",
  };
}

export function replaceMarkdownListItemOwnContent(
  source: string,
  content: string,
  checked?: boolean,
): string | null {
  const lineEnd = source.indexOf("\n");
  const firstLine = lineEnd < 0 ? source : source.slice(0, lineEnd);
  const remainder = lineEnd < 0 ? "" : source.slice(lineEnd);
  const match = /^(\s*(?:[-+*]|\d+[.)])\s+)(?:\[([ xX])\]\s+)?(.*)$/.exec(firstLine);
  if (!match || /[\r\n]/.test(content)) return null;
  const taskChecked = checked ?? /[xX]/.test(match[2] ?? "");
  const task = match[2] === undefined ? "" : `[${taskChecked ? "x" : " "}] `;
  return `${match[1]}${task}${content.trim()}${remainder}`;
}

export function exitMarkdownListItemLevel(source: string): string | null {
  const details = markdownListItemDetails(source);
  if (!details || details.content.trim()) return null;
  if (details.indent) return shiftMarkdownListItemIndent(source, "outdent");
  const lineEnd = source.indexOf("\n");
  if (lineEnd < 0) return "";
  const remainder = source.slice(lineEnd + 1);
  if (!remainder) return "\n";
  const promoted = shiftMarkdownListItemIndent(remainder, "outdent") ?? remainder;
  return `\n${promoted}`;
}
export function createMarkdownListSibling(source: string): string | null {
  const details = markdownListItemDetails(source);
  if (!details) return null;
  const marker = details.ordered
    ? details.marker.replace(/^\d+/, (value) => String(Number(value) + 1))
    : details.marker;
  return `${details.indent}${marker} ${details.task ? "[ ] " : ""}`;
}

export function swapMarkdownListSubtrees(left: string, right: string): string {
  return right + left;
}
export interface MarkdownFormulaDetails {
  latex: string;
  displayMode: boolean;
  delimiter: "$" | "$$" | "\\(" | "\\[";
}

interface MarkdownFormulaParts extends MarkdownFormulaDetails {
  opening: string;
  leading: string;
  trailing: string;
  closing: string;
}

function markdownFormulaParts(source: string): MarkdownFormulaParts | null {
  const patterns: ReadonlyArray<{
    pattern: RegExp;
    displayMode: boolean;
    delimiter: MarkdownFormulaDetails["delimiter"];
  }> = [
    { pattern: /^(\s*\$\$)([\s\S]*?)(\$\$\s*)$/, displayMode: true, delimiter: "$$" },
    { pattern: /^(\s*\\\[)([\s\S]*?)(\\\]\s*)$/, displayMode: true, delimiter: "\\[" },
    { pattern: /^(\$)([^$\n]*?)(\$)$/, displayMode: false, delimiter: "$" },
    { pattern: /^(\\\()([^\n]*?)(\\\))$/, displayMode: false, delimiter: "\\(" },
  ];
  for (const candidate of patterns) {
    const match = candidate.pattern.exec(source);
    if (!match) continue;
    const body = match[2] ?? "";
    const leading = /^\s*/.exec(body)?.[0] ?? "";
    const trailing = /\s*$/.exec(body)?.[0] ?? "";
    const contentEnd = Math.max(leading.length, body.length - trailing.length);
    return {
      opening: match[1]!,
      leading,
      latex: body.slice(leading.length, contentEnd),
      trailing,
      closing: match[3]!,
      displayMode: candidate.displayMode,
      delimiter: candidate.delimiter,
    };
  }
  return null;
}

export function markdownFormulaDetails(source: string): MarkdownFormulaDetails | null {
  const parts = markdownFormulaParts(source);
  return parts ? { latex: parts.latex, displayMode: parts.displayMode, delimiter: parts.delimiter } : null;
}

export function replaceMarkdownFormulaLatex(source: string, latex: string): string | null {
  const parts = markdownFormulaParts(source);
  if (!parts || /\r/.test(latex)) return null;
  if ((parts.delimiter === "$$" && latex.includes("$$"))
    || (parts.delimiter === "$" && latex.includes("$"))
    || (parts.delimiter === "\\[" && latex.includes("\\]"))
    || (parts.delimiter === "\\(" && latex.includes("\\)"))) return null;
  return parts.opening + parts.leading + latex + parts.trailing + parts.closing;
}

export interface MarkdownFenceDetails {
  content: string;
  language: string;
  meta: string;
  fence: string;
}

interface MarkdownFenceParts extends MarkdownFenceDetails {
  indent: string;
  rawInfo: string;
  trailing: string;
}

function markdownFenceParts(source: string): MarkdownFenceParts | null {
  const opener = /^([ \t]*)(`{3,}|~{3,})([^\n]*)\n/.exec(source);
  if (!opener) return null;
  const indent = opener[1] ?? "";
  const fence = opener[2]!;
  const rest = source.slice(opener[0].length);
  const closingPattern = new RegExp(`(?:^|\\n)${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*(\\n*)$`);
  const closing = closingPattern.exec(rest);
  if (!closing) return null;
  const closingLineStart = closing.index + (closing[0].startsWith("\n") ? 1 : 0);
  let content = rest.slice(0, closingLineStart);
  if (content.endsWith("\n")) content = content.slice(0, -1);
  const rawInfo = opener[3] ?? "";
  const info = rawInfo.trim();
  const [language = "", ...metaParts] = info.split(/\s+/).filter(Boolean);
  return {
    indent,
    fence,
    rawInfo,
    language,
    meta: metaParts.join(" "),
    content,
    trailing: closing[1] ?? "",
  };
}

export function markdownFenceDetails(source: string): MarkdownFenceDetails | null {
  const parts = markdownFenceParts(source);
  return parts ? { content: parts.content, language: parts.language, meta: parts.meta, fence: parts.fence } : null;
}

export function replaceMarkdownFence(
  source: string,
  update: { content?: string; language?: string },
): string | null {
  const parts = markdownFenceParts(source);
  if (!parts) return null;
  const content = (update.content ?? parts.content).replace(/\r\n?/g, "\n");
  const language = (update.language ?? parts.language).trim().replace(/\s+/g, "-");
  if (/[\u0000-\u001f\u007f`~]/.test(language)) return null;
  const marker = parts.fence[0]!;
  let requiredLength = parts.fence.length;
  const collision = new RegExp(`^${marker === "`" ? "`" : "~"}+(?=\\s*$)`, "gm");
  for (const match of content.matchAll(collision)) requiredLength = Math.max(requiredLength, match[0].length + 1);
  const safeFence = marker.repeat(requiredLength);
  const rawInfo = update.language === undefined
    ? parts.rawInfo
    : language
      ? ` ${language}${parts.meta ? ` ${parts.meta}` : ""}`
      : "";
  const body = content.length > 0 ? `${content}\n` : "";
  return `${parts.indent}${safeFence}${rawInfo}\n${body}${parts.indent}${safeFence}${parts.trailing}`;
}
export type MarkdownTableAlignment = "left" | "center" | "right" | null;

export interface MarkdownTableDetails {
  rows: string[][];
  alignments: MarkdownTableAlignment[];
  columnCount: number;
}

export type MarkdownTableOperation =
  | { kind: "insert-row"; rowIndex: number; position: "before" | "after" }
  | { kind: "delete-row"; rowIndex: number }
  | { kind: "insert-column"; columnIndex: number; position: "before" | "after" }
  | { kind: "delete-column"; columnIndex: number }
  | { kind: "set-alignment"; columnIndex: number; alignment: MarkdownTableAlignment };

interface MarkdownTableParts extends MarkdownTableDetails {
  indent: string;
  leadingPipe: boolean;
  trailingPipe: boolean;
  separatorWidths: number[];
  trailing: string;
}

function splitMarkdownTableLine(line: string): { cells: string[]; leadingPipe: boolean; trailingPipe: boolean; indent: string } | null {
  const indent = /^[ \t]*/.exec(line)?.[0] ?? "";
  const body = line.slice(indent.length).replace(/[ \t]+$/g, "");
  if (!body) return null;
  const parts: string[] = [];
  let start = 0;
  let codeFenceLength = 0;
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === "`") {
      let run = 1;
      while (body[index + run] === "`") run += 1;
      if (codeFenceLength === 0) codeFenceLength = run;
      else if (run === codeFenceLength) codeFenceLength = 0;
      index += run - 1;
      continue;
    }
    if (body[index] !== "|" || codeFenceLength !== 0) continue;
    let slashes = 0;
    for (let before = index - 1; before >= 0 && body[before] === "\\"; before -= 1) slashes += 1;
    if (slashes % 2 === 1) continue;
    parts.push(body.slice(start, index));
    start = index + 1;
  }
  parts.push(body.slice(start));
  const leadingPipe = body.startsWith("|");
  const trailingPipe = body.endsWith("|") && !body.endsWith("\\|");
  if (leadingPipe) parts.shift();
  if (trailingPipe) parts.pop();
  return { cells: parts.map((cell) => cell.trim()), leadingPipe, trailingPipe, indent };
}

function markdownTableParts(source: string): MarkdownTableParts | null {
  if (/\r/.test(source)) return null;
  const trailing = /\n+$/.exec(source)?.[0] ?? "";
  const lines = source.replace(/\n+$/g, "").split("\n");
  if (lines.length < 2) return null;
  const parsed = lines.map(splitMarkdownTableLine);
  if (parsed.some((line) => !line)) return null;
  const rows = parsed as Array<NonNullable<ReturnType<typeof splitMarkdownTableLine>>>;
  const columnCount = rows[0]!.cells.length;
  if (columnCount < 1 || rows.some((row) => row.cells.length !== columnCount)) return null;
  const alignments: MarkdownTableAlignment[] = [];
  const separatorWidths: number[] = [];
  for (const cell of rows[1]!.cells) {
    const match = /^(:)?(-{3,})(:)?$/.exec(cell);
    if (!match) return null;
    alignments.push(match[1] && match[3] ? "center" : match[3] ? "right" : match[1] ? "left" : null);
    separatorWidths.push(match[2]!.length);
  }
  const first = rows[0]!;
  return {
    rows: [first.cells, ...rows.slice(2).map((row) => row.cells)],
    alignments,
    columnCount,
    indent: first.indent,
    leadingPipe: first.leadingPipe,
    trailingPipe: first.trailingPipe,
    separatorWidths,
    trailing,
  };
}

export function markdownTableDetails(source: string): MarkdownTableDetails | null {
  const parts = markdownTableParts(source);
  return parts ? { rows: parts.rows.map((row) => [...row]), alignments: [...parts.alignments], columnCount: parts.columnCount } : null;
}

function formatMarkdownTableRow(parts: MarkdownTableParts, cells: readonly string[]): string {
  const content = cells.join(" | ");
  return `${parts.indent}${parts.leadingPipe ? "| " : ""}${content}${parts.trailingPipe ? " |" : ""}`;
}

export function transformMarkdownTable(source: string, operation: MarkdownTableOperation): string | null {
  const parts = markdownTableParts(source);
  if (!parts) return null;
  const rows = parts.rows.map((row) => [...row]);
  const alignments = [...parts.alignments];
  const widths = [...parts.separatorWidths];
  if (operation.kind === "insert-row") {
    if (!Number.isInteger(operation.rowIndex) || operation.rowIndex < 0 || operation.rowIndex >= rows.length) return null;
    const index = operation.rowIndex === 0 ? 1 : operation.rowIndex + (operation.position === "after" ? 1 : 0);
    rows.splice(index, 0, Array(parts.columnCount).fill(""));
  } else if (operation.kind === "delete-row") {
    if (!Number.isInteger(operation.rowIndex) || operation.rowIndex <= 0 || operation.rowIndex >= rows.length) return null;
    rows.splice(operation.rowIndex, 1);
  } else if (operation.kind === "insert-column") {
    if (!Number.isInteger(operation.columnIndex) || operation.columnIndex < 0 || operation.columnIndex >= parts.columnCount) return null;
    const index = operation.columnIndex + (operation.position === "after" ? 1 : 0);
    for (const row of rows) row.splice(index, 0, "");
    alignments.splice(index, 0, null);
    widths.splice(index, 0, 3);
  } else if (operation.kind === "delete-column") {
    if (!Number.isInteger(operation.columnIndex) || operation.columnIndex < 0 || operation.columnIndex >= parts.columnCount || parts.columnCount <= 1) return null;
    for (const row of rows) row.splice(operation.columnIndex, 1);
    alignments.splice(operation.columnIndex, 1);
    widths.splice(operation.columnIndex, 1);
  } else {
    if (!Number.isInteger(operation.columnIndex) || operation.columnIndex < 0 || operation.columnIndex >= parts.columnCount) return null;
    alignments[operation.columnIndex] = operation.alignment;
  }
  const separator = alignments.map((alignment, index) => {
    const width = Math.max(3, widths[index] ?? 3);
    if (alignment === "center") return `:${"-".repeat(width)}:`;
    if (alignment === "left") return `:${"-".repeat(width)}`;
    if (alignment === "right") return `${"-".repeat(width)}:`;
    return "-".repeat(width);
  });
  const lines = [formatMarkdownTableRow(parts, rows[0]!), formatMarkdownTableRow(parts, separator), ...rows.slice(1).map((row) => formatMarkdownTableRow(parts, row))];
  return lines.join("\n") + parts.trailing;
}

export interface MarkdownInlineCodeDetails {
  content: string;
  fence: string;
}

interface MarkdownInlineCodeParts extends MarkdownInlineCodeDetails {
  padded: boolean;
}

function markdownInlineCodeParts(source: string): MarkdownInlineCodeParts | null {
  const opening = /^`+/.exec(source)?.[0];
  const closing = /`+$/.exec(source)?.[0];
  if (!opening || !closing || opening.length !== closing.length || opening.length + closing.length > source.length) return null;
  const body = source.slice(opening.length, source.length - closing.length);
  const padded = body.length >= 2 && body.startsWith(" ") && body.endsWith(" ") && /[^ ]/.test(body);
  return { content: padded ? body.slice(1, -1) : body, fence: opening, padded };
}

export function markdownInlineCodeDetails(source: string): MarkdownInlineCodeDetails | null {
  const parts = markdownInlineCodeParts(source);
  return parts ? { content: parts.content, fence: parts.fence } : null;
}

export function replaceMarkdownInlineCode(source: string, content: string): string | null {
  const parts = markdownInlineCodeParts(source);
  if (!parts || /[\r\n]/.test(content)) return null;
  if (content === parts.content) return source;
  let longestRun = 0;
  for (const match of content.matchAll(/`+/g)) longestRun = Math.max(longestRun, match[0].length);
  const fence = "`".repeat(Math.max(parts.fence.length, longestRun + 1));
  const padded = parts.padded || content.startsWith("`") || content.endsWith("`") || content.startsWith(" ") || content.endsWith(" ");
  const padding = padded && content.length > 0 ? " " : "";
  return `${fence}${padding}${content}${padding}${fence}`;
}

export interface MarkdownInlineLinkDetails {
  label: string;
  destination: string;
  title: string | null;
}

interface MarkdownInlineLinkParts extends MarkdownInlineLinkDetails {
  labelRaw: string;
  leading: string;
  destinationRaw: string;
  angleDestination: boolean;
  titleSegment: string;
  titlePrefix: string;
  titleOpen: '"' | "'" | "(";
  titleClose: '"' | "'" | ")";
  trailing: string;
}

function markdownInlineLinkParts(source: string): MarkdownInlineLinkParts | null {
  if (!source.startsWith("[") || source.startsWith("![") || !source.endsWith(")")) return null;
  let labelEnd = -1;
  for (let index = 1; index < source.length; index += 1) {
    if (source[index] !== "]") continue;
    let slashes = 0;
    for (let before = index - 1; before >= 0 && source[before] === "\\"; before -= 1) slashes += 1;
    if (slashes % 2 === 0) { labelEnd = index; break; }
  }
  if (labelEnd < 1 || source[labelEnd + 1] !== "(") return null;
  const labelRaw = source.slice(1, labelEnd);
  const inner = source.slice(labelEnd + 2, -1);
  const leading = /^\s*/.exec(inner)?.[0] ?? "";
  const trailing = /\s*$/.exec(inner)?.[0] ?? "";
  const bodyEnd = Math.max(leading.length, inner.length - trailing.length);
  const body = inner.slice(leading.length, bodyEnd);
  let destinationRaw = "";
  let rest = "";
  let angleDestination = false;
  if (body.startsWith("<")) {
    let end = -1;
    for (let index = 1; index < body.length; index += 1) {
      if (body[index] === ">" && body[index - 1] !== "\\") { end = index; break; }
    }
    if (end < 0) return null;
    destinationRaw = body.slice(0, end + 1);
    rest = body.slice(end + 1);
    angleDestination = true;
  } else {
    let index = 0;
    let depth = 0;
    for (; index < body.length; index += 1) {
      const character = body[index]!;
      if (/\s/.test(character) && depth === 0) break;
      if (character === "\\") { index += 1; continue; }
      if (character === "(") depth += 1;
      else if (character === ")" && depth > 0) depth -= 1;
    }
    destinationRaw = body.slice(0, index);
    rest = body.slice(index);
  }
  let title: string | null = null;
  let titleSegment = rest;
  let titlePrefix = " ";
  let titleOpen: MarkdownInlineLinkParts["titleOpen"] = '"';
  let titleClose: MarkdownInlineLinkParts["titleClose"] = '"';
  if (rest) {
    const quoted = /^(\s+)(["'])([\s\S]*)\2$/.exec(rest);
    const parenthesized = /^(\s+)\(([\s\S]*)\)$/.exec(rest);
    if (quoted) {
      titlePrefix = quoted[1]!;
      titleOpen = quoted[2] as '"' | "'";
      titleClose = titleOpen;
      title = quoted[3]!.replace(/\\(.)/g, "$1");
    } else if (parenthesized) {
      titlePrefix = parenthesized[1]!;
      titleOpen = "(";
      titleClose = ")";
      title = parenthesized[2]!.replace(/\\(.)/g, "$1");
    } else return null;
  }
  const destinationToken = angleDestination ? destinationRaw.slice(1, -1) : destinationRaw;
  return {
    label: labelRaw.replace(/\\(.)/g, "$1"),
    destination: destinationToken.replace(/\\(.)/g, "$1"),
    title,
    labelRaw,
    leading,
    destinationRaw,
    angleDestination,
    titleSegment,
    titlePrefix,
    titleOpen,
    titleClose,
    trailing,
  };
}

export function markdownInlineLinkDetails(source: string): MarkdownInlineLinkDetails | null {
  const parts = markdownInlineLinkParts(source);
  return parts ? { label: parts.label, destination: parts.destination, title: parts.title } : null;
}

export function replaceMarkdownInlineLink(
  source: string,
  update: { label?: string; destination?: string; title?: string | null },
): string | null {
  const parts = markdownInlineLinkParts(source);
  if (!parts) return null;
  const labelRaw = update.label === undefined ? parts.labelRaw : escapeMarkdownText(update.label.replace(/[\r\n]+/g, " "));
  let destinationRaw = parts.destinationRaw;
  if (update.destination !== undefined) {
    const destination = update.destination.trim();
    if (/[\u0000-\u001f\u007f]/.test(destination)) return null;
    const angle = parts.angleDestination || /\s|[<>]/.test(destination);
    const escaped = destination.replaceAll("\\", "\\\\").replace(angle ? />/g : /[()]/g, "\\$&");
    destinationRaw = angle ? `<${escaped}>` : escaped;
  }
  let titleSegment = parts.titleSegment;
  if (update.title !== undefined) {
    const title = update.title?.replace(/[\r\n]+/g, " ") ?? "";
    if (!title) titleSegment = "";
    else {
      if (!destinationRaw) return null;
      const escaped = title.replaceAll("\\", "\\\\").replaceAll(parts.titleClose, `\\${parts.titleClose}`);
      titleSegment = `${parts.titlePrefix}${parts.titleOpen}${escaped}${parts.titleClose}`;
    }
  }
  return `[${labelRaw}](${parts.leading}${destinationRaw}${titleSegment}${parts.trailing})`;
}

export function markdownImageAlt(source: string): string | null {
  if (source.startsWith("![[")) return null;
  const match = /^!\[((?:\\.|[^\]\\])*)\]/.exec(source);
  return match ? match[1]!.replace(/\\([\\\]])/g, "$1") : null;
}

export function replaceMarkdownImageAlt(source: string, alt: string): string | null {
  if (source.startsWith("![[")) return null;
  const match = /^!\[((?:\\.|[^\]\\])*)\]/.exec(source);
  if (!match) return null;
  const escaped = alt.replace(/\r\n?/g, "\n").replace(/\n+/g, " ").trim().replace(/([\\\]])/g, "\\$1");
  return "![" + escaped + "]" + source.slice(match[0].length);
}
export function escapeMarkdownText(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replace(/([\[\]*_~`])/g, "\\$1");
}
