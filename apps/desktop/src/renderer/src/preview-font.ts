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
  { id: "comfortable", label: "舒适", maxWidth: "720px" },
  { id: "wide", label: "宽", maxWidth: "1040px" },
  { id: "full", label: "全宽", maxWidth: "none" },
];

export const DEFAULT_READING_WIDTH: ReadingWidth = "comfortable";
export const MIN_READING_WIDTH_PX = 360;
export const MAX_READING_WIDTH_PX = 1400;
export const DEFAULT_READING_WIDTH_PX = 720;
export const DEFAULT_PREVIEW_FONT_SIZE = 17;
export const MIN_PREVIEW_FONT_SIZE = 10;
export const MAX_PREVIEW_FONT_SIZE = 48;

export function normalizeReadingWidth(value: unknown): ReadingWidth {
  return READING_WIDTH_OPTIONS.some((item) => item.id === value) ? value as ReadingWidth : DEFAULT_READING_WIDTH;
}

export function normalizeReadingWidthPx(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_READING_WIDTH_PX;
  return Math.min(MAX_READING_WIDTH_PX, Math.max(MIN_READING_WIDTH_PX, Math.round(parsed)));
}

export function readingWidthPxFromPreset(value: unknown, fullWidth = MAX_READING_WIDTH_PX): number {
  const preset = normalizeReadingWidth(value);
  if (preset === "full") return normalizeReadingWidthPx(fullWidth);
  const raw = READING_WIDTH_OPTIONS.find((item) => item.id === preset)?.maxWidth ?? "720px";
  return normalizeReadingWidthPx(Number.parseInt(raw, 10));
}

export function normalizePreviewFontSize(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_PREVIEW_FONT_SIZE;
  return Math.min(MAX_PREVIEW_FONT_SIZE, Math.max(MIN_PREVIEW_FONT_SIZE, Math.round(parsed)));
}

export function readingWidthMaxWidth(value: unknown): string {
  const normalized = normalizeReadingWidth(value);
  return READING_WIDTH_OPTIONS.find((item) => item.id === normalized)?.maxWidth ?? "720px";
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

