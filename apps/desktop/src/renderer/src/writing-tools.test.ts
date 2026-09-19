import { describe, expect, it } from "vitest";
import { applySmartPunctuation, writingStatistics } from "./writing-tools";

describe("writing tools", () => {
  it("derives local word and reading statistics", () => {
    expect(writingStatistics("# 中文测试\n\nHello world")).toEqual({ characters: 14, words: 6, readingMinutes: 1 });
  });

  it("smartens prose but preserves code fences, inline code, and URLs", () => {
    const source = '他说 "你好"... `"code"...` [链接](https://example.com "title")\n```js\n"raw"...\n```';
    expect(applySmartPunctuation(source)).toBe('他说 “你好”…… `"code"...` [链接](https://example.com "title")\n```js\n"raw"...\n```');
  });
});
