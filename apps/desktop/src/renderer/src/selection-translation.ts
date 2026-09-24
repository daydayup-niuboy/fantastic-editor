export const TRANSLATION_LANGUAGES = [
  { id: "zh-CN", label: "简体中文" },
  { id: "en", label: "English" },
  { id: "zh-TW", label: "繁體中文" },
  { id: "ja", label: "日本語" },
  { id: "ko", label: "한국어" },
  { id: "es", label: "Español" },
] as const;

export type TranslationLanguageId = (typeof TRANSLATION_LANGUAGES)[number]["id"];

export function exceedsAiInputLimit(text: string): boolean {
  return new TextEncoder().encode(text).byteLength > 64 * 1024;
}

export function defaultTranslationLanguage(text: string): TranslationLanguageId {
  if (/[\u3040-\u30ff]/u.test(text)) return "zh-CN";
  return /[\u3400-\u9fff]/u.test(text) ? "en" : "zh-CN";
}

export function translationInstruction(languageId: TranslationLanguageId): string {
  const language = TRANSLATION_LANGUAGES.find(({ id }) => id === languageId) ?? TRANSLATION_LANGUAGES[0];
  return `将选中文字翻译成${language.label}。只返回译文，不要解释、总结或添加引号；保留原文中的 Markdown 格式、专有名词、数字与事实含义。`;
}
