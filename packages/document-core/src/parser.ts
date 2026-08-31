import MarkdownIt, { type Token } from "markdown-it";
import { katex } from "@mdit/plugin-katex";
import { tasklist } from "@mdit/plugin-tasklist";
import { sha256 } from "./hash.js";
import {
  PARSER_PROFILE,
  UDM_VERSION,
  type Diagnostic,
  type DocumentNode,
  type NodeType,
  type ParseDocumentInput,
  type ParsedDocument,
  type ResourceReference,
  type ResourceSyntax,
  type SourceRange,
} from "./model.js";
import { createResourceReference } from "./resources.js";
import { canonicalizeEditorText, createLineStarts, createSourceLocator } from "./text.js";

type MarkdownToken = Token;

function createMarkdownEngine() {
  return new MarkdownIt({
    html: false,
    breaks: false,
    linkify: false,
    typographer: false,
  }).use(tasklist).use(katex);
}

const markdown = createMarkdownEngine();
const previewMarkdown = createMarkdownEngine();

interface PreviewEnvironment extends Record<string, unknown> {
  [key: symbol]: unknown;
  markdownReferences: ResourceReference[];
  wikiReferences: ResourceReference[];
  markdownIndex: number;
  wikiIndex: number;
  inlineFormulas: RawFormulaMatch[];
  blockFormulas: RawFormulaMatch[];
  inlineFormulaIndex: number;
  blockFormulaIndex: number;
  inlineCodes: RawInlineRange[];
  inlineLinks: RawInlineRange[];
  inlineCodeIndex: number;
  inlineLinkIndex: number;
}

const PREVIEW_SOURCE_TOKEN_KIND: Readonly<Record<string, string>> = {
  heading_open: "heading",
  paragraph_open: "paragraph",
  blockquote_open: "blockquote",
  list_item_open: "list-item",
  table_open: "table",
  fence: "code-block",
  code_block: "code-block",
  hr: "thematic-break",
  math_block: "formula-block",
};

interface PreviewCellRange {
  from: number;
  to: number;
}

function tableCellRanges(line: string, lineStart: number): PreviewCellRange[] {
  const pipes: number[] = [];
  let codeFenceLength = 0;
  for (let index = 0; index < line.length;) {
    if (line[index] === "`") {
      let run = 1;
      while (line[index + run] === "`") run += 1;
      if (codeFenceLength === 0) codeFenceLength = run;
      else if (run === codeFenceLength) codeFenceLength = 0;
      index += run;
      continue;
    }
    if (line[index] === "|" && codeFenceLength === 0) {
      let backslashes = 0;
      for (let before = index - 1; before >= 0 && line[before] === "\\"; before -= 1) backslashes += 1;
      if (backslashes % 2 === 0) pipes.push(index);
    }
    index += 1;
  }
  const firstContent = line.search(/\S/);
  if (firstContent < 0) return [];
  const lastContent = line.search(/\s*$/) - 1;
  const boundaries = [-1, ...pipes, line.length];
  const ranges: PreviewCellRange[] = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    let from = boundaries[index]! + 1;
    let to = boundaries[index + 1]!;
    if ((index === 0 && pipes[0] === firstContent) || (index === boundaries.length - 2 && pipes.at(-1) === lastContent)) continue;
    while (from < to && /\s/.test(line[from]!)) from += 1;
    while (to > from && /\s/.test(line[to - 1]!)) to -= 1;
    ranges.push({ from: lineStart + from, to: lineStart + to });
  }
  return ranges;
}

function annotatePreviewSourceRanges(tokens: MarkdownToken[], editorText: string): void {
  const lineStarts = createLineStarts(editorText);
  let currentCells: PreviewCellRange[] = [];
  let currentCellIndex = 0;
  for (const token of tokens) {
    if (token.type === "tr_open" && token.map) {
      const rowStart = lineStarts[token.map[0]] ?? 0;
      const nextLineStart = lineStarts[token.map[0] + 1] ?? editorText.length;
      const rowEnd = nextLineStart > rowStart && editorText[nextLineStart - 1] === "\n" ? nextLineStart - 1 : nextLineStart;
      currentCells = tableCellRanges(editorText.slice(rowStart, rowEnd), rowStart);
      currentCellIndex = 0;
    }
    if (token.type === "th_open" || token.type === "td_open") {
      const range = currentCells[currentCellIndex++];
      if (range) {
        token.attrSet("data-source-from", String(range.from));
        token.attrSet("data-source-to", String(range.to));
        token.attrSet("data-source-kind", "table-cell");
      }
    }
    if (token.type === "tr_close") currentCells = [];
    const kind = PREVIEW_SOURCE_TOKEN_KIND[token.type];
    if (!kind || !token.map || token.hidden) continue;
    const from = lineStarts[token.map[0]] ?? 0;
    const to = lineStarts[token.map[1]] ?? editorText.length;
    if (to <= from) continue;
    token.attrSet("data-source-from", String(from));
    token.attrSet("data-source-to", String(to));
    token.attrSet("data-source-kind", kind);
    token.attrSet("data-source-block", "true");
  }
}

function resourcePlaceholder(altText: string, reference: ResourceReference | undefined): string {
  const alt = previewMarkdown.utils.escapeHtml(altText || "未命名图片");
  const identity = reference && /^[a-f\d]{64}$/i.test(reference.referenceKey)
    ? ` data-reference-key="${reference.referenceKey}" data-alt="${alt}" data-source-from="${reference.source.from}" data-source-to="${reference.source.to}" data-source-kind="image"`
    : "";
  return `<span class="resource-placeholder" role="img"${identity}>[图片：${alt}]</span>`;
}

previewMarkdown.inline.ruler.before("image", "wiki_image", (state, silent) => {
  const match = /^!\[\[([^\]|]+)\]\]/i.exec(state.src.slice(state.pos));
  if (!match) return false;
  if (!silent) {
    const token = state.push("wiki_image", "", 0);
    token.content = match[1]?.trim() || "未命名图片";
  }
  state.pos += match[0].length;
  return true;
});

previewMarkdown.renderer.rules.image = (tokens, index, _options, environment) => {
  const preview = environment as unknown as PreviewEnvironment;
  const reference = preview.markdownReferences[preview.markdownIndex++];
  return resourcePlaceholder(tokens[index]?.content || "未命名图片", reference);
};

previewMarkdown.renderer.rules.wiki_image = (tokens, index, _options, environment) => {
  const preview = environment as unknown as PreviewEnvironment;
  const reference = preview.wikiReferences[preview.wikiIndex++];
  return resourcePlaceholder(tokens[index]?.content || "未命名图片", reference);
};

function previewFormulaSourceAttributes(formula: RawFormulaMatch | undefined, fallback = ""): string {
  return formula
    ? ` data-source-from="${formula.from}" data-source-to="${formula.to}" data-source-kind="${formula.displayMode ? "formula-block" : "formula-inline"}" data-source-block="true"`
    : fallback;
}

const renderPreviewMathBlock = previewMarkdown.renderer.rules.math_block;
if (renderPreviewMathBlock) {
  previewMarkdown.renderer.rules.math_block = (tokens, index, options, environment, renderer) => {
    const preview = environment as unknown as PreviewEnvironment;
    const formula = preview.blockFormulas[preview.blockFormulaIndex++];
    const token = tokens[index];
    const sourceAttributes = previewFormulaSourceAttributes(formula, token ? renderer.renderAttrs(token) : "");
    return `<div class="preview-formula-block"${sourceAttributes}>${renderPreviewMathBlock(tokens, index, options, environment, renderer)}</div>`;
  };
}

const renderPreviewMathInline = previewMarkdown.renderer.rules.math_inline;
if (renderPreviewMathInline) {
  previewMarkdown.renderer.rules.math_inline = (tokens, index, options, environment, renderer) => {
    const preview = environment as unknown as PreviewEnvironment;
    const formula = preview.inlineFormulas[preview.inlineFormulaIndex++];
    const sourceAttributes = previewFormulaSourceAttributes(formula);
    return `<span class="preview-formula-inline"${sourceAttributes}>${renderPreviewMathInline(tokens, index, options, environment, renderer)}</span>`;
  };
}

function previewInlineSourceAttributes(range: RawInlineRange | undefined, kind: "inline-code" | "inline-link"): string {
  return range ? ` data-source-from="${range.from}" data-source-to="${range.to}" data-source-kind="${kind}"` : "";
}

const renderPreviewCodeInline = previewMarkdown.renderer.rules.code_inline;
if (renderPreviewCodeInline) {
  previewMarkdown.renderer.rules.code_inline = (tokens, index, options, environment, renderer) => {
    const preview = environment as unknown as PreviewEnvironment;
    const sourceAttributes = previewInlineSourceAttributes(preview.inlineCodes[preview.inlineCodeIndex++], "inline-code");
    const rendered = renderPreviewCodeInline(tokens, index, options, environment, renderer);
    return sourceAttributes ? rendered.replace("<code", `<code${sourceAttributes}`) : rendered;
  };
}

previewMarkdown.renderer.rules.link_open = (tokens, index, options, environment, renderer) => {
  const preview = environment as unknown as PreviewEnvironment;
  const sourceAttributes = previewInlineSourceAttributes(preview.inlineLinks[preview.inlineLinkIndex++], "inline-link");
  const token = tokens[index];
  if (token && sourceAttributes) {
    const range = preview.inlineLinks[preview.inlineLinkIndex - 1];
    if (range) {
      token.attrSet("data-source-from", String(range.from));
      token.attrSet("data-source-to", String(range.to));
      token.attrSet("data-source-kind", "inline-link");
    }
  }
  return renderer.renderToken(tokens, index, options);
};

function countPreviewTokenType(tokens: MarkdownToken[], type: string): number {
  let count = 0;
  for (const token of tokens) {
    if (token.type === type) count += 1;
    if (token.children) count += countPreviewTokenType(token.children, type);
  }
  return count;
}

for (const ruleName of ["fence", "code_block"] as const) {
  const renderCodeBlock = previewMarkdown.renderer.rules[ruleName];
  if (!renderCodeBlock) continue;
  previewMarkdown.renderer.rules[ruleName] = (tokens, index, options, environment, renderer) => {
    const token = tokens[index];
    const sourceAttributes = token ? renderer.renderAttrs(token) : "";
    const rendered = renderCodeBlock(tokens, index, options, environment, renderer);
    return sourceAttributes ? rendered.replace("<pre", `<pre${sourceAttributes}`) : rendered;
  };
}


interface RawImageMatch {
  from: number;
  to: number;
  syntax: ResourceSyntax;
  originalRef: string;
  resolvedRef: string;
  alt: string;
  title: string | null;
}

interface RawFormulaMatch {
  from: number;
  to: number;
  latex: string;
  displayMode: boolean;
  delimiter: "$" | "$$" | "\\(" | "\\[";
}

interface RawInlineRange {
  from: number;
  to: number;
}

function createBlockScanText(text: string): string {
  const characters = text.split("");
  const lineStarts = createLineStarts(text);
  const mask = (from: number, to: number) => {
    for (let index = from; index < to; index += 1) if (characters[index] !== "\n") characters[index] = " ";
  };
  for (const token of markdown.parse(text, {})) {
    if ((token.type === "fence" || token.type === "code_block") && token.map) {
      mask(lineStarts[token.map[0]] ?? 0, lineStarts[token.map[1]] ?? text.length);
    }
  }
  return characters.join("");
}

function createSyntaxScanText(text: string): string {
  const characters = createBlockScanText(text).split("");
  const codeSpanPattern = /(`+)[\s\S]*?\1/g;
  for (const match of characters.join("").matchAll(codeSpanPattern)) {
    if (match.index === undefined) continue;
    for (let index = match.index; index < match.index + match[0].length; index += 1) {
      if (characters[index] !== "\n") characters[index] = " ";
    }
  }
  return characters.join("");
}

function scanInlineCodeRanges(text: string): RawInlineRange[] {
  const ranges: RawInlineRange[] = [];
  for (const match of createBlockScanText(text).matchAll(/(`+)[\s\S]*?\1/g)) {
    if (match.index !== undefined && !isEscaped(text, match.index)) ranges.push({ from: match.index, to: match.index + match[0].length });
  }
  return ranges;
}

function scanInlineLinkRanges(text: string): RawInlineRange[] {
  const scanText = createSyntaxScanText(text);
  const ranges: RawInlineRange[] = [];
  const collect = (pattern: RegExp) => {
    for (const match of scanText.matchAll(pattern)) {
      if (match.index === undefined || isEscaped(text, match.index) || text[match.index - 1] === "!") continue;
      const range = { from: match.index, to: match.index + match[0].length };
      if (!ranges.some((item) => range.from < item.to && range.to > item.from)) ranges.push(range);
    }
  };
  collect(/\[(?:\\.|[^\]\\])+\]\(\s*(?:\\.|[^)])*\)/g);
  collect(/\[(?:\\.|[^\]\\])+\]\[(?:\\.|[^\]\\])*\]/g);
  return ranges.sort((left, right) => left.from - right.from);
}

function isEscaped(text: string, offset: number): boolean {
  let slashes = 0;
  for (let index = offset - 1; index >= 0 && text[index] === "\\"; index -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function scanImageReferences(text: string): RawImageMatch[] {
  const scanText = createSyntaxScanText(text);
  const matches: RawImageMatch[] = [];
  const definitions = new Map<string, { target: string; title: string | null }>();
  const definitionPattern = /^\s{0,3}\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))(?:\s+["'(]([^"')]+)["')])?/gim;
  for (const match of scanText.matchAll(definitionPattern)) {
    const label = match[1]?.trim().toLowerCase();
    const target = match[2] ?? match[3];
    if (label && target) definitions.set(label, { target, title: match[4] ?? null });
  }

  const inlinePattern = /!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["']([^"']*)["'])?\s*\)/g;
  for (const match of scanText.matchAll(inlinePattern)) {
    const originalRef = match[2] ?? match[3];
    if (!originalRef || match.index === undefined || isEscaped(text, match.index)) continue;
    matches.push({
      from: match.index,
      to: match.index + match[0].length,
      syntax: "markdown-inline",
      originalRef,
      resolvedRef: originalRef,
      alt: match[1] ?? "",
      title: match[4] ?? null,
    });
  }

  const wikiPattern = /!\[\[([^\]|]+)\]\]/gi;
  for (const match of scanText.matchAll(wikiPattern)) {
    const target = match[1]?.trim();
    if (!target || match.index === undefined || isEscaped(text, match.index)) continue;
    matches.push({
      from: match.index,
      to: match.index + match[0].length,
      syntax: "wiki-image",
      originalRef: target,
      resolvedRef: target,
      alt: "",
      title: null,
    });
  }

  const referencePattern = /!\[([^\]]*)\]\[([^\]]*)\]/g;
  for (const match of scanText.matchAll(referencePattern)) {
    const label = (match[2] || match[1])?.trim().toLowerCase();
    const definition = label ? definitions.get(label) : undefined;
    if (!definition || match.index === undefined || isEscaped(text, match.index)) continue;
    matches.push({
      from: match.index,
      to: match.index + match[0].length,
      syntax: "markdown-reference",
      originalRef: label ?? "",
      resolvedRef: definition.target,
      alt: match[1] ?? "",
      title: definition.title,
    });
  }
  return matches.sort((left, right) => left.from - right.from);
}

function scanFormulas(text: string): RawFormulaMatch[] {
  const characters = createSyntaxScanText(text).split("");
  const matches: RawFormulaMatch[] = [];
  const overlaps = (from: number, to: number) => matches.some((item) => from < item.to && to > item.from);
  const mask = (from: number, to: number) => {
    for (let index = from; index < to; index += 1) if (characters[index] !== "\n") characters[index] = " ";
  };
  const collect = (pattern: RegExp, displayMode: boolean, delimiter: RawFormulaMatch["delimiter"]) => {
    const current = characters.join("");
    for (const match of current.matchAll(pattern)) {
      if (match.index === undefined || isEscaped(text, match.index)) continue;
      const from = match.index;
      const to = from + match[0].length;
      if (overlaps(from, to)) continue;
      matches.push({ from, to, latex: match[1]?.trim() ?? "", displayMode, delimiter });
      mask(from, to);
    }
  };
  collect(/\$\$([\s\S]*?)\$\$/g, true, "$$");
  collect(/\\\[([\s\S]*?)\\\]/g, true, "\\[");
  collect(/\$(?!\$)([^$\n]+?)\$/g, false, "$");
  collect(/\\\(([^\n]*?)\\\)/g, false, "\\(");
  return matches.sort((left, right) => left.from - right.from);
}

function tokenRange(
  token: MarkdownToken,
  text: string,
  lineStarts: number[],
  locate: ReturnType<typeof createSourceLocator>,
  inherited?: SourceRange,
): SourceRange {
  if (token.map) {
    const from = lineStarts[token.map[0]] ?? 0;
    const to = lineStarts[token.map[1]] ?? text.length;
    return locate(from, to);
  }
  return inherited ? { ...inherited, precision: "block" } : locate(0, text.length, "block");
}

function blockType(tokenType: string): NodeType | undefined {
  return {
    heading_open: "heading",
    paragraph_open: "paragraph",
    blockquote_open: "blockquote",
    bullet_list_open: "bulletList",
    ordered_list_open: "orderedList",
    list_item_open: "listItem",
    table_open: "table",
    thead_open: "tableHead",
    tbody_open: "tableBody",
    tr_open: "tableRow",
    th_open: "tableCell",
    td_open: "tableCell",
  }[tokenType] as NodeType | undefined;
}

function inlineType(tokenType: string): NodeType | undefined {
  return {
    em_open: "emphasis",
    strong_open: "strong",
    s_open: "strikethrough",
    link_open: "link",
  }[tokenType] as NodeType | undefined;
}

function findClosingIndex(tokens: MarkdownToken[], start: number): number {
  const type = tokens[start]?.type;
  if (!type?.endsWith("_open")) return start;
  const closeType = type.replace(/_open$/, "_close");
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    if (tokens[index]?.type === type) depth += 1;
    if (tokens[index]?.type === closeType) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return start;
}

function blockAttributes(token: MarkdownToken, tokens: MarkdownToken[], index: number): Record<string, unknown> {
  if (token.type === "heading_open") return { level: Number(token.tag.slice(1)) };
  if (token.type === "bullet_list_open" || token.type === "ordered_list_open") {
    const close = findClosingIndex(tokens, index);
    const tight = tokens.slice(index + 1, close).some((item) => item.type === "paragraph_open" && item.hidden);
    return token.type === "ordered_list_open"
      ? { start: Number(token.attrGet("start") ?? 1), tight }
      : { tight };
  }
  if (token.type === "list_item_open") {
    const close = findClosingIndex(tokens, index);
    const checkbox = tokens.slice(index + 1, close).flatMap((item) => item.children ?? []).find((item) => item.type === "checkbox_input");
    return checkbox ? { checked: checkbox.attrGet("checked") === "checked" } : {};
  }
  if (token.type === "table_open") {
    const close = findClosingIndex(tokens, index);
    const alignments: Array<"left" | "center" | "right" | null> = [];
    for (const item of tokens.slice(index + 1, close)) {
      if (item.type === "th_open") {
        const style = String(item.attrGet("style") ?? "");
        const alignment = /text-align:(left|center|right)/.exec(style)?.[1];
        alignments.push((alignment as "left" | "center" | "right" | undefined) ?? null);
      }
      if (item.type === "thead_close") break;
    }
    return { alignments };
  }
  if (token.type === "th_open") return { header: true, colspan: 1, rowspan: 1 };
  if (token.type === "td_open") return { header: false, colspan: 1, rowspan: 1 };
  return {};
}

function parseInlineNodes(
  token: MarkdownToken,
  parentRange: SourceRange,
  text: string,
  locate: ReturnType<typeof createSourceLocator>,
  nextId: () => string,
): DocumentNode[] {
  const root: DocumentNode[] = [];
  const stack: DocumentNode[] = [];
  let cursor = parentRange.from;
  const append = (node: DocumentNode) => {
    const parent = stack.at(-1);
    if (parent) (parent.children ??= []).push(node);
    else root.push(node);
  };
  const exactTextRange = (value: string): SourceRange => {
    const found = value ? text.indexOf(value, cursor) : -1;
    if (found >= cursor && found + value.length <= parentRange.to) {
      cursor = found + value.length;
      return locate(found, cursor);
    }
    return { ...parentRange, precision: "block" };
  };

  for (const child of token.children ?? []) {
    const containerType = inlineType(child.type);
    if (containerType && child.nesting === 1) {
      const attributes: Record<string, unknown> = {};
      if (containerType === "link") {
        const href = String(child.attrGet("href") ?? "");
        attributes.originalHref = href;
        attributes.normalizedHref = href;
        attributes.title = child.attrGet("title");
        attributes.safetyState = /^(?:https?:|mailto:|#|\/)/i.test(href) ? "allowed" : "blocked";
      }
      const node: DocumentNode = {
        id: nextId(), type: containerType, source: { ...parentRange, precision: "block" }, generated: false, attributes, children: [],
      };
      append(node);
      stack.push(node);
      continue;
    }
    if (child.nesting === -1 && stack.length > 0) {
      stack.pop();
      continue;
    }
    let node: DocumentNode | undefined;
    if (child.type === "text") {
      node = { id: nextId(), type: "text", source: exactTextRange(child.content), generated: false, attributes: { value: child.content } };
    } else if (child.type === "code_inline") {
      node = { id: nextId(), type: "inlineCode", source: { ...parentRange, precision: "block" }, generated: false, attributes: { value: child.content } };
    } else if (child.type === "softbreak") {
      node = { id: nextId(), type: "softBreak", source: { ...parentRange, precision: "block" }, generated: false, attributes: {} };
    } else if (child.type === "hardbreak") {
      node = { id: nextId(), type: "hardBreak", source: { ...parentRange, precision: "block" }, generated: false, attributes: {} };
    } else if (child.type === "html_inline") {
      node = { id: nextId(), type: "rawHtmlInline", source: { ...parentRange, precision: "block" }, generated: false, attributes: { raw: child.content, safetyState: "blocked", safeRepresentation: null } };
    }
    if (node) append(node);
  }
  return root;
}

function buildBlockTree(text: string, nextId: () => string): DocumentNode[] {
  const tokens = markdown.parse(text, {});
  const lineStarts = createLineStarts(text);
  const locate = createSourceLocator(text);
  const root: DocumentNode[] = [];
  const stack: DocumentNode[] = [];
  const append = (node: DocumentNode) => {
    const parent = stack.at(-1);
    if (parent) (parent.children ??= []).push(node);
    else root.push(node);
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const parentRange = stack.at(-1)?.source;
    if (token.type === "inline") {
      const range = tokenRange(token, text, lineStarts, locate, parentRange);
      const nodes = parseInlineNodes(token, range, text, locate, nextId);
      const parent = stack.at(-1);
      if (parent) (parent.children ??= []).push(...nodes);
      else root.push(...nodes);
      continue;
    }
    const mappedType = blockType(token.type);
    if (mappedType && token.nesting === 1) {
      const attributes = blockAttributes(token, tokens, index);
      const type = token.type === "list_item_open" && "checked" in attributes ? "taskItem" : mappedType;
      const node: DocumentNode = {
        id: nextId(),
        type,
        source: tokenRange(token, text, lineStarts, locate, parentRange),
        generated: false,
        attributes,
        children: [],
      };
      append(node);
      stack.push(node);
      continue;
    }
    if (token.nesting === -1 && stack.length > 0) {
      stack.pop();
      continue;
    }
    const range = tokenRange(token, text, lineStarts, locate, parentRange);
    if (token.type === "fence" || token.type === "code_block") {
      const info = token.info.trim();
      const [originalLanguage = "", ...metaParts] = info.split(/\s+/);
      append({
        id: nextId(), type: "codeBlock", source: range, generated: false,
        attributes: {
          value: token.content,
          language: originalLanguage.toLowerCase(),
          originalLanguage,
          meta: metaParts.join(" "),
          fence: token.markup,
        },
      });
    } else if (token.type === "hr") {
      append({ id: nextId(), type: "thematicBreak", source: range, generated: false, attributes: {} });
    } else if (token.type === "html_block") {
      append({ id: nextId(), type: "rawHtmlBlock", source: range, generated: false, attributes: { raw: token.content, safetyState: "blocked", safeRepresentation: null } });
    }
  }
  return root;
}

const BLOCK_INLINE_CONTAINERS = new Set<NodeType>(["paragraph", "heading", "tableCell"]);
const FORMATTING_INLINE_CONTAINERS = new Set<NodeType>(["emphasis", "strong", "strikethrough", "link"]);

function hasExactTextOverlap(nodes: DocumentNode[], inlineNode: DocumentNode): boolean {
  return nodes.some((node) =>
    (node.type === "text"
      && node.source.precision === "exact"
      && node.source.from < inlineNode.source.to
      && node.source.to > inlineNode.source.from)
    || (node.children ? hasExactTextOverlap(node.children, inlineNode) : false),
  );
}

function findInlineChildren(nodes: DocumentNode[], inlineNode: DocumentNode): DocumentNode[] | undefined {
  for (const node of nodes) {
    if (node.source.from > inlineNode.source.from || node.source.to < inlineNode.source.to || !node.children) continue;
    const deeper = findInlineChildren(node.children, inlineNode);
    if (deeper) return deeper;
    if (FORMATTING_INLINE_CONTAINERS.has(node.type) && hasExactTextOverlap(node.children, inlineNode)) return node.children;
    if (BLOCK_INLINE_CONTAINERS.has(node.type)) return node.children;
  }
  return undefined;
}

function insertInlineNode(
  nodes: DocumentNode[],
  inlineNode: DocumentNode,
  editorText: string,
  locate: ReturnType<typeof createSourceLocator>,
  nextId: () => string,
): boolean {
  const children = findInlineChildren(nodes, inlineNode);
  if (!children) return false;
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const node = children[index]!;
    if (
      node.type !== "text"
      || node.source.precision !== "exact"
      || node.source.from >= inlineNode.source.to
      || node.source.to <= inlineNode.source.from
    ) continue;
    const replacements: DocumentNode[] = [];
    const beforeTo = Math.max(node.source.from, Math.min(inlineNode.source.from, node.source.to));
    const afterFrom = Math.min(node.source.to, Math.max(inlineNode.source.to, node.source.from));
    if (beforeTo > node.source.from) {
      replacements.push({
        ...node,
        source: locate(node.source.from, beforeTo),
        attributes: { ...node.attributes, value: editorText.slice(node.source.from, beforeTo) },
      });
    }
    if (afterFrom < node.source.to) {
      replacements.push({
        ...node,
        id: replacements.length === 0 ? node.id : nextId(),
        source: locate(afterFrom, node.source.to),
        attributes: { ...node.attributes, value: editorText.slice(afterFrom, node.source.to) },
      });
    }
    children.splice(index, 1, ...replacements);
  }
  children.push(inlineNode);
  children.sort((left, right) => left.source.from - right.source.from || left.source.to - right.source.to || left.id.localeCompare(right.id));
  return true;
}

function removeRawHtmlPlaceholder(nodes: DocumentNode[], source: SourceRange, text: string): void {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]!;
    if (
      node.type === "paragraph" &&
      node.source.from <= source.from &&
      node.source.to >= source.to &&
      text.slice(node.source.from, node.source.to).trim() === text.slice(source.from, source.to).trim()
    ) {
      nodes.splice(index, 1);
      continue;
    }
    if (node.children) removeRawHtmlPlaceholder(node.children, source, text);
  }
}

function countNodes(nodes: DocumentNode[], type: NodeType): number {
  return nodes.reduce((total, node) => total + (node.type === type ? 1 : 0) + countNodes(node.children ?? [], type), 0);
}

export async function parseDocument(input: ParseDocumentInput): Promise<ParsedDocument> {
  const editorText = canonicalizeEditorText(input.editorText);
  const parserProfile = input.parserProfile ?? PARSER_PROFILE;
  const sourceHash = await sha256(editorText);
  const locate = createSourceLocator(editorText);
  let idSequence = 0;
  const nextId = () => `node-${++idSequence}`;
  const children = buildBlockTree(editorText, nextId);
  const resourceReferences: ResourceReference[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const image of scanImageReferences(editorText)) {
    const nodeId = nextId();
    const source = locate(image.from, image.to);
    const result = await createResourceReference({
      documentId: input.documentId,
      nodeId,
      source,
      syntax: image.syntax,
      originalRef: image.originalRef,
      resolvedRef: image.resolvedRef,
    });
    resourceReferences.push(result.reference);
    const imageNode: DocumentNode = {
      id: nodeId,
      type: "image",
      source,
      generated: false,
      attributes: {
        syntax: image.syntax,
        originalRef: result.reference.originalRef,
        resolvedRef: result.reference.resolvedRef,
        normalizedResolvedRef: result.reference.normalizedResolvedRef,
        alt: image.alt,
        title: image.title,
        referenceKey: result.reference.referenceKey,
        requestedWidth: null,
        requestedHeight: null,
      },
    };
    if (!insertInlineNode(children, imageNode, editorText, locate, nextId)) {
      children.push({
        id: nextId(), type: "paragraph", source, generated: true, attributes: {}, children: [imageNode],
      });
    }
    if (result.diagnostic) diagnostics.push(result.diagnostic);
  }

  for (const formula of scanFormulas(editorText)) {
    const source = locate(formula.from, formula.to);
    const formulaNode: DocumentNode = {
      id: nextId(),
      type: formula.displayMode ? "formulaBlock" : "formulaInline",
      source,
      generated: false,
      attributes: {
        latex: formula.latex,
        displayMode: formula.displayMode,
        delimiter: formula.delimiter,
        accessibleText: null,
      },
    };
    if (formula.displayMode) children.push(formulaNode);
    else if (!insertInlineNode(children, formulaNode, editorText, locate, nextId)) {
      children.push({
        id: nextId(), type: "paragraph", source, generated: true, attributes: {}, children: [formulaNode],
      });
    }
  }

  const rawHtmlImagePattern = /<img\b[^>]*>/gi;
  for (const match of createSyntaxScanText(editorText).matchAll(rawHtmlImagePattern)) {
    if (match.index === undefined) continue;
    const nodeId = nextId();
    const source = locate(match.index, match.index + match[0].length);
    removeRawHtmlPlaceholder(children, source, editorText);
    children.push({
      id: nodeId,
      type: "rawHtmlBlock",
      source,
      generated: false,
      attributes: { raw: "[blocked raw HTML img]", safetyState: "blocked", removedFeatures: ["img"], safeRepresentation: null },
    });
    diagnostics.push({
      id: `diagnostic-${nodeId}-RAW_HTML_IMAGE_BLOCKED`,
      code: "RAW_HTML_IMAGE_BLOCKED",
      severity: "blocking",
      category: "security",
      message: "P0 不支持原始 HTML 图片，请改用 Markdown 图片语法。",
      source,
      nodeId,
      suggestedActions: ["将 img 标签改写为 Markdown 图片语法。"],
    });
  }

  children.sort((left, right) => left.source.from - right.source.from || left.id.localeCompare(right.id));
  return {
    schema: "fantastic-editor-parsed-document",
    udmVersion: UDM_VERSION,
    parserProfile,
    documentId: input.documentId,
    sourceHash,
    sourceLength: editorText.length,
    metadata: {},
    children,
    resourceReferences,
    diagnostics,
    statistics: {
      headings: countNodes(children, "heading"),
      images: resourceReferences.length,
      formulas: countNodes(children, "formulaInline") + countNodes(children, "formulaBlock"),
      characters: editorText.length,
    },
  };
}

export function renderPreviewHtml(
  editorText: string,
  resourceReferences: readonly ResourceReference[] = [],
): string {
  const canonicalText = canonicalizeEditorText(editorText);
  const formulas = scanFormulas(canonicalText);
  const environment: PreviewEnvironment = {
    markdownReferences: resourceReferences.filter((item) => item.syntax !== "wiki-image"),
    wikiReferences: resourceReferences.filter((item) => item.syntax === "wiki-image"),
    markdownIndex: 0,
    wikiIndex: 0,
    inlineFormulas: formulas.filter((item) => !item.displayMode),
    blockFormulas: formulas.filter((item) => item.displayMode),
    inlineFormulaIndex: 0,
    blockFormulaIndex: 0,
    inlineCodes: [],
    inlineLinks: [],
    inlineCodeIndex: 0,
    inlineLinkIndex: 0,
  };
  const tokens = previewMarkdown.parse(canonicalText, environment);
  const inlineCodes = scanInlineCodeRanges(canonicalText);
  const inlineLinks = scanInlineLinkRanges(canonicalText);
  environment.inlineCodes = countPreviewTokenType(tokens, "code_inline") === inlineCodes.length ? inlineCodes : [];
  environment.inlineLinks = countPreviewTokenType(tokens, "link_open") === inlineLinks.length ? inlineLinks : [];
  annotatePreviewSourceRanges(tokens, canonicalText);
  return previewMarkdown.renderer.render(tokens, previewMarkdown.options, environment);
}
