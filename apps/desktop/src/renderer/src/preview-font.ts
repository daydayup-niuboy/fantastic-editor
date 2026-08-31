export const DEFAULT_PREVIEW_FONT = "Microsoft YaHei UI";

export const PREVIEW_FONT_PRESETS = [
  "Microsoft YaHei UI",
  "Segoe UI Variable Text",
  "Arial",
  "DengXian",
  "SimSun",
  "KaiTi",
] as const;

export function normalizePreviewFontName(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_PREVIEW_FONT;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 64 || /[\u0000-\u001f\u007f{};<>]/.test(normalized)) return DEFAULT_PREVIEW_FONT;
  return normalized;
}

export function previewFontStack(fontName: string): string {
  const normalized = normalizePreviewFontName(fontName);
  return `"${normalized.replaceAll('"', "")}", "Segoe UI", sans-serif`;
}

