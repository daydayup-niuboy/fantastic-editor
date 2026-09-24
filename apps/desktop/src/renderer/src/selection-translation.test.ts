import { describe, expect, it } from "vitest";
import { defaultTranslationLanguage, exceedsAiInputLimit, translationInstruction } from "./selection-translation";

describe("selection translation", () => {
  it("chooses a useful target language for Chinese and non-Chinese selections", () => {
    expect(defaultTranslationLanguage("选中的文字")).toBe("en");
    expect(defaultTranslationLanguage("Selected words")).toBe("zh-CN");
    expect(defaultTranslationLanguage("翻訳のテストです")).toBe("zh-CN");
  });

  it("asks the configured model for translation only while preserving Markdown meaning", () => {
    expect(translationInstruction("ja")).toContain("翻译成日本語");
    expect(translationInstruction("ja")).toContain("只返回译文");
    expect(translationInstruction("ja")).toContain("Markdown 格式");
  });

  it("matches the AI request limit in UTF-8 bytes", () => {
    expect(exceedsAiInputLimit("a".repeat(64 * 1024))).toBe(false);
    expect(exceedsAiInputLimit("a".repeat(64 * 1024 + 1))).toBe(true);
    expect(exceedsAiInputLimit("界".repeat(21_846))).toBe(true);
  });
});
