import { describe, expect, it } from "vitest";
import { parseMarkdownOpenArgs } from "./external-open";

describe("external markdown open arguments", () => {
  it("accepts absolute markdown paths, ignores flags, and deduplicates", () => {
    const result = parseMarkdownOpenArgs(["electron.exe", "--no-sandbox", "C:\\Docs\\note.md", "C:\\Docs\\NOTE.MD", "C:\\Docs\\readme.txt"]);
    expect(result).toEqual([{ path: "C:\\Docs\\note.md", displayName: "note.md" }]);
  });
});
