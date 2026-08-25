import { createHash } from "node:crypto";
import type { Diagnostic, DocumentNode } from "@fantastic-editor/document-core";
import type { OutputContext, OutputResultStatus } from "@fantastic-editor/shared";
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type ParagraphChild,
} from "docx";
import type { OutputResourceAsset } from "./offline-html-adapter.js";

export interface OutputFormulaAsset {
  formulaReferenceKey: string;
  contentHash: string;
  mimeType: "image/png";
  width: number;
  height: number;
  bytes: Uint8Array;
}

export interface DocxGeneration {
  status: OutputResultStatus;
  bytes: Uint8Array | null;
  diagnostics: Diagnostic[];
  usedReferenceKeys: string[];
  omittedReferenceKeys: string[];
}

interface RenderState {
  resources: ReadonlyMap<string, OutputResourceAsset>;
  formulas: ReadonlyMap<string, OutputFormulaAsset>;
}

interface TextStyle {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  code?: boolean;
}

const DOCX_MIME_TYPES = new Map<string, "png" | "jpg" | "gif">([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
]);

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function formulaReferenceKey(node: DocumentNode): string {
  const latex = typeof node.attributes.latex === "string" ? node.attributes.latex : "";
  const latexHash = createHash("sha256").update(latex).digest("hex");
  const displayMode = node.type === "formulaBlock" || node.attributes.displayMode === true ? "display" : "inline";
  return `${node.source.from}:${node.source.to}:${latexHash}:${displayMode}`;
}

function diagnostic(context: OutputContext, code: string, message: string, referenceKey?: string, node?: DocumentNode): Diagnostic {
  return {
    id: `diagnostic-${context.jobId}-${referenceKey ?? node?.id ?? "docx"}-${code}`,
    code,
    severity: "blocking",
    category: code.includes("FORMULA") || code.includes("FORMAT") ? "compatibility" : "resource",
    message,
    outputTarget: context.target,
    ...(referenceKey ? { referenceKey } : {}),
    ...(node ? { nodeId: node.id, source: node.source } : {}),
  };
}

function stringAttribute(node: DocumentNode, name: string): string {
  const value = node.attributes[name];
  return typeof value === "string" ? value : "";
}

function fit(width: number, height: number, maxWidth: number, maxHeight: number): { width: number; height: number } {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function imageRun(node: DocumentNode, state: RenderState): ImageRun | undefined {
  const referenceKey = stringAttribute(node, "referenceKey");
  const asset = state.resources.get(referenceKey);
  const type = asset ? DOCX_MIME_TYPES.get(asset.mimeType) : undefined;
  if (!asset || !type) return undefined;
  const sourceWidth = (asset.width ?? Number(node.attributes.width)) || 0;
  const sourceHeight = (asset.height ?? Number(node.attributes.height)) || 0;
  const dimensions = fit(sourceWidth > 0 ? sourceWidth : 800, sourceHeight > 0 ? sourceHeight : 600, 600, 760);
  return new ImageRun({
    type,
    data: asset.bytes,
    transformation: dimensions,
    altText: {
      title: stringAttribute(node, "title") || stringAttribute(node, "alt") || "图片",
      description: stringAttribute(node, "alt") || "Markdown 图片",
      name: `fantastic-editor-${referenceKey.slice(0, 12)}`,
    },
  });
}

function formulaImageRun(node: DocumentNode, state: RenderState): ImageRun | undefined {
  const asset = state.formulas.get(formulaReferenceKey(node));
  if (!asset) return undefined;
  const dimensions = fit(asset.width, asset.height, node.type === "formulaBlock" ? 600 : 420, 480);
  return new ImageRun({
    type: "png",
    data: asset.bytes,
    transformation: dimensions,
    altText: { title: "数学公式", description: "由 Markdown LaTeX 公式渲染", name: `fantastic-formula-${asset.formulaReferenceKey.slice(0, 12)}` },
  });
}

function textRun(value: string, style: TextStyle): TextRun {
  return new TextRun({
    text: value,
    font: style.code ? "Consolas" : "Microsoft YaHei",
    ...(style.bold ? { bold: true } : {}),
    ...(style.italics ? { italics: true } : {}),
    ...(style.strike ? { strike: true } : {}),
    ...(style.code ? { shading: { fill: "EEF1ED" } } : {}),
  });
}

function renderInline(nodes: readonly DocumentNode[], state: RenderState, inherited: TextStyle = {}): ParagraphChild[] {
  const children: ParagraphChild[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "text": children.push(textRun(stringAttribute(node, "value"), inherited)); break;
      case "softBreak": children.push(textRun(" ", inherited)); break;
      case "hardBreak": children.push(new TextRun({ break: 1 })); break;
      case "strong": children.push(...renderInline(node.children ?? [], state, { ...inherited, bold: true })); break;
      case "emphasis": children.push(...renderInline(node.children ?? [], state, { ...inherited, italics: true })); break;
      case "strikethrough": children.push(...renderInline(node.children ?? [], state, { ...inherited, strike: true })); break;
      case "inlineCode": children.push(textRun(stringAttribute(node, "value"), { ...inherited, code: true })); break;
      case "link": {
        const href = stringAttribute(node, "href");
        const content = renderInline(node.children ?? [], state, inherited);
        if (/^https?:\/\//i.test(href)) children.push(new ExternalHyperlink({ link: href, children: content }));
        else children.push(...content);
        break;
      }
      case "image": {
        const image = imageRun(node, state);
        if (image) children.push(image);
        break;
      }
      case "formulaInline": {
        const formula = formulaImageRun(node, state);
        if (formula) children.push(formula);
        break;
      }
      default: children.push(...renderInline(node.children ?? [], state, inherited));
    }
  }
  return children;
}

function headingLevel(level: number): (typeof HeadingLevel)[keyof typeof HeadingLevel] {
  return [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6][Math.max(0, Math.min(5, level - 1))]!;
}

function collectTableRows(nodes: readonly DocumentNode[]): DocumentNode[] {
  return nodes.flatMap((node) => node.type === "tableRow" ? [node] : collectTableRows(node.children ?? []));
}

function tableFromNode(node: DocumentNode, state: RenderState): Table {
  const rows = collectTableRows(node.children ?? []).map((row) => {
    const cellNodes = (row.children ?? []).filter((cell) => cell.type === "tableCell");
    const isHeader = cellNodes.some((cell) => cell.attributes.header === true);
    return new TableRow({
      tableHeader: isHeader,
      cantSplit: true,
      children: cellNodes.map((cell) => {
        const blocks = renderBlocks(cell.children ?? [], state);
        return new TableCell({
          ...(isHeader ? { shading: { fill: "E6EEE9" } } : {}),
          children: blocks.length > 0 ? blocks : [new Paragraph({ children: renderInline(cell.children ?? [], state) })],
        });
      }),
    });
  });
  return new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: "B8C5BC" },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: "B8C5BC" },
      left: { style: BorderStyle.SINGLE, size: 4, color: "B8C5BC" },
      right: { style: BorderStyle.SINGLE, size: 4, color: "B8C5BC" },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: "D6DDD8" },
      insideVertical: { style: BorderStyle.SINGLE, size: 2, color: "D6DDD8" },
    },
  });
}
function renderList(node: DocumentNode, state: RenderState, ordered: boolean, depth = 0): Array<Paragraph | Table> {
  const result: Array<Paragraph | Table> = [];
  let index = Number(node.attributes.start) || 1;
  for (const item of (node.children ?? []).filter((child) => child.type === "listItem")) {
    const itemChildren = item.children ?? [];
    const paragraph = itemChildren.find((child) => child.type === "paragraph");
    const prefix = ordered ? `${index}. ` : "• ";
    result.push(new Paragraph({
      children: [new TextRun({ text: prefix, bold: ordered }), ...renderInline(paragraph?.children ?? [], state)],
      indent: { left: 360 * (depth + 1), hanging: 240 },
      spacing: { after: 80 },
    }));
    index += 1;
    for (const nested of itemChildren.filter((child) => child.type === "bulletList" || child.type === "orderedList")) {
      result.push(...renderList(nested, state, nested.type === "orderedList", depth + 1));
    }
  }
  return result;
}

function renderBlocks(nodes: readonly DocumentNode[], state: RenderState): Array<Paragraph | Table> {
  const output: Array<Paragraph | Table> = [];
  for (const node of nodes) {
    switch (node.type) {
      case "heading": output.push(new Paragraph({ heading: headingLevel(Number(node.attributes.level) || 1), children: renderInline(node.children ?? [], state), spacing: { before: 180, after: 100 } })); break;
      case "paragraph": output.push(new Paragraph({ children: renderInline(node.children ?? [], state), spacing: { after: 120, line: 360 } })); break;
      case "blockquote": {
        for (const block of renderBlocks(node.children ?? [], state)) {
          if (block instanceof Paragraph) output.push(new Paragraph({ children: [new TextRun({ text: "│ ", color: "6F8B7A" }), ...renderInline(node.children ?? [], state)], indent: { left: 360 }, spacing: { after: 100 } }));
          else output.push(block);
        }
        break;
      }
      case "bulletList": output.push(...renderList(node, state, false)); break;
      case "orderedList": output.push(...renderList(node, state, true)); break;
      case "codeBlock": output.push(new Paragraph({ children: [new TextRun({ text: stringAttribute(node, "value"), font: "Consolas", size: 19 })], shading: { fill: "F1F3F0" }, spacing: { before: 80, after: 140 }, indent: { left: 180, right: 180 } })); break;
      case "table": output.push(tableFromNode(node, state)); break;
      case "thematicBreak": output.push(new Paragraph({ thematicBreak: true })); break;
      case "formulaBlock": {
        const formula = formulaImageRun(node, state);
        output.push(new Paragraph({ alignment: AlignmentType.CENTER, children: formula ? [formula] : [], spacing: { before: 100, after: 140 } }));
        break;
      }
      case "image": {
        const image = imageRun(node, state);
        output.push(new Paragraph({ alignment: AlignmentType.CENTER, children: image ? [image] : [] }));
        break;
      }
      case "rawHtmlBlock":
      case "rawHtmlInline": output.push(new Paragraph({ children: [new TextRun({ text: "[原始 HTML 已阻止]", color: "9A5B32" })] })); break;
      default: output.push(...renderBlocks(node.children ?? [], state));
    }
  }
  return output;
}

function collectFormulaNodes(nodes: readonly DocumentNode[]): DocumentNode[] {
  const result: DocumentNode[] = [];
  const visit = (items: readonly DocumentNode[]) => {
    for (const node of items) {
      if (node.type === "formulaInline" || node.type === "formulaBlock") result.push(node);
      if (node.children) visit(node.children);
    }
  };
  visit(nodes);
  return result;
}

export async function generateDocx(
  context: OutputContext,
  assets: readonly OutputResourceAsset[],
  formulaAssets: readonly OutputFormulaAsset[],
): Promise<DocxGeneration> {
  const diagnostics: Diagnostic[] = [];
  const usedReferenceKeys: string[] = [];
  const omittedReferenceKeys: string[] = [];
  if (context.target !== "docx") {
    return { status: "failed", bytes: null, diagnostics: [diagnostic(context, "OUTPUT_TARGET_MISMATCH", "DOCX 适配器收到错误目标。")], usedReferenceKeys, omittedReferenceKeys };
  }
  const approved = new Set(context.approvedOmittedReferenceKeys);
  const resources = new Map(assets.map((asset) => [asset.referenceKey, asset]));
  for (const reference of context.parsedDocument.resourceReferences) {
    const record = context.resolutionSnapshot.records[reference.referenceKey];
    if (!record) {
      diagnostics.push(diagnostic(context, "OUTPUT_RESOURCE_RECORD_MISSING", "DOCX 资源记录缺失。", reference.referenceKey));
      continue;
    }
    if (record.state !== "resolved") {
      if (approved.has(reference.referenceKey)) omittedReferenceKeys.push(reference.referenceKey);
      else diagnostics.push(diagnostic(context, "OUTPUT_UNAPPROVED_OMISSION", "资源不可用且未获本次任务省略批准。", reference.referenceKey));
      continue;
    }
    const asset = resources.get(reference.referenceKey);
    if (!asset || asset.sourceContentHash !== record.contentHash || sha256(asset.bytes) !== asset.contentHash || asset.bytes.byteLength === 0) {
      diagnostics.push(diagnostic(context, "OUTPUT_RESOURCE_PACKAGE_INVALID", "DOCX 图片资源包无效。", reference.referenceKey));
      continue;
    }
    if (!DOCX_MIME_TYPES.has(asset.mimeType)) {
      diagnostics.push(diagnostic(context, "DOCX_IMAGE_FORMAT_UNSUPPORTED", "该图片格式尚未转换为 DOCX 支持的 PNG/JPEG/GIF。", reference.referenceKey));
      continue;
    }
    usedReferenceKeys.push(reference.referenceKey);
  }
  const formulaMap = new Map(formulaAssets.map((asset) => [asset.formulaReferenceKey, asset]));
  for (const node of collectFormulaNodes(context.parsedDocument.children)) {
    const key = formulaReferenceKey(node);
    const asset = formulaMap.get(key);
    if (!asset || asset.mimeType !== "image/png" || asset.width <= 0 || asset.height <= 0 || sha256(asset.bytes) !== asset.contentHash) {
      diagnostics.push(diagnostic(context, "FORMULA_DERIVED_ASSET_MISSING", "DOCX 公式 PNG 派生资源缺失或无效。", undefined, node));
    }
  }
  const omitted = [...new Set(omittedReferenceKeys)].sort();
  const consumed = [...approved].sort();
  if (omitted.length !== consumed.length || omitted.some((value, index) => value !== consumed[index])) {
    diagnostics.push(diagnostic(context, "OUTPUT_APPROVAL_CONSUMPTION_MISMATCH", "实际省略集合与本次批准集合不一致。"));
  }
  if (diagnostics.some((item) => item.severity === "blocking")) {
    return { status: "failed", bytes: null, diagnostics, usedReferenceKeys, omittedReferenceKeys: omitted };
  }
  try {
    const document = new Document({
      creator: "fantastic-editor",
      title: "fantastic-editor 导出",
      description: "由 fantastic-editor 从本地 Markdown 生成",
      sections: [{
        properties: { page: { margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 } } },
        children: renderBlocks(context.parsedDocument.children, { resources, formulas: formulaMap }),
      }],
    });
    const buffer = await Packer.toBuffer(document);
    return {
      status: omitted.length > 0 ? "completed-with-omissions" : "completed",
      bytes: new Uint8Array(buffer),
      diagnostics,
      usedReferenceKeys: [...new Set(usedReferenceKeys)].sort(),
      omittedReferenceKeys: omitted,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 300) : "未知错误";
    diagnostics.push(diagnostic(context, "DOCX_GENERATION_FAILED", `DOCX 打包失败：${detail}`));
    return { status: "failed", bytes: null, diagnostics, usedReferenceKeys, omittedReferenceKeys: omitted };
  }
}