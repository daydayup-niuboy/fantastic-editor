import { basename, extname, isAbsolute } from "node:path";

export interface ExternalMarkdownOpenRequest {
  requestId: string;
  displayName: string;
}

export interface ParsedExternalMarkdownPath {
  path: string;
  displayName: string;
}

const MARKDOWN_FILE = /^\.(?:md|markdown)$/i;

export function parseMarkdownOpenArgs(args: readonly string[]): ParsedExternalMarkdownPath[] {
  const seen = new Set<string>();
  const result: ParsedExternalMarkdownPath[] = [];
  for (const raw of args) {
    const value = raw.replace(/^"|"$/g, "").trim();
    if (!value || value.startsWith("-") || !isAbsolute(value) || !MARKDOWN_FILE.test(extname(value))) continue;
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ path: value, displayName: basename(value) });
    if (result.length >= 20) break;
  }
  return result;
}
