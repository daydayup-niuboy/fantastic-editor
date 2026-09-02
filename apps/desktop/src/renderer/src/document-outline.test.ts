import { describe, expect, it } from "vitest";
import { parseDocument } from "@fantastic-editor/document-core";
import { extractDocumentOutline } from "./document-outline";

describe("document outline", () => {
  it("collects heading labels and exact source ranges", async () => {
    const document = await parseDocument({ documentId: "outline-test", editorText: "# First\n\n## **Second**\n" });
    const entries = extractDocumentOutline(document);
    expect(entries.map((entry) => [entry.level, entry.label])).toEqual([[1, "First"], [2, "Second"]]);
    expect(entries[0]?.from).toBe(0);
    expect(entries[0]?.to).toBeGreaterThan(entries[0]?.from ?? 0);
  });
});
