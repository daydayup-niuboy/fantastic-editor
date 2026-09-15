import { history, undo } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { applyEditorTextReplacement, captureEditorTextAnchor } from "./editor-text-transaction";

function targetWithState(initial: EditorState) {
  let state = initial;
  return {
    get state() { return state; },
    dispatch(spec: TransactionSpec) { state = state.update(spec).state; },
  };
}

describe("editor text transaction", () => {
  it("captures a selection or current Markdown block from the canonical EditorState", async () => {
    const selected = EditorState.create({ doc: "第一段\n\n第二段", selection: { anchor: 0, head: 3 }, extensions: [markdown()] });
    expect(await captureEditorTextAnchor("doc-1", selected)).toMatchObject({ documentId: "doc-1", from: 0, to: 3, expectedText: "第一段" });

    const block = EditorState.create({ doc: "# 标题\n\n正文", selection: { anchor: 8 }, extensions: [markdown()] });
    expect(await captureEditorTextAnchor("doc-1", block)).toMatchObject({ from: 6, to: 8, expectedText: "正文" });
  });

  it("applies one undoable transaction and rejects stale or cross-document anchors", async () => {
    const target = targetWithState(EditorState.create({ doc: "旧内容", selection: { anchor: 0, head: 3 }, extensions: [history(), markdown()] }));
    const anchor = await captureEditorTextAnchor("doc-1", target.state);
    expect(await applyEditorTextReplacement(target, "doc-1", anchor!, "新内容")).toBe(true);
    expect(target.state.doc.toString()).toBe("新内容");
    expect(undo(target)).toBe(true);
    expect(target.state.doc.toString()).toBe("旧内容");
    expect(await applyEditorTextReplacement(target, "doc-2", anchor!, "越权")).toBe(false);

    target.dispatch({ changes: { from: 3, insert: "已变化" } });
    expect(await applyEditorTextReplacement(target, "doc-1", anchor!, "迟到结果")).toBe(false);
    expect(target.state.doc.toString()).toBe("旧内容已变化");
  });
});
