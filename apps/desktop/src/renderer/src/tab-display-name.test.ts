import { describe, expect, it } from "vitest";
import { firstLineDisplayName } from "./App";

describe("untitled tab display name", () => {
  it("uses the first non-empty line and strips Markdown markers, capped at 40 characters", () => {
    expect(firstLineDisplayName("")).toBeNull();
    expect(firstLineDisplayName("\n\n   \n")).toBeNull();
    expect(firstLineDisplayName("# 标题\n\n正文")).toBe("标题");
    expect(firstLineDisplayName("###### 六级标题")).toBe("六级标题");
    expect(firstLineDisplayName("> 引用开头")).toBe("引用开头");
    expect(firstLineDisplayName("- 列表开头")).toBe("列表开头");
    expect(firstLineDisplayName("每行都有内容的普通开头")).toBe("每行都有内容的普通开头");
    expect(firstLineDisplayName(`${"字".repeat(60)}\n第二行`)).toBe("字".repeat(40));
  });
});
