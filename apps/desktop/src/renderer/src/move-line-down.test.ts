import { EditorState } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import { expect, it } from "vitest";
import { moveLineDownWithSpace } from "./move-line-down";

it("extends the last line repeatedly, preserving selection and undo", () => {
  let state = EditorState.create({ doc: "前文\n末行", selection: { anchor: 3, head: 5 }, extensions: [history()] });
  const dispatch = (transaction: ReturnType<EditorState["update"]>) => { state = transaction.state; };
  moveLineDownWithSpace({ state, dispatch });
  expect(state.doc.toString()).toBe("前文\n\n末行");
  expect(state.sliceDoc(state.selection.main.from, state.selection.main.to)).toBe("末行");
  moveLineDownWithSpace({ state, dispatch });
  expect(state.doc.toString()).toBe("前文\n\n\n末行");
  undo({ state, dispatch });
  expect(state.doc.toString()).toBe("前文\n\n末行");
});

it("keeps ordinary movement and read-only protection", () => {
  let state = EditorState.create({ doc: "甲\n乙" });
  moveLineDownWithSpace({ state, dispatch: tr => { state = tr.state; } });
  expect(state.doc.toString()).toBe("乙\n甲");
  expect(moveLineDownWithSpace({ state: EditorState.create({ doc: "甲", extensions: [EditorState.readOnly.of(true)] }), dispatch: () => { throw new Error("read-only write"); } })).toBe(false);
});

it("moves a final multiline selection as one block", () => {
  let state = EditorState.create({ doc: "甲\n乙\n丙", selection: { anchor: 5, head: 2 } });
  moveLineDownWithSpace({ state, dispatch: tr => { state = tr.state; } });
  expect(state.doc.toString()).toBe("甲\n\n乙\n丙");
  expect(state.selection.main.anchor).toBe(6);
  expect(state.selection.main.head).toBe(3);
});
