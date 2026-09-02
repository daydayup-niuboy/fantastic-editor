export const DEFAULT_PREVIEW_FONT = "Microsoft YaHei UI";

export const PREVIEW_FONT_PRESETS = [
  "Microsoft YaHei UI",
  "Segoe UI Variable Text",
  "Arial",
  "DengXian",
  "SimSun",
  "KaiTi",
] as const;

export type ReadingWidth = "narrow" | "comfortable" | "wide" | "full";

export const READING_WIDTH_OPTIONS: readonly { id: ReadingWidth; label: string; maxWidth: string }[] = [
  { id: "narrow", label: "窄", maxWidth: "680px" },
  { id: "comfortable", label: "舒适", maxWidth: "820px" },
  { id: "wide", label: "宽", maxWidth: "1040px" },
  { id: "full", label: "全宽", maxWidth: "none" },
];

export const DEFAULT_READING_WIDTH: ReadingWidth = "comfortable";
export const DEFAULT_PREVIEW_FONT_SIZE = 14;

export function normalizeReadingWidth(value: unknown): ReadingWidth {
  return READING_WIDTH_OPTIONS.some((item) => item.id === value) ? value as ReadingWidth : DEFAULT_READING_WIDTH;
}

export function normalizePreviewFontSize(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_PREVIEW_FONT_SIZE;
  return Math.min(24, Math.max(12, Math.round(parsed)));
}

export function readingWidthMaxWidth(value: unknown): string {
  const normalized = normalizeReadingWidth(value);
  return READING_WIDTH_OPTIONS.find((item) => item.id === normalized)?.maxWidth ?? "820px";
}

export function normalizePreviewFontName(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_PREVIEW_FONT;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 64 || /[\u0000-\u001f\u007f{};<>]/.test(normalized)) return DEFAULT_PREVIEW_FONT;
  return normalized;
}

export function commitPreviewFontDraft(value: unknown, current: string): string {
  return typeof value === "string" && value.trim() ? normalizePreviewFontName(value) : normalizePreviewFontName(current);
}

export function previewFontStack(fontName: string): string {
  const normalized = normalizePreviewFontName(fontName);
  return `"${normalized.replaceAll('"', "")}", "Segoe UI", sans-serif`;
}

