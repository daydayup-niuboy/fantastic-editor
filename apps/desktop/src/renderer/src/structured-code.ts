export type StructuredCodeKind = "json" | "yaml" | "toml" | "html" | "config";

export interface StructuredCodeRow {
  depth: number;
  label: string;
  kind: "branch" | "value" | "comment";
}

export interface StructuredCodeOutline {
  kind: StructuredCodeKind;
  label: string;
  rows: StructuredCodeRow[];
}

export type StructuredCodeTokenKind = "key" | "string" | "number" | "boolean" | "null" | "tag" | "punctuation" | "text";
export interface StructuredCodeToken { text: string; kind: StructuredCodeTokenKind }

function valueTokenKind(value: string): StructuredCodeTokenKind {
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(value)) return "number";
  if (/^(?:true|false)$/i.test(value)) return "boolean";
  if (/^(?:null|nil|none)$/i.test(value)) return "null";
  return "string";
}

export function tokenizeStructuredLabel(kind: StructuredCodeKind, row: StructuredCodeRow): StructuredCodeToken[] {
  if (row.kind === "comment") return [{ text: row.label, kind: "text" }];
  if (kind === "html") {
    const tag = /^(<\/?)([\w:-]+)(>)$/.exec(row.label);
    if (tag) return [
      { text: tag[1]!, kind: "punctuation" },
      { text: tag[2]!, kind: "tag" },
      { text: tag[3]!, kind: "punctuation" },
    ];
    return [{ text: row.label, kind: "text" }];
  }
  const separator = row.label.indexOf(": ");
  if (separator >= 0) {
    const value = row.label.slice(separator + 2);
    return [
      { text: row.label.slice(0, separator), kind: "key" },
      { text: ": ", kind: "punctuation" },
      { text: value, kind: valueTokenKind(value) },
    ];
  }
  const branch = /^(.*?)(\s[\[{]\d+[\]}])$/.exec(row.label);
  return branch
    ? [{ text: branch[1]!, kind: "key" }, { text: branch[2]!, kind: "punctuation" }]
    : [{ text: row.label, kind: row.kind === "branch" ? "key" : "text" }];
}

function appendStructuredLabel(target: HTMLElement, outline: StructuredCodeOutline, row: StructuredCodeRow): void {
  for (const token of tokenizeStructuredLabel(outline.kind, row)) {
    const span = document.createElement("span");
    span.className = `structured-token-${token.kind}`;
    span.textContent = token.text;
    target.append(span);
  }
}

export function structuredBranchEnd(rows: readonly StructuredCodeRow[], index: number): number {
  const depth = rows[index]?.depth;
  if (depth === undefined) return index;
  let end = index + 1;
  while (end < rows.length && rows[end]!.depth > depth) end += 1;
  return end;
}

const MAX_SOURCE_LENGTH = 200_000;
const MAX_ROWS = 500;
const MAX_DEPTH = 12;

function normalizeLanguage(language: string): StructuredCodeKind | null {
  switch (language.trim().toLowerCase()) {
    case "json": return "json";
    case "yaml": case "yml": return "yaml";
    case "toml": return "toml";
    case "html": case "xml": return "html";
    case "ini": case "conf": case "config": case "env": case "dotenv": case "properties": return "config";
    default: return null;
  }
}

function shortValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value.length > 80 ? `${value.slice(0, 77)}…` : value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function jsonRows(value: unknown): StructuredCodeRow[] {
  const rows: StructuredCodeRow[] = [];
  const visit = (current: unknown, label: string, depth: number) => {
    if (rows.length >= MAX_ROWS) return;
    if (depth > MAX_DEPTH) {
      rows.push({ depth: MAX_DEPTH, label: `${label}: …`, kind: "value" });
      return;
    }
    if (Array.isArray(current)) {
      rows.push({ depth, label: `${label} [${current.length}]`, kind: "branch" });
      current.forEach((item, index) => visit(item, `[${index}]`, depth + 1));
      return;
    }
    if (current && typeof current === "object") {
      const entries = Object.entries(current as Record<string, unknown>);
      rows.push({ depth, label: `${label} {${entries.length}}`, kind: "branch" });
      for (const [key, item] of entries) visit(item, key, depth + 1);
      return;
    }
    rows.push({ depth, label: `${label}: ${shortValue(current)}`, kind: "value" });
  };
  visit(value, "root", 0);
  return rows;
}

function yamlRows(source: string): StructuredCodeRow[] {
  return source.split(/\r?\n/).flatMap((line): StructuredCodeRow[] => {
    const trimmed = line.trim();
    if (!trimmed) return [];
    const depth = Math.min(MAX_DEPTH, Math.floor((line.match(/^\s*/)?.[0].replace(/\t/g, "  ").length ?? 0) / 2));
    if (trimmed.startsWith("#")) return [{ depth, label: trimmed.slice(0, 100), kind: "comment" }];
    const match = /^(?:-\s*)?([^:#][^:]*):(?:\s*(.*))?$/.exec(trimmed);
    if (!match) return [{ depth, label: trimmed.slice(0, 120), kind: "value" }];
    const key = match[1]!.trim();
    const value = match[2]?.trim() ?? "";
    return [{ depth, label: value ? `${key}: ${value.slice(0, 80)}` : key, kind: value ? "value" : "branch" }];
  }).slice(0, MAX_ROWS);
}

function tomlRows(source: string): StructuredCodeRow[] {
  let sectionDepth = 0;
  return source.split(/\r?\n/).flatMap((line): StructuredCodeRow[] => {
    const trimmed = line.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("#")) return [{ depth: sectionDepth, label: trimmed.slice(0, 100), kind: "comment" }];
    const section = /^\[\[?([^\]]+)\]\]?$/.exec(trimmed);
    if (section) {
      sectionDepth = Math.min(MAX_DEPTH, section[1]!.split(".").length - 1);
      return [{ depth: sectionDepth, label: section[1]!, kind: "branch" }];
    }
    const assignment = /^([^=]+)=\s*(.*)$/.exec(trimmed);
    return [{ depth: Math.min(MAX_DEPTH, sectionDepth + 1), label: assignment ? `${assignment[1]!.trim()}: ${assignment[2]!.slice(0, 80)}` : trimmed.slice(0, 120), kind: "value" }];
  }).slice(0, MAX_ROWS);
}

function htmlRows(source: string): StructuredCodeRow[] {
  const rows: StructuredCodeRow[] = [];
  let depth = 0;
  for (const match of source.matchAll(/<!--[\s\S]*?-->|<\/?([A-Za-z][\w:-]*)\b[^>]*>|([^<]+)/g)) {
    if (rows.length >= MAX_ROWS) break;
    const token = match[0];
    if (token.startsWith("<!--")) {
      rows.push({ depth: Math.min(depth, MAX_DEPTH), label: "<!-- comment -->", kind: "comment" });
      continue;
    }
    const tag = match[1]?.toLowerCase();
    if (tag) {
      if (token.startsWith("</")) depth = Math.max(0, depth - 1);
      rows.push({ depth: Math.min(depth, MAX_DEPTH), label: token.startsWith("</") ? `</${tag}>` : `<${tag}>`, kind: token.startsWith("</") ? "value" : "branch" });
      if (!token.startsWith("</") && !/\/\s*>$/.test(token) && !/^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(tag)) depth += 1;
      continue;
    }
    const text = (match[2] ?? "").replace(/\s+/g, " ").trim();
    if (text) rows.push({ depth: Math.min(depth, MAX_DEPTH), label: text.slice(0, 100), kind: "value" });
  }
  return rows;
}

function configRows(source: string): StructuredCodeRow[] {
  let inSection = false;
  return source.split(/\r?\n/).flatMap((line): StructuredCodeRow[] => {
    const trimmed = line.trim();
    if (!trimmed) return [];
    if (/^[#;]/.test(trimmed)) return [{ depth: inSection ? 1 : 0, label: trimmed.slice(0, 100), kind: "comment" }];
    const section = /^\[([^\]]+)\]$/.exec(trimmed);
    if (section) {
      inSection = true;
      return [{ depth: 0, label: section[1]!.slice(0, 100), kind: "branch" }];
    }
    const assignment = /^(?:export\s+)?([^=:\s]+)\s*[=:]\s*(.*)$/.exec(trimmed);
    return [{
      depth: inSection ? 1 : 0,
      label: assignment ? `${assignment[1]}: ${assignment[2]!.slice(0, 80)}` : trimmed.slice(0, 120),
      kind: "value",
    }];
  }).slice(0, MAX_ROWS);
}

export function buildStructuredCodeOutline(language: string, source: string): StructuredCodeOutline | null {
  const kind = normalizeLanguage(language);
  if (!kind || source.length === 0 || source.length > MAX_SOURCE_LENGTH) return null;
  try {
    const rows = kind === "json"
      ? jsonRows(JSON.parse(source) as unknown)
      : kind === "yaml" ? yamlRows(source)
        : kind === "toml" ? tomlRows(source)
          : kind === "html" ? htmlRows(source)
            : configRows(source);
    if (rows.length === 0) return null;
    const label = kind === "json" ? "JSON 结构" : kind === "yaml" ? "YAML 层级" : kind === "toml" ? "TOML 配置" : kind === "html" ? "HTML 标签结构" : "配置项";
    return { kind, label, rows };
  } catch {
    return null;
  }
}

export function createStructuredCodeVisualization(language: string, source: string): HTMLElement | null {
  const outline = buildStructuredCodeOutline(language, source);
  if (!outline) return null;
  const section = document.createElement("section");
  section.className = `structured-code-visualization structured-code-${outline.kind}`;
  section.dataset.structuredLanguage = outline.kind;
  const header = document.createElement("header");
  const title = document.createElement("strong");
  title.textContent = outline.label;
  const count = document.createElement("span");
  count.textContent = `${outline.rows.length} 项`;
  header.append(title, count);
  const tree = document.createElement("div");
  tree.className = "structured-code-tree";
  tree.setAttribute("role", "tree");
  const elements: HTMLElement[] = [];
  for (const [index, row] of outline.rows.entries()) {
    const item = document.createElement("div");
    item.className = `structured-code-row ${row.kind}`;
    item.style.setProperty("--structured-depth", String(row.depth));
    item.setAttribute("role", "treeitem");
    item.setAttribute("aria-level", String(row.depth + 1));
    if (row.kind === "branch") {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "structured-code-toggle";
      toggle.ariaExpanded = "true";
      const marker = document.createElement("span");
      marker.className = "structured-code-marker";
      marker.textContent = "▾ ";
      toggle.append(marker);
      appendStructuredLabel(toggle, outline, row);
      toggle.addEventListener("click", () => {
        const expanded = toggle.ariaExpanded === "true";
        toggle.ariaExpanded = String(!expanded);
        marker.textContent = `${expanded ? "▸" : "▾"} `;
        for (let child = index + 1; child < structuredBranchEnd(outline.rows, index); child += 1) {
          elements[child]!.hidden = expanded;
        }
      });
      item.append(toggle);
    } else appendStructuredLabel(item, outline, row);
    elements.push(item);
    tree.append(item);
  }
  section.append(header, tree);
  return section;
}
