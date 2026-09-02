import { createHash } from "node:crypto";
import { renderParsedDocumentHtml, type Diagnostic, type DocumentNode, type ParsedDocument } from "@fantastic-editor/document-core";
import { compileWechatPublishHtml, resolveWechatTheme, type OutputContext, type OutputResultStatus, type WechatReplacementItem } from "@fantastic-editor/shared";
import { formulaReferenceKey, type OutputFormulaAsset } from "./docx-adapter.js";
import type { OutputResourceAsset } from "./offline-html-adapter.js";
import { collectMermaidNodes, mermaidReferenceKey, type OutputMermaidAsset } from "./mermaid-assets.js";
import { auditWechatHtmlMarkup } from "./wechat-html-security.js";

const WECHAT_HTML_HARD_LIMIT = 5 * 1024 * 1024;
const SUPPORTED_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export interface WechatReplacementBinding extends WechatReplacementItem {
  sourceKey: string;
}

export interface WechatGeneration {
  status: OutputResultStatus;
  bytes: Uint8Array | null;
  diagnostics: Diagnostic[];
  usedReferenceKeys: string[];
  omittedReferenceKeys: string[];
  replacementItems?: WechatReplacementBinding[];
  suggestedTitle?: string;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function diagnostic(context: OutputContext, code: string, message: string, referenceKey?: string, node?: DocumentNode): Diagnostic {
  return {
    id: `diagnostic-${context.jobId}-${referenceKey ?? node?.id ?? "wechat"}-${code}`,
    code,
    severity: "blocking",
    category: code.includes("FORMULA") || code.includes("HTML") ? "compatibility" : "resource",
    message,
    outputTarget: context.target,
    ...(referenceKey ? { referenceKey } : {}),
    ...(node ? { nodeId: node.id, source: node.source } : {}),
  };
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

function stringAttribute(node: DocumentNode, name: string): string {
  const value = node.attributes[name];
  return typeof value === "string" ? value : "";
}

function plainText(node: DocumentNode): string {
  if (node.type === "text" || node.type === "inlineCode") return stringAttribute(node, "value");
  if (node.type === "formulaInline") return stringAttribute(node, "latex");
  return (node.children ?? []).map(plainText).join("");
}

function withoutLeadingTitle(document: ParsedDocument): { document: ParsedDocument; suggestedTitle?: string } {
  const first = document.children[0];
  if (!first || first.type !== "heading" || Number(first.attributes.level) !== 1) return { document };
  const suggestedTitle = plainText(first).replace(/\s+/g, " ").trim().slice(0, 120);
  return {
    document: { ...document, children: document.children.slice(1) },
    ...(suggestedTitle ? { suggestedTitle } : {}),
  };
}

function stripUnsupportedPresentationAttributes(fragment: string): string {
  return fragment.replace(/\s+(?:class|id|data-[a-z0-9_-]+)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
}

export function generateWechatHtml(
  context: OutputContext,
  assets: readonly OutputResourceAsset[],
  formulaAssets: readonly OutputFormulaAsset[],
  mermaidAssets: readonly OutputMermaidAsset[] = [],
): WechatGeneration {
  if (context.target !== "wechat-html" && context.target !== "wechat-clipboard") {
    return { status: "failed", bytes: null, diagnostics: [diagnostic(context, "OUTPUT_TARGET_MISMATCH", "公众号适配器收到错误目标。")], usedReferenceKeys: [], omittedReferenceKeys: [] };
  }
  const approved = new Set(context.approvedOmittedReferenceKeys);
  const resources = new Map(assets.map((asset) => [asset.referenceKey, asset]));
  const formulas = new Map(formulaAssets.map((asset) => [asset.formulaReferenceKey, asset]));
  const diagnostics: Diagnostic[] = [];
  const usedReferenceKeys: string[] = [];
  const omittedReferenceKeys: string[] = [];

  for (const reference of context.parsedDocument.resourceReferences) {
    const record = context.resolutionSnapshot.records[reference.referenceKey];
    if (!record) {
      diagnostics.push(diagnostic(context, "OUTPUT_RESOURCE_RECORD_MISSING", "公众号图片资源记录缺失。", reference.referenceKey));
      continue;
    }
    if (record.state !== "resolved") {
      if (approved.has(reference.referenceKey)) omittedReferenceKeys.push(reference.referenceKey);
      else diagnostics.push(diagnostic(context, "OUTPUT_UNAPPROVED_OMISSION", "公众号图片不可用且未获本次任务省略批准。", reference.referenceKey));
      continue;
    }
    const asset = resources.get(reference.referenceKey);
    if (!asset || asset.sourceContentHash !== record.contentHash || !SUPPORTED_IMAGE_MIME.has(asset.mimeType) || asset.bytes.byteLength === 0 || sha256(asset.bytes) !== asset.contentHash) {
      diagnostics.push(diagnostic(context, "OUTPUT_RESOURCE_PACKAGE_INVALID", "公众号替换助手缺少有效图片字节。", reference.referenceKey));
      continue;
    }
    usedReferenceKeys.push(reference.referenceKey);
  }

  for (const node of collectFormulaNodes(context.parsedDocument.children)) {
    const asset = formulas.get(formulaReferenceKey(node));
    if (!asset || asset.mimeType !== "image/png" || asset.width <= 0 || asset.height <= 0 || asset.bytes.byteLength === 0 || sha256(asset.bytes) !== asset.contentHash) {
      diagnostics.push(diagnostic(context, "FORMULA_DERIVED_ASSET_MISSING", "公众号公式替换图片缺失或无效。", undefined, node));
    }
  }
  const mermaids = new Map(mermaidAssets.map((asset) => [asset.mermaidReferenceKey, asset]));
  for (const node of collectMermaidNodes(context.parsedDocument.children)) {
    const asset = mermaids.get(mermaidReferenceKey(node));
    if (!asset || asset.mimeType !== "image/png" || asset.width <= 0 || asset.height <= 0 || asset.bytes.byteLength === 0 || sha256(asset.bytes) !== asset.contentHash) {
      diagnostics.push(diagnostic(context, "MERMAID_DERIVED_ASSET_MISSING", "公众号 Mermaid 流程图替换图片缺失或无效。", undefined, node));
    }
  }
  if (diagnostics.some((item) => item.severity === "blocking")) {
    return { status: "failed", bytes: null, diagnostics, usedReferenceKeys, omittedReferenceKeys };
  }

  let sequence = 0;
  const replacementItems: WechatReplacementBinding[] = [];
  const placeholder = (
    kind: "image" | "formula" | "diagram",
    description: string,
    node: DocumentNode,
    sourceKey: string,
    mimeType: string,
    width: number | null,
    height: number | null,
  ) => {
    sequence += 1;
    const number = String(sequence).padStart(2, "0");
    const label = description.replace(/\s+/g, " ").trim().slice(0, 80) || (kind === "image" ? "本地图片" : kind === "formula" ? "公式" : "Mermaid 流程图");
    const kindLabel = kind === "image" ? "图片" : kind === "formula" ? "公式" : "流程图";
    const placement = node.type === "formulaInline" ? "inline" : "block";
    const placeholderText = placement === "inline"
      ? `【FE${kindLabel}${number}｜行内替换】`
      : `【FE${kindLabel}${number}｜整段替换】`;
    replacementItems.push({
      itemId: `wechat-item-${number}`,
      sequence,
      kind,
      placement,
      label,
      placeholderText,
      sourceOffset: node.source.from,
      mimeType,
      width,
      height,
      sourceKey,
    });
    return placement === "inline"
      ? `<span style="color:#9a5b00;font-weight:700;white-space:nowrap;">${escapeHtml(placeholderText)}</span>`
      : `<span style="display:block;margin:.9em 0;color:#9a5b00;text-align:center;font-size:15px;line-height:1.7;font-weight:700;">${escapeHtml(placeholderText)}</span>`;
  };
  const titleResult = withoutLeadingTitle(context.parsedDocument);
  const fragment = renderParsedDocumentHtml(titleResult.document, {
    renderImage: (node) => {
      const referenceKey = stringAttribute(node, "referenceKey");
      if (approved.has(referenceKey)) {
        return '<span style="display:block;margin:1em 0;padding:.8em;border:1px dashed #999;color:#777;text-align:center;">【本次已批准省略一项不可用图片】</span>';
      }
      const asset = resources.get(referenceKey)!;
      return placeholder("image", stringAttribute(node, "alt") || "本地图片", node, referenceKey, asset.mimeType, asset.width ?? null, asset.height ?? null);
    },
    renderFormula: (node) => {
      const key = formulaReferenceKey(node);
      const asset = formulas.get(key)!;
      return placeholder("formula", stringAttribute(node, "latex").replace(/\s+/g, " "), node, key, asset.mimeType, asset.width, asset.height);
    },
    renderCodeBlock: (node) => {
      if (stringAttribute(node, "language").toLowerCase() !== "mermaid") return undefined;
      const key = mermaidReferenceKey(node);
      const asset = mermaids.get(key)!;
      return placeholder("diagram", "Mermaid 流程图", node, key, asset.mimeType, asset.width, asset.height);
    },
  });
  const selectedFont = typeof context.theme.tokens["typography.body.fontFamily"] === "string" ? String(context.theme.tokens["typography.body.fontFamily"]).replace(/[";{}<>]/g, "") : "Microsoft YaHei";
  const selectedTheme = context.theme.definition ?? resolveWechatTheme(context.theme.id);
  const html = compileWechatPublishHtml({ fragment: stripUnsupportedPresentationAttributes(fragment), definition: selectedTheme, wrapperFontFromContext: selectedFont });
  const securityIssues = auditWechatHtmlMarkup(html);
  if (securityIssues.length > 0) {
    diagnostics.push(diagnostic(context, "WECHAT_HTML_SECURITY_AUDIT_FAILED", `公众号富文本安全审计失败（${securityIssues.join("、")}），未写入剪贴板。`));
    return { status: "failed", bytes: null, diagnostics, usedReferenceKeys, omittedReferenceKeys };
  }
  const bytes = new TextEncoder().encode(html);
  if (bytes.byteLength > WECHAT_HTML_HARD_LIMIT) {
    diagnostics.push(diagnostic(context, "WECHAT_HTML_LIMIT_EXCEEDED", "公众号富文本超过 5 MiB 安全上限，已阻止写入剪贴板。"));
    return { status: "failed", bytes: null, diagnostics, usedReferenceKeys, omittedReferenceKeys };
  }
  const omitted = [...new Set(omittedReferenceKeys)].sort();
  const consumed = [...approved].sort();
  if (omitted.length !== consumed.length || omitted.some((value, index) => value !== consumed[index])) {
    diagnostics.push(diagnostic(context, "OUTPUT_APPROVAL_CONSUMPTION_MISMATCH", "公众号实际省略集合与本次批准集合不一致。"));
    return { status: "failed", bytes: null, diagnostics, usedReferenceKeys, omittedReferenceKeys: omitted };
  }
  return {
    status: omitted.length > 0 ? "completed-with-omissions" : "completed",
    bytes,
    diagnostics,
    usedReferenceKeys: [...new Set(usedReferenceKeys)].sort(),
    omittedReferenceKeys: omitted,
    replacementItems,
    ...(titleResult.suggestedTitle ? { suggestedTitle: titleResult.suggestedTitle } : {}),
  };
}
