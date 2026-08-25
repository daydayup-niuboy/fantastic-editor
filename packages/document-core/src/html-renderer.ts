import katex from "katex";
import type { DocumentNode, ParsedDocument } from "./model.js";

export interface HtmlRenderOptions {
  imageSources?: Readonly<Record<string, string>>;
  imagePlaceholderLabel?: string;
  renderImage?: (node: DocumentNode) => string | undefined;
  renderFormula?: (node: DocumentNode) => string | undefined;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function stringAttribute(node: DocumentNode, key: string): string {
  const value = node.attributes[key];
  return typeof value === "string" ? value : "";
}

function childrenHtml(node: DocumentNode, options: HtmlRenderOptions): string {
  return (node.children ?? []).map((child) => renderNode(child, options)).join("");
}

function renderFormula(node: DocumentNode, options: HtmlRenderOptions): string {
  const custom = options.renderFormula?.(node);
  if (custom !== undefined) return custom;
  const latex = stringAttribute(node, "latex");
  const displayMode = node.type === "formulaBlock" || node.attributes.displayMode === true;
  try {
    return katex.renderToString(latex, {
      displayMode,
      throwOnError: false,
      strict: "ignore",
      output: "htmlAndMathml",
      trust: false,
    });
  } catch {
    return `<span class="formula-error">[公式无法渲染：${escapeHtml(latex)}]</span>`;
  }
}

function renderImage(node: DocumentNode, options: HtmlRenderOptions): string {
  const custom = options.renderImage?.(node);
  if (custom !== undefined) return custom;
  const referenceKey = stringAttribute(node, "referenceKey");
  const alt = stringAttribute(node, "alt") || "图片";
  const title = stringAttribute(node, "title");
  const source = options.imageSources?.[referenceKey];
  if (!source) {
    return `<span class="resource-placeholder" data-reference-key="${escapeHtml(referenceKey)}">[${escapeHtml(options.imagePlaceholderLabel ?? "图片未提供")}：${escapeHtml(alt)}]</span>`;
  }
  return `<img src="${escapeHtml(source)}" alt="${escapeHtml(alt)}"${title ? ` title="${escapeHtml(title)}"` : ""} data-reference-key="${escapeHtml(referenceKey)}">`;
}

function renderNode(node: DocumentNode, options: HtmlRenderOptions): string {
  const content = () => childrenHtml(node, options);
  switch (node.type) {
    case "text": return escapeHtml(stringAttribute(node, "value"));
    case "softBreak": return "\n";
    case "hardBreak": return "<br>\n";
    case "emphasis": return `<em>${content()}</em>`;
    case "strong": return `<strong>${content()}</strong>`;
    case "strikethrough": return `<del>${content()}</del>`;
    case "inlineCode": return `<code>${escapeHtml(stringAttribute(node, "value"))}</code>`;
    case "link": {
      const href = stringAttribute(node, "normalizedHref") || stringAttribute(node, "originalHref");
      const allowed = node.attributes.safetyState === "allowed" && /^(?:https?:|mailto:|#|\/)/i.test(href);
      return allowed
        ? `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${content()}</a>`
        : `<span class="blocked-link">${content()}</span>`;
    }
    case "image": return renderImage(node, options);
    case "formulaInline": return renderFormula(node, options);
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(node.attributes.level) || 1));
      return `<h${level}>${content()}</h${level}>`;
    }
    case "paragraph": return `<p>${content()}</p>`;
    case "blockquote": return `<blockquote>${content()}</blockquote>`;
    case "bulletList": return `<ul>${content()}</ul>`;
    case "orderedList": {
      const start = Number(node.attributes.start) || 1;
      return `<ol${start === 1 ? "" : ` start="${start}"`}>${content()}</ol>`;
    }
    case "listItem": return `<li>${content()}</li>`;
    case "taskItem": {
      const checked = node.attributes.checked === true;
      return `<li class="task-item"><input type="checkbox" disabled${checked ? " checked" : ""}>${content()}</li>`;
    }
    case "codeBlock": {
      const language = stringAttribute(node, "language");
      return `<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ""}>${escapeHtml(stringAttribute(node, "value"))}</code></pre>`;
    }
    case "table": return `<table>${content()}</table>`;
    case "tableHead": return `<thead>${content()}</thead>`;
    case "tableBody": return `<tbody>${content()}</tbody>`;
    case "tableRow": return `<tr>${content()}</tr>`;
    case "tableCell": return node.attributes.header === true ? `<th>${content()}</th>` : `<td>${content()}</td>`;
    case "thematicBreak": return "<hr>";
    case "formulaBlock": return `<div class="formula-block">${renderFormula(node, options)}</div>`;
    case "rawHtmlInline":
    case "rawHtmlBlock": return '<span class="blocked-raw-html">[原始 HTML 已阻止]</span>';
    case "unsupportedInline":
    case "unsupportedBlock": return '<span class="unsupported-node">[不支持的 Markdown 内容]</span>';
    default: return content();
  }
}

export function renderParsedDocumentHtml(
  document: ParsedDocument,
  options: HtmlRenderOptions = {},
): string {
  return document.children.map((node) => renderNode(node, options)).join("\n");
}