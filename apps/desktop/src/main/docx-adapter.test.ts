import { createHash } from "node:crypto";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { parseDocument, type DocumentNode } from "@fantastic-editor/document-core";
import type { OutputContext, ResolutionRecord } from "@fantastic-editor/shared";
import { formulaReferenceKey, generateDocx, type OutputFormulaAsset } from "./docx-adapter.js";
import type { OutputResourceAsset } from "./offline-html-adapter.js";

function png(_width = 64, _height = 32): Uint8Array {
  return Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function findFormula(nodes: readonly DocumentNode[]): DocumentNode | undefined {
  for (const node of nodes) {
    if (node.type === "formulaInline" || node.type === "formulaBlock") return node;
    const nested = findFormula(node.children ?? []);
    if (nested) return nested;
  }
  return undefined;
}

async function fixture(editorText: string, state: ResolutionRecord["state"] = "resolved") {
  const parsedDocument = await parseDocument({ documentId: "docx-document", editorText });
  const imageBytes = png(320, 200);
  const imageHash = sha256(imageBytes);
  const records: Record<string, ResolutionRecord> = {};
  const assets: OutputResourceAsset[] = [];
  for (const reference of parsedDocument.resourceReferences) {
    records[reference.referenceKey] = {
      referenceKey: reference.referenceKey,
      workspaceRevision: 1,
      assetCacheKey: state === "resolved" ? "a".repeat(64) : null,
      fileFingerprint: null,
      originalRef: reference.originalRef,
      resolvedRef: reference.resolvedRef,
      workspaceRelativePath: state === "resolved" ? "image.png" : null,
      mimeType: state === "resolved" ? "image/png" : null,
      byteLength: state === "resolved" ? imageBytes.byteLength : null,
      contentHash: state === "resolved" ? imageHash : null,
      width: state === "resolved" ? 320 : null,
      height: state === "resolved" ? 200 : null,
      state,
      candidates: [],
      assetHandle: state === "resolved" ? "00000000-0000-4000-8000-000000000001" : null,
      securityFlags: [],
    };
    if (state === "resolved") assets.push({
      referenceKey: reference.referenceKey,
      sourceContentHash: imageHash,
      contentHash: imageHash,
      mimeType: "image/png",
      bytes: imageBytes,
    });
  }
  const context: OutputContext = {
    jobId: "docx-job",
    documentId: parsedDocument.documentId,
    target: "docx",
    sourceHash: parsedDocument.sourceHash,
    workspaceRevision: 1,
    preflightId: "docx-preflight",
    parsedDocument,
    resolutionSnapshot: {
      schema: "fantastic-editor-resolution-snapshot",
      documentId: parsedDocument.documentId,
      sourceHash: parsedDocument.sourceHash,
      workspaceId: "workspace-1",
      workspaceRevision: 1,
      resolverProfile: "test",
      records,
      diagnostics: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    derivedAssetManifest: {
      schema: "fantastic-editor-derived-asset-manifest",
      jobId: "docx-job",
      sourceHash: parsedDocument.sourceHash,
      workspaceRevision: 1,
      entries: {},
    },
    theme: { id: "default", tokens: {} },
    locale: "zh-CN",
    approvedOmittedReferenceKeys: [],
    options: {},
  };
  return { context, assets };
}

describe("generateDocx", () => {
  it("generates readable OOXML with headings, table, image and formula media", async () => {
    const value = await fixture("# 中文标题\n\n正文 **加粗**。\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n![图](image.png)\n\n$$x^2+1$$");
    const formulaNode = findFormula(value.context.parsedDocument.children);
    if (!formulaNode) throw new Error("missing formula node");
    const formulaBytes = png(240, 80);
    const formula: OutputFormulaAsset = {
      formulaReferenceKey: formulaReferenceKey(formulaNode),
      contentHash: sha256(formulaBytes),
      mimeType: "image/png",
      width: 240,
      height: 80,
      bytes: formulaBytes,
    };
    const result = await generateDocx(value.context, value.assets, [formula]);
    expect(result.status, JSON.stringify(result.diagnostics)).toBe("completed");
    expect(result.bytes?.subarray(0, 2)).toEqual(Uint8Array.from([0x50, 0x4b]));
    const archive = await JSZip.loadAsync(result.bytes!);
    const documentXml = await archive.file("word/document.xml")!.async("string");
    expect(documentXml).toContain("中文标题");
    expect(documentXml).toContain("加粗");
    expect(documentXml).toContain("<w:tbl>");
    expect(documentXml).toContain("<w:drawing>");
    expect(documentXml).not.toMatch(/data-source-|PreviewSyncMap|SelectionOverlay|preview-selection/i);
    expect(Object.keys(archive.files).filter((name) => name.startsWith("word/media/"))).toHaveLength(2);
  });

  it("creates real numbering, fixed table geometry and A4 page styles", async () => {
    const source = [
      "# 结构化 Word",
      "",
      "- 普通项目",
      "- [x] 已完成任务",
      "- [ ] 未完成任务",
      "",
      "1. 第一项",
      "2. 第二项",
      "",
      "> 引用第一段",
      ">",
      "> 引用第二段",
      "",
      "| 左列 | 中列 | 右列 |",
      "| :--- | :---: | ---: |",
      "| 很长的中文说明内容 | 中 | 100 |",
      "",
      "[安全链接](https://example.com)",
      "",
      "~~~text",
      "第一行",
      "第二行",
      "~~~",
    ].join("\n");
    const value = await fixture(source);
    const result = await generateDocx(value.context, [], []);
    expect(result.status, JSON.stringify(result.diagnostics)).toBe("completed");
    const archive = await JSZip.loadAsync(result.bytes!);
    const documentXml = await archive.file("word/document.xml")!.async("string");
    const numberingXml = await archive.file("word/numbering.xml")!.async("string");
    const stylesXml = await archive.file("word/styles.xml")!.async("string");
    const coreXml = await archive.file("docProps/core.xml")!.async("string");
    expect(documentXml).toContain('<w:pgSz w:w="11906" w:h="16838" w:orient="portrait"/>');
    expect(documentXml).toContain('<w:tblLayout w:type="fixed"/>');
    expect(documentXml).toContain('<w:tblW w:type="dxa" w:w="9638"/>');
    expect(documentXml).toContain("<w:tblGrid>");
    expect(documentXml).toContain("<w:tblHeader/>");
    expect(documentXml).toContain("<w:cantSplit/>");
    expect(documentXml).toContain("<w:br/>");
    expect((documentXml.match(/引用第一段/g) ?? [])).toHaveLength(1);
    expect((documentXml.match(/引用第二段/g) ?? [])).toHaveLength(1);
    expect(numberingXml).toContain('<w:numFmt w:val="bullet"/>');
    expect(numberingXml).toContain('<w:numFmt w:val="decimal"/>');
    expect(numberingXml).toContain("☒");
    expect(numberingXml).toContain("☐");
    expect(stylesXml).toContain("Microsoft YaHei");
    expect(coreXml).toContain("<dc:title>结构化 Word</dc:title>");
    expect(documentXml).not.toContain("<w:t>• ");
  });

  it("fails when a formula derived asset is missing", async () => {
    const value = await fixture("公式：$x^2$");
    const result = await generateDocx(value.context, [], []);
    expect(result.status).toBe("failed");
    expect(result.diagnostics.some((item) => item.code === "FORMULA_DERIVED_ASSET_MISSING")).toBe(true);
  });

  it("marks an exactly approved missing image as partial completion", async () => {
    const value = await fixture("![缺图](missing.png)", "missing");
    const referenceKey = value.context.parsedDocument.resourceReferences[0]!.referenceKey;
    const context = { ...value.context, approvedOmittedReferenceKeys: [referenceKey] };
    const result = await generateDocx(context, [], []);
    expect(result.status).toBe("completed-with-omissions");
    expect(result.omittedReferenceKeys).toEqual([referenceKey]);
  });
});