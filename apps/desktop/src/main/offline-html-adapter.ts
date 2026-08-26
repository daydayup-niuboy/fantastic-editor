import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import katex from "katex";
import { renderParsedDocumentHtml } from "@fantastic-editor/document-core";
import type { Diagnostic, DocumentNode } from "@fantastic-editor/document-core";
import type { OutputContext, OutputResultStatus } from "@fantastic-editor/shared";
import { collectMermaidNodes, mermaidReferenceKey, type OutputMermaidAsset } from "./mermaid-assets.js";

const SOFT_HTML_BYTES = 20 * 1024 * 1024;
const HARD_HTML_BYTES = 50 * 1024 * 1024;
const SUPPORTED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export interface OutputResourceAsset {
  referenceKey: string;
  sourceContentHash: string;
  contentHash: string;
  mimeType: string;
  width?: number;
  height?: number;
  bytes: Uint8Array;
}

export interface OfflineHtmlGeneration {
  status: OutputResultStatus;
  bytes: Uint8Array | null;
  diagnostics: Diagnostic[];
  usedReferenceKeys: string[];
  omittedReferenceKeys: string[];
}

const BASE_STYLE = `
:root{color:#242a26;background:#fff;font-family:"Segoe UI","Microsoft YaHei UI",sans-serif}
body{margin:0}.document{max-width:860px;margin:0 auto;padding:48px 56px 96px;line-height:1.75;overflow-wrap:anywhere}
h1,h2,h3,h4,h5,h6{color:#18382b;line-height:1.3}h1{padding-bottom:.35em;border-bottom:1px solid #dce2dd}
pre{overflow:auto;padding:14px 16px;background:#f2f4f1;border-radius:8px}code{font-family:Consolas,"Cascadia Code",monospace}
blockquote{margin-left:0;padding-left:16px;color:#5f6d64;border-left:4px solid #86a594}table{border-collapse:collapse;max-width:100%}
th,td{padding:7px 10px;border:1px solid #ccd3ce}img{display:block;max-width:100%;height:auto;margin:16px auto}.mermaid-export{break-inside:avoid}
.resource-placeholder,.blocked-raw-html,.unsupported-node{display:inline-block;padding:4px 7px;color:#735c32;background:#faf3df;border:1px dashed #d8c28b;border-radius:4px}
.task-item{list-style:none}.formula-block{overflow-x:auto;text-align:center}.katex{font-size:1.08em}.katex-display{overflow-x:auto;overflow-y:hidden}
@media(max-width:700px){.document{padding:28px 20px 64px}}
@media print{.document{max-width:none;padding:0}.resource-placeholder{break-inside:avoid}}
`;

const require = createRequire(import.meta.url);
let cachedEmbeddedKatexStyle: string | undefined;

function collectFormulaNodes(nodes: readonly DocumentNode[]): DocumentNode[] {
  const formulas: DocumentNode[] = [];
  const visit = (items: readonly DocumentNode[]) => {
    for (const node of items) {
      if (node.type === "formulaInline" || node.type === "formulaBlock") formulas.push(node);
      if (node.children) visit(node.children);
    }
  };
  visit(nodes);
  return formulas;
}

function embeddedKatexStyle(): string {
  if (cachedEmbeddedKatexStyle) return cachedEmbeddedKatexStyle;
  const cssPath = require.resolve("katex/dist/katex.min.css");
  const fontDirectory = join(dirname(cssPath), "fonts");
  let embeddedFonts = 0;
  const css = readFileSync(cssPath, "utf8").replace(
    /src:url\(fonts\/([A-Za-z0-9_-]+\.woff2)\) format\("woff2"\),url\(fonts\/[A-Za-z0-9_.-]+\.woff\) format\("woff"\),url\(fonts\/[A-Za-z0-9_.-]+\.ttf\) format\("truetype"\)/g,
    (_declaration, fontName: string) => {
      const bytes = readFileSync(join(fontDirectory, fontName));
      embeddedFonts += 1;
      return `src:url(data:font/woff2;base64,${bytes.toString("base64")}) format("woff2")`;
    },
  );
  if (embeddedFonts !== 20 || css.includes("url(fonts/")) {
    throw new Error("KaTeX 字体清单不完整，无法生成自包含公式样式。");
  }
  cachedEmbeddedKatexStyle = css;
  return css;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function diagnostic(context: OutputContext, code: string, message: string, referenceKey?: string): Diagnostic {
  return {
    id: `diagnostic-${context.jobId}-${referenceKey ?? "output"}-${code}`,
    code,
    severity: code === "OFFLINE_HTML_SOFT_LIMIT_WARNING" ? "warning" : "blocking",
    category: code.includes("RESOURCE") ? "resource" : code.includes("LIMIT") ? "performance" : "export",
    message,
    outputTarget: context.target,
    ...(referenceKey ? { referenceKey } : {}),
  };
}

function outputFontStack(context: OutputContext): string {
  const value = context.theme.tokens["typography.body.fontFamily"];
  const font = typeof value === "string" && value.length <= 64 && !/[\u0000-\u001f\u007f{};<>]/.test(value) ? value.replaceAll('"', "") : "Microsoft YaHei UI";
  return `"${font}","Segoe UI",sans-serif`;
}

function htmlDocument(content: string, locale: string, formulaStyle: string, fontFamily: string): string {
  return `<!doctype html>\n<html lang="${locale.replace(/[^A-Za-z0-9_-]/g, "") || "zh-CN"}">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">\n<title>fantastic-editor 导出</title>\n<style>${formulaStyle}${BASE_STYLE}:root{font-family:${fontFamily}}</style>\n</head>\n<body><article class="document">${content}</article></body>\n</html>\n`;
}

export function generateOfflineHtml(
  context: OutputContext,
  assets: readonly OutputResourceAsset[],
  mermaidAssets: readonly OutputMermaidAsset[] = [],
): OfflineHtmlGeneration {
  if (context.target !== "offline-html" && context.target !== "pdf") {
    return { status: "failed", bytes: null, diagnostics: [diagnostic(context, "OUTPUT_TARGET_MISMATCH", "静态 HTML 适配器收到错误目标。")], usedReferenceKeys: [], omittedReferenceKeys: [] };
  }
  const approved = new Set(context.approvedOmittedReferenceKeys);
  const resources = new Map(assets.map((asset) => [asset.referenceKey, asset]));
  const imageSources: Record<string, string> = {};
  const usedReferenceKeys: string[] = [];
  const omittedReferenceKeys: string[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const reference of context.parsedDocument.resourceReferences) {
    const record = context.resolutionSnapshot.records[reference.referenceKey];
    if (!record) {
      diagnostics.push(diagnostic(context, "OUTPUT_RESOURCE_RECORD_MISSING", "导出资源记录缺失。", reference.referenceKey));
      continue;
    }
    if (record.state !== "resolved") {
      if (approved.has(reference.referenceKey)) omittedReferenceKeys.push(reference.referenceKey);
      else diagnostics.push(diagnostic(context, "OUTPUT_UNAPPROVED_OMISSION", "资源不可用且未获本次任务省略批准。", reference.referenceKey));
      continue;
    }
    const asset = resources.get(reference.referenceKey);
    if (
      !asset
      || asset.sourceContentHash !== record.contentHash
      || !SUPPORTED_MIME_TYPES.has(asset.mimeType)
      || asset.bytes.byteLength === 0
      || !/^[a-f\d]{64}$/i.test(asset.contentHash)
      || sha256(asset.bytes) !== asset.contentHash
    ) {
      diagnostics.push(diagnostic(context, "OUTPUT_RESOURCE_PACKAGE_INVALID", "已解析资源缺少有效导出字节。", reference.referenceKey));
      continue;
    }
    imageSources[reference.referenceKey] = `data:${asset.mimeType};base64,${Buffer.from(asset.bytes).toString("base64")}`;
    usedReferenceKeys.push(reference.referenceKey);
  }

  const mermaidMap = new Map(mermaidAssets.map((asset) => [asset.mermaidReferenceKey, asset]));
  for (const node of collectMermaidNodes(context.parsedDocument.children)) {
    const asset = mermaidMap.get(mermaidReferenceKey(node));
    if (!asset || asset.mimeType !== "image/png" || asset.width <= 0 || asset.height <= 0 || asset.bytes.byteLength === 0 || sha256(asset.bytes) !== asset.contentHash) {
      diagnostics.push({ ...diagnostic(context, "MERMAID_DERIVED_ASSET_MISSING", "Mermaid 流程图 PNG 派生资源缺失或无效。"), source: node.source, nodeId: node.id });
    }
  }

  if (diagnostics.some((item) => item.severity === "blocking")) {
    return { status: "failed", bytes: null, diagnostics, usedReferenceKeys, omittedReferenceKeys };
  }
  const formulas = collectFormulaNodes(context.parsedDocument.children);
  for (const formula of formulas) {
    const latex = typeof formula.attributes.latex === "string" ? formula.attributes.latex : "";
    try {
      katex.renderToString(latex, {
        displayMode: formula.type === "formulaBlock" || formula.attributes.displayMode === true,
        throwOnError: true,
        strict: "error",
        output: "htmlAndMathml",
        trust: false,
      });
    } catch {
      diagnostics.push({
        ...diagnostic(context, "FORMULA_RENDER_FAILED", "公式无法由当前 KaTeX 配置安全渲染。"),
        source: formula.source,
        nodeId: formula.id,
      });
    }
  }
  if (diagnostics.some((item) => item.severity === "blocking")) {
    return { status: "failed", bytes: null, diagnostics, usedReferenceKeys, omittedReferenceKeys };
  }
  let formulaStyle = "";
  if (formulas.length > 0) {
    try {
      formulaStyle = embeddedKatexStyle();
    } catch {
      diagnostics.push(diagnostic(context, "OFFLINE_HTML_KATEX_ASSETS_UNAVAILABLE", "无法加载自包含 KaTeX 字体和样式。"));
      return { status: "failed", bytes: null, diagnostics, usedReferenceKeys, omittedReferenceKeys };
    }
  }
  const fragment = renderParsedDocumentHtml(context.parsedDocument, {
    imageSources,
    renderCodeBlock: (node) => {
      if (typeof node.attributes.language !== "string" || node.attributes.language.toLowerCase() !== "mermaid") return undefined;
      const asset = mermaidMap.get(mermaidReferenceKey(node))!;
      return `<img class="mermaid-export" src="data:image/png;base64,${Buffer.from(asset.bytes).toString("base64")}" alt="Mermaid 流程图">`;
    },
  });
  const bytes = new TextEncoder().encode(htmlDocument(fragment, context.locale, formulaStyle, outputFontStack(context)));
  if (bytes.byteLength > HARD_HTML_BYTES) {
    diagnostics.push(diagnostic(context, "OFFLINE_HTML_HARD_LIMIT_EXCEEDED", "单文件离线 HTML 超过 50 MiB 硬上限，请压缩图片后重试。"));
    return { status: "failed", bytes: null, diagnostics, usedReferenceKeys, omittedReferenceKeys };
  }
  if (bytes.byteLength > SOFT_HTML_BYTES) {
    diagnostics.push(diagnostic(context, "OFFLINE_HTML_SOFT_LIMIT_WARNING", "单文件离线 HTML 超过 20 MiB，部分浏览器打开时可能占用较多内存。"));
  }
  const omitted = [...new Set(omittedReferenceKeys)].sort();
  const consumedApproval = [...approved].sort();
  if (omitted.length !== consumedApproval.length || omitted.some((key, index) => key !== consumedApproval[index])) {
    diagnostics.push(diagnostic(context, "OUTPUT_APPROVAL_CONSUMPTION_MISMATCH", "实际省略集合与本次批准集合不一致。"));
    return { status: "failed", bytes: null, diagnostics, usedReferenceKeys, omittedReferenceKeys: omitted };
  }
  return {
    status: omitted.length > 0 ? "completed-with-omissions" : "completed",
    bytes,
    diagnostics,
    usedReferenceKeys: [...new Set(usedReferenceKeys)].sort(),
    omittedReferenceKeys: omitted,
  };
}
