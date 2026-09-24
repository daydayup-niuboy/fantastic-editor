import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { shouldPrefixUntitledHeading, untitledHeadingPrefixOffset } from "./untitled-heading";

describe("untitled first-line heading", () => {
  it("prefixes a plain first line and leaves headings lists quotes and fences alone", () => {
    expect(untitledHeadingPrefixOffset("标题\n正文")).toBe(0);
    expect(untitledHeadingPrefixOffset("\n\n  标题")).toBe(2);
    expect(untitledHeadingPrefixOffset("# 已有标题\n正文")).toBeNull();
    expect(untitledHeadingPrefixOffset("- 列表")).toBeNull();
    expect(untitledHeadingPrefixOffset("```ts\nconst a = 1")).toBeNull();
    expect(untitledHeadingPrefixOffset("")).toBeNull();
  });

  it("promotes after paste or after the first line break, not while typing the title", () => {
    expect(shouldPrefixUntitledHeading("", "客户拜访", true)).toBe(0);
    expect(shouldPrefixUntitledHeading("", "客户拜访", false)).toBeNull();
    expect(shouldPrefixUntitledHeading("客户拜访", "客户拜访", false)).toBeNull();
    expect(shouldPrefixUntitledHeading("客户拜访", "客户拜访\n", false)).toBe(0);
    expect(shouldPrefixUntitledHeading("# 客户拜访", "# 客户拜访\n", false)).toBeNull();
    expect(shouldPrefixUntitledHeading("", "# 已有标题\n正文", true)).toBeNull();
  });

  it("keeps the caret after pasted text when Enter preceded paste in an untitled document", () => {
    const state = EditorState.create({
      doc: "\n",
      selection: { anchor: 1 },
      extensions: [EditorState.transactionFilter.of((transaction) => {
        const offset = shouldPrefixUntitledHeading(transaction.startState.doc.toString(), transaction.newDoc.toString(), transaction.isUserEvent("input.paste"));
        return offset === null ? transaction : [transaction, { changes: { from: offset, insert: "# " }, sequential: true }];
      })],
    });
    const transaction = state.update({
      changes: { from: 1, insert: "Outlook 正文" },
      selection: { anchor: 11 },
      userEvent: "input.paste",
    });
    expect(transaction.newDoc.toString()).toBe("\n# Outlook 正文");
    expect(transaction.newSelection.main.head).toBe(transaction.newDoc.length);
  });
});
