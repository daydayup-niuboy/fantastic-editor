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
  LevelFormat,
  Packer,
  PageOrientation,
  Paragraph,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
  type INumberingOptions,
  type ParagraphChild,
} from "docx";
import type { OutputResourceAsset } from "./offline-html-adapter.js";
import { collectMermaidNodes, isMermaidNode, mermaidReferenceKey, type OutputMermaidAsset } from "./mermaid-assets.js";

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
  mermaids: ReadonlyMap<string, OutputMermaidAsset>;
  fontFamily: string;
  numberingConfigs: Array<INumberingOptions["config"][number]>;
  nextListId: number;
}

interface TextStyle {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  code?: boolean;
}

const DOCX_PAGE_WIDTH_DXA = 11_906;
const DOCX_PAGE_HEIGHT_DXA = 16_838;
const DOCX_MARGIN_DXA = 1_134;
const DOCX_CONTENT_WIDTH_DXA = DOCX_PAGE_WIDTH_DXA - DOCX_MARGIN_DXA * 2;

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

function diagramImageRun(node: DocumentNode, state: RenderState): ImageRun | undefined {
  const asset = state.mermaids.get(mermaidReferenceKey(node));
  if (!asset) return undefined;
  const dimensions = fit(asset.width, asset.height, 600, 760);
  return new ImageRun({
    type: "png",
    data: asset.bytes,
    transformation: dimensions,
    altText: { title: "Mermaid 流程图", description: "由 Mermaid 代码块渲染", name: `fantastic-mermaid-${asset.mermaidReferenceKey.slice(0, 12)}` },
  });
}

function textRun(value: string, style: TextStyle, fontFamily: string): TextRun {
  return new TextRun({
    text: value,
    font: style.code ? "Consolas" : fontFamily,
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
      case "text": children.push(textRun(stringAttribute(node, "value"), inherited, state.fontFamily)); break;
      case "softBreak": children.push(textRun(" ", inherited, state.fontFamily)); break;
      case "hardBreak": children.push(new TextRun({ break: 1 })); break;
      case "strong": children.push(...renderInline(node.children ?? [], state, { ...inherited, bold: true })); break;
      case "emphasis": children.push(...renderInline(node.children ?? [], state, { ...inherited, italics: true })); break;
      case "strikethrough": children.push(...renderInline(node.children ?? [], state, { ...inherited, strike: true })); break;
      case "inlineCode": children.push(textRun(stringAttribute(node, "value"), { ...inherited, code: true }, state.fontFamily)); break;
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

function plainText(nodes: readonly DocumentNode[]): string {
  let value = "";
  for (const node of nodes) {
    if (node.type === "text" || node.type === "inlineCode") value += stringAttribute(node, "value");
    else if (node.type === "image") value += stringAttribute(node, "alt") || "图片";
    else if (node.type === "formulaInline" || node.type === "formulaBlock") value += stringAttribute(node, "latex");
    else value += plainText(node.children ?? []);
  }
  return value;
}

function tableColumnWidths(rows: readonly DocumentNode[], columnCount: number): number[] {
  if (columnCount <= 0) return [];
  const weights = Array.from({ length: columnCount }, () => 4);
  for (const row of rows) {
    const cells = (row.children ?? []).filter((cell) => cell.type === "tableCell");
    cells.forEach((cell, index) => {
      if (index >= columnCount) return;
      const text = plainText(cell.children ?? []);
      const weightedLength = Array.from(text).reduce((sum, character) => sum + (character.charCodeAt(0) > 0xff ? 2 : 1), 0);
      weights[index] = Math.max(weights[index]!, Math.min(48, weightedLength || 4));
    });
  }
  const minimum = Math.max(360, Math.floor(DOCX_CONTENT_WIDTH_DXA * 0.35 / columnCount));
  const distributable = DOCX_CONTENT_WIDTH_DXA - minimum * columnCount;
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const widths = weights.map((weight) => minimum + Math.floor(distributable * weight / totalWeight));
  widths[widths.length - 1] = widths[widths.length - 1]! + DOCX_CONTENT_WIDTH_DXA - widths.reduce((sum, value) => sum + value, 0);
  return widths;
}

function tableAlignment(value: unknown): (typeof AlignmentType)[keyof typeof AlignmentType] {
  return value === "center" ? AlignmentType.CENTER : value === "right" ? AlignmentType.RIGHT : AlignmentType.LEFT;
}

function tableFromNode(node: DocumentNode, state: RenderState): Table {
  const sourceRows = collectTableRows(node.children ?? []);
  const columnCount = Math.max(1, ...sourceRows.map((row) => (row.children ?? []).filter((cell) => cell.type === "tableCell").length));
  const columnWidths = tableColumnWidths(sourceRows, columnCount);
  const alignments = Array.isArray(node.attributes.alignments) ? node.attributes.alignments : [];
  const rows = sourceRows.map((row) => {
    const cellNodes = (row.children ?? []).filter((cell) => cell.type === "tableCell");
    const isHeader = cellNodes.some((cell) => cell.attributes.header === true);
    return new TableRow({
      tableHeader: isHeader,
      cantSplit: true,
      children: Array.from({ length: columnCount }, (_, index) => {
        const cell = cellNodes[index];
        const content = cell ? renderInline(cell.children ?? [], state, isHeader ? { bold: true } : {}) : [];
        return new TableCell({
          width: { size: columnWidths[index]!, type: WidthType.DXA },
          verticalAlign: VerticalAlign.CENTER,
          margins: { top: 100, right: 120, bottom: 100, left: 120 },
          ...(isHeader ? { shading: { fill: "E6EEE9" } } : {}),
          children: [new Paragraph({
            children: content,
            alignment: tableAlignment(alignments[index]),
            spacing: { after: 0, line: 300 },
            widowControl: true,
          })],
        });
      }),
    });
  });
  return new Table({
    rows,
    width: { size: DOCX_CONTENT_WIDTH_DXA, type: WidthType.DXA },
    columnWidths,
    indent: { size: 0, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    margins: { top: 100, right: 120, bottom: 100, left: 120 },
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

function addListNumbering(state: RenderState, kind: "ordered" | "bullet" | "task-checked" | "task-unchecked", depth: number, start: number): string {
  const reference = "fantastic-" + kind + "-" + state.nextListId++;
  const bulletSymbols = ["•", "◦", "▪"];
  const levels: INumberingOptions["config"][number]["levels"] = Array.from({ length: 9 }, (_, level) => {
    const task = kind === "task-checked" || kind === "task-unchecked";
    const ordered = kind === "ordered";
    return {
      level,
      format: ordered ? LevelFormat.DECIMAL : LevelFormat.BULLET,
      text: ordered ? "%" + (level + 1) + "." : task ? (kind === "task-checked" ? "☒" : "☐") : bulletSymbols[level % bulletSymbols.length]!,
      alignment: AlignmentType.LEFT,
      start: ordered && level === Math.min(depth, 8) ? Math.max(1, start) : 1,
      style: {
        run: { font: state.fontFamily },
        paragraph: { indent: { left: 720 + level * 360, hanging: 360 } },
      },
    };
  });
  state.numberingConfigs.push({ reference, levels });
  return reference;
}

function renderList(node: DocumentNode, state: RenderState, ordered: boolean, depth = 0): Array<Paragraph | Table> {
  const result: Array<Paragraph | Table> = [];
  const level = Math.min(depth, 8);
  const listReference = addListNumbering(state, ordered ? "ordered" : "bullet", level, Number(node.attributes.start) || 1);
  for (const item of (node.children ?? []).filter((child) => child.type === "listItem" || child.type === "taskItem")) {
    const itemChildren = item.children ?? [];
    const paragraph = itemChildren.find((child) => child.type === "paragraph");
    const taskReference = item.type === "taskItem"
      ? addListNumbering(state, item.attributes.checked === true ? "task-checked" : "task-unchecked", level, 1)
      : listReference;
    result.push(new Paragraph({
      children: renderInline(paragraph?.children ?? [], state),
      numbering: { reference: taskReference, level },
      spacing: { after: 80, line: 330 },
      widowControl: true,
    }));
    for (const extra of itemChildren.filter((child) => child !== paragraph && child.type !== "bulletList" && child.type !== "orderedList")) {
      result.push(...renderBlocks([extra], state));
    }
    for (const nested of itemChildren.filter((child) => child.type === "bulletList" || child.type === "orderedList")) {
      result.push(...renderList(nested, state, nested.type === "orderedList", depth + 1));
    }
  }
  return result;
}
function codeRuns(value: string): TextRun[] {
  return value.split("\n").map((line, index) => new TextRun({
    text: line.length > 0 ? line : " ",
    font: "Consolas",
    size: 19,
    ...(index > 0 ? { break: 1 } : {}),
  }));
}

function renderBlocks(nodes: readonly DocumentNode[], state: RenderState): Array<Paragraph | Table> {
  const output: Array<Paragraph | Table> = [];
  for (const node of nodes) {
    switch (node.type) {
      case "heading":
        output.push(new Paragraph({
          heading: headingLevel(Number(node.attributes.level) || 1),
          children: renderInline(node.children ?? [], state),
          spacing: { before: 220, after: 100 },
          keepNext: true,
          keepLines: true,
          widowControl: true,
        }));
        break;
      case "paragraph":
        output.push(new Paragraph({
          children: renderInline(node.children ?? [], state),
          spacing: { after: 120, line: 360 },
          widowControl: true,
        }));
        break;
      case "blockquote":
        for (const child of node.children ?? []) {
          if (child.type === "paragraph") {
            output.push(new Paragraph({
              children: renderInline(child.children ?? [], state),
              border: { left: { style: BorderStyle.SINGLE, size: 12, color: "86A594", space: 10 } },
              indent: { left: 360, right: 180 },
              spacing: { after: 100, line: 340 },
              widowControl: true,
            }));
          } else {
            output.push(...renderBlocks([child], state));
          }
        }
        break;
      case "bulletList":
        output.push(...renderList(node, state, false));
        break;
      case "orderedList":
        output.push(...renderList(node, state, true));
        break;
      case "codeBlock": {
        if (isMermaidNode(node)) {
          const diagram = diagramImageRun(node, state);
          output.push(new Paragraph({
            alignment: AlignmentType.CENTER,
            children: diagram ? [diagram] : [],
            spacing: { before: 100, after: 140 },
            keepLines: true,
          }));
        } else {
          output.push(new Paragraph({
            children: codeRuns(stringAttribute(node, "value")),
            shading: { fill: "F1F3F0" },
            spacing: { before: 80, after: 140, line: 280 },
            indent: { left: 180, right: 180 },
            widowControl: true,
            wordWrap: true,
          }));
        }
        break;
      }
      case "table":
        output.push(tableFromNode(node, state));
        break;
      case "thematicBreak":
        output.push(new Paragraph({ thematicBreak: true, spacing: { before: 100, after: 100 } }));
        break;
      case "formulaBlock": {
        const formula = formulaImageRun(node, state);
        output.push(new Paragraph({
          alignment: AlignmentType.CENTER,
          children: formula ? [formula] : [],
          spacing: { before: 100, after: 140 },
          keepLines: true,
        }));
        break;
      }
      case "image": {
        const image = imageRun(node, state);
        output.push(new Paragraph({
          alignment: AlignmentType.CENTER,
          children: image ? [image] : [],
          spacing: { before: 80, after: 120 },
          keepLines: true,
        }));
        break;
      }
      case "rawHtmlBlock":
      case "rawHtmlInline":
        output.push(new Paragraph({
          children: [new TextRun({ text: "[原始 HTML 已阻止]", color: "9A5B32" })],
          spacing: { after: 100 },
        }));
        break;
      default:
        output.push(...renderBlocks(node.children ?? [], state));
    }
  }
  return output;
}
function docxFontFamily(context: OutputContext): string {
  const value = context.theme.tokens["typography.body.fontFamily"];
  return typeof value === "string" && value.length > 0 && value.length <= 64 && !/[\u0000-\u001f\u007f{};<>]/.test(value)
    ? value.replaceAll('"', "")
    : "Microsoft YaHei";
}

function documentTitle(nodes: readonly DocumentNode[]): string {
  for (const node of nodes) {
    if (node.type === "heading") {
      const title = plainText(node.children ?? []).trim();
      if (title) return title.slice(0, 120);
    }
    const nested = documentTitle(node.children ?? []);
    if (nested !== "fantastic-editor 导出") return nested;
  }
  return "fantastic-editor 导出";
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
  mermaidAssets: readonly OutputMermaidAsset[] = [],
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
  const mermaidMap = new Map(mermaidAssets.map((asset) => [asset.mermaidReferenceKey, asset]));
  for (const node of collectMermaidNodes(context.parsedDocument.children)) {
    const asset = mermaidMap.get(mermaidReferenceKey(node));
    if (!asset || asset.mimeType !== "image/png" || asset.width <= 0 || asset.height <= 0 || sha256(asset.bytes) !== asset.contentHash) {
      diagnostics.push(diagnostic(context, "MERMAID_DERIVED_ASSET_MISSING", "DOCX Mermaid PNG 派生资源缺失或无效。", undefined, node));
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
    const fontFamily = docxFontFamily(context);
    const renderState: RenderState = {
      resources,
      formulas: formulaMap,
      mermaids: mermaidMap,
      fontFamily,
      numberingConfigs: [],
      nextListId: 1,
    };
    const children = renderBlocks(context.parsedDocument.children, renderState);
    const headingStyle = (size: number, color: string) => ({
      run: { font: fontFamily, size, bold: true, color },
      paragraph: { keepNext: true, keepLines: true, spacing: { before: 220, after: 100 } },
    });
    const document = new Document({
      creator: "fantastic-editor",
      title: documentTitle(context.parsedDocument.children),
      description: "由 fantastic-editor 从本地 Markdown 生成",
      styles: {
        default: {
          document: {
            run: { font: fontFamily, size: 22, color: "242A26" },
            paragraph: { spacing: { after: 120, line: 360 } },
          },
          heading1: headingStyle(34, "18382B"),
          heading2: headingStyle(30, "24513E"),
          heading3: headingStyle(27, "315E4B"),
          heading4: headingStyle(24, "3E6857"),
          heading5: headingStyle(22, "4A7262"),
          heading6: headingStyle(22, "567B6C"),
          listParagraph: {
            run: { font: fontFamily, size: 22, color: "242A26" },
            paragraph: { spacing: { after: 80, line: 330 } },
          },
        },
      },
      ...(renderState.numberingConfigs.length > 0 ? { numbering: { config: renderState.numberingConfigs } } : {}),
      sections: [{
        properties: {
          page: {
            size: { width: DOCX_PAGE_WIDTH_DXA, height: DOCX_PAGE_HEIGHT_DXA, orientation: PageOrientation.PORTRAIT },
            margin: {
              top: DOCX_MARGIN_DXA,
              right: DOCX_MARGIN_DXA,
              bottom: DOCX_MARGIN_DXA,
              left: DOCX_MARGIN_DXA,
              header: 567,
              footer: 567,
              gutter: 0,
            },
          },
        },
        children,
      }],
    });    const buffer = await Packer.toBuffer(document);
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
