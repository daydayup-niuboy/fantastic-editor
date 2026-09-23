import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { createSearchQuery, searchMatches, skipAutoClosedCharacter, transactionsIncludePaste } from "./MarkdownEditor";

describe("editor search and input helpers", () => {
  it("distinguishes paste transactions from ordinary input", () => {
    const transaction = (event: string) => ({ isUserEvent: (candidate: string) => candidate === event });
    expect(transactionsIncludePaste([transaction("input.paste")])).toBe(true);
    expect(transactionsIncludePaste([transaction("input.type")])).toBe(false);
  });

  it("respects case-sensitive and whole-word search options", () => {
    const state = EditorState.create({ doc: "Test test tester" });
    expect(searchMatches(state, createSearchQuery("Test", { caseSensitive: true }))).toEqual([{ from: 0, to: 4 }]);
    expect(searchMatches(state, createSearchQuery("test", { wholeWord: true }))).toEqual([{ from: 0, to: 4 }, { from: 5, to: 9 }]);
  });

  it("enters and exits round brackets with consecutive Tabs without changing the document", () => {
    let state = EditorState.create({ doc: "()", selection: { anchor: 1 } });
    const view = {
      get state() { return state; },
      dispatch(spec: Parameters<typeof state.update>[0]) { state = state.update(spec).state; },
    } as unknown as EditorView;
    expect(skipAutoClosedCharacter(view)).toBe(true);
    expect(state.selection.main.head).toBe(2);
    expect(state.doc.toString()).toBe("()");

    state = EditorState.create({ doc: "（）", selection: { anchor: 1 } });
    expect(skipAutoClosedCharacter(view)).toBe(true);
    expect(state.selection.main.head).toBe(2);

    for (const doc of ["()", "（）"]) {
      state = EditorState.create({ doc, selection: { anchor: 0 } });
      expect(skipAutoClosedCharacter(view)).toBe(true);
      expect(state.selection.main.head).toBe(1);
      expect(skipAutoClosedCharacter(view)).toBe(true);
      expect(state.selection.main.head).toBe(2);
      expect(state.doc.toString()).toBe(doc);
      expect(skipAutoClosedCharacter(view)).toBe(false);
      state = EditorState.create({ doc, selection: { anchor: 0, head: 2 } });
      expect(skipAutoClosedCharacter(view)).toBe(false);
    }
    state = EditorState.create({ doc: "正文", selection: { anchor: 0 } });
    expect(skipAutoClosedCharacter(view)).toBe(false);
    expect(state.selection.main.head).toBe(0);
  });
});
