import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { remapUnchangedSnapshotRange } from "./live-preview-snapshot";

describe("Live Preview snapshot range remapping", () => {
  const state = EditorState.create({ doc: "before\nprojected block\nafter" });
  const range = { from: 7, to: 22 };

  it("keeps unchanged local source across edits on either side", () => {
    const before = state.update({ changes: { from: 0, to: 6, insert: "earlier text" } });
    expect(remapUnchangedSnapshotRange(before, range)).toEqual({ from: 13, to: 28 });

    const after = state.update({ changes: { from: state.doc.length, insert: " later" } });
    expect(remapUnchangedSnapshotRange(after, range)).toEqual(range);
  });

  it("drops only the projection whose local source changed", () => {
    const inside = state.update({ changes: { from: 12, to: 17, insert: "changed" } });
    expect(remapUnchangedSnapshotRange(inside, range)).toBeNull();
  });
});
