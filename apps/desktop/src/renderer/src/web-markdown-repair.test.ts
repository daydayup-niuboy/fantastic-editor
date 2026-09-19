import { markdown } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { repairWebMarkdown, unwrapMarkdownDocumentFence } from "./web-markdown-repair";

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

  it("normalizes webpage non-breaking spaces before Markdown structures", () => {
    const source = "\u00A0# 标题\n\n\u00A0> 引用\n\n\u00A0---\n\n\u00A0| 键 | 值 |\n| --- | --- |\n| A | B |\n\n```txt\n\u00A0# code\n```";
    const repaired = repairWebMarkdown(source);

    expect(repaired.markdown).toBe(" # 标题\n\n > 引用\n\n ---\n\n | 键 | 值 |\n| --- | --- |\n| A | B |\n\n```txt\n\u00A0# code\n```");
    expect(repaired.repairedMarkers).toBe(4);
    expect(repaired.changed).toBe(true);
    const nodeNames: string[] = [];
    syntaxTree(EditorState.create({ doc: repaired.markdown, extensions: [markdown()] })).iterate({ enter: (node) => { nodeNames.push(node.type.name); } });
    expect(nodeNames).toEqual(expect.arrayContaining(["ATXHeading1", "Blockquote", "HorizontalRule", "FencedCode"]));
  });
});

describe("Markdown document fence detection", () => {
  it("unwraps a Markdown document while preserving its inner XML fence", () => {
    const source = "```markdown\n# SVG 测试\n\n| 项目 | 结果 |\n|---|---|\n\n![external](demo.svg)\n\n```xml\n<svg><rect /></svg>\n```";
    const result = unwrapMarkdownDocumentFence(source);
    expect(result.detected).toBe(true);
    expect(result.markdown).toBe("# SVG 测试\n\n| 项目 | 结果 |\n|---|---|\n\n![external](demo.svg)\n\n```xml\n<svg><rect /></svg>\n```");
  });

  it("removes a genuine trailing document wrapper", () => {
    const result = unwrapMarkdownDocumentFence("```md\n# 标题\n\n- 项目\n```");
    expect(result).toEqual({ markdown: "# 标题\n\n- 项目", detected: true });
  });

  it("preserves an unlabelled fenced block inside the document wrapper", () => {
    const result = unwrapMarkdownDocumentFence("\uFEFF```markdown\n# 标题\n\n- 项目\n\n```\nraw <value>\n```\n```");
    expect(result).toEqual({ markdown: "# 标题\n\n- 项目\n\n```\nraw <value>\n```", detected: true });
  });

  it("does not mistake a short Markdown code example for a wrapped document", () => {
    const source = "```markdown\n# one example\n```";
    expect(unwrapMarkdownDocumentFence(source)).toEqual({ markdown: source, detected: false });
  });
});
