import { describe, expect, it } from "vitest";
import { repairWebMarkdown } from "./web-markdown-repair";

describe("web Markdown repair", () => {
  it("repairs escaped structure and webpage spacing", () => {
    const source = "\\# 标题\n   \n\n1\\. \\*\\*重点\\*\\* 和 \\`代码\\`\n\n\\- \\[ \\] 任务\n\n| 键 | 值 |\n\n|---|---|\n\n\\`\\`\\`ts\nconst path = 'C:\\\\temp';\nconst value = `${token}`;\n\\`\\`\\`";
    const repaired = repairWebMarkdown(source);
    expect(repaired.markdown).toBe("# 标题\n\n1. **重点** 和 `代码`\n\n- [ ] 任务\n\n| 键 | 值 |\n|---|---|\n\n```ts\nconst path = 'C:\\\\temp';\nconst value = `${token}`;\n```");
    expect(repaired.repairedMarkers).toBeGreaterThanOrEqual(5);
    expect(repaired.repairedInlinePairs).toBe(2);
    expect(repaired.repairedTableGaps).toBe(1);
    expect(repaired.changed).toBe(true);
  });

  it("leaves ordinary escapes and fenced code content unchanged", () => {
    const source = "普通文字里的 \\# 不是标题，正则 \\[a-z\\] 保持原样。\n\n```txt\n\\# code\n1\\. code\n```";
    expect(repairWebMarkdown(source).markdown).toBe(source);
  });
});
