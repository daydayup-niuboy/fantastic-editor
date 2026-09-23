import { describe, expect, it } from "vitest";
import { suggestionDiffSegments } from "./ai-suggestion-diff";

describe("AI suggestion diff", () => {
  it("marks only changed tokens in the suggestion", () => {
    expect(suggestionDiffSegments("今天天气很好", "今天天气不错")).toEqual([
      { text: "今天天气", changed: false },
      { text: "不错", changed: true },
    ]);
    expect(suggestionDiffSegments("hello world", "hello there world")).toEqual([
      { text: "hello", changed: false },
      { text: " there", changed: true },
      { text: " world", changed: false },
    ]);
  });

  it("treats identical text as unchanged and empty original as all added", () => {
    expect(suggestionDiffSegments("同一段", "同一段")).toEqual([{ text: "同一段", changed: false }]);
    expect(suggestionDiffSegments("", "新增")).toEqual([{ text: "新增", changed: true }]);
  });
});