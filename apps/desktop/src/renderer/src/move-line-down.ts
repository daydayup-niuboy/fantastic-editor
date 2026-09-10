import { moveLineDown } from "@codemirror/commands";
import { EditorSelection, type StateCommand } from "@codemirror/state";

export const moveLineDownWithSpace: StateCommand = (target) => {
  const { state, dispatch } = target;
  if (state.readOnly) return false;
  const selection = state.selection.main;
  const lastOffset = !selection.empty && selection.to === state.doc.lineAt(selection.to).from ? selection.to - 1 : selection.to;
  if (state.selection.ranges.length !== 1 || state.doc.lineAt(lastOffset).to !== state.doc.length) return moveLineDown(target);
  // Moving a final block over a newly appended empty line is exactly an empty line before that block.
  dispatch(state.update({
    changes: { from: state.doc.lineAt(selection.from).from, insert: state.lineBreak },
    selection: EditorSelection.range(selection.anchor + 1, selection.head + 1),
    scrollIntoView: true,
    userEvent: "move.line",
  }));
  return true;
};
