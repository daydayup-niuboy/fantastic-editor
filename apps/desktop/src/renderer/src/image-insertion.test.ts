import { describe, expect, it } from "vitest";
import { ChangeSet } from "@codemirror/state";
import type { ImportedAssetReceipt } from "@fantastic-editor/shared";
import { createImageMarkdown, imageAltText, mapImageInsertionAnchor } from "./image-insertion";

function receipt(displayName: string, relativeRef: string): ImportedAssetReceipt {
  return {
    importRequestId: "image-import-test",
    documentId: "document-test",
    sessionId: "session-test",
    workspaceRevision: 2,
    relativeRef,
    displayName,
    mimeType: "image/png",
    byteLength: 24,
    contentHash: "a".repeat(64),
    reusedExisting: false,
  };
}

describe("image insertion Markdown", () => {
  it("escapes alt text without changing the safe relative reference", () => {
    expect(imageAltText("结果[最终]\\图.png")).toBe("结果\\[最终\\]\\\\图");
    expect(createImageMarkdown([receipt("结果[最终]\\图.png", "./assets/result-a1b2c3d4.png")]))
      .toBe("![结果\\[最终\\]\\\\图](./assets/result-a1b2c3d4.png)");
  });

  it("maps a pending point anchor past text typed while the image import is running", () => {
    const changes = ChangeSet.of([{ from: 5, insert: "继续输入" }], 10);
    expect(mapImageInsertionAnchor({ from: 5, to: 5 }, changes)).toEqual({ from: 9, to: 9 });
  });
  it("keeps multi-image order and separates block images with a blank line", () => {
    expect(createImageMarkdown([
      receipt("第一张.png", "./assets/first-a.png"),
      receipt("第二张.png", "./assets/second-b.png"),
    ])).toBe("![第一张](./assets/first-a.png)\n\n![第二张](./assets/second-b.png)");
  });
});

