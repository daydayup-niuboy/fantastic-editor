import { createHash } from "node:crypto";
import type { Diagnostic, DocumentNode } from "@fantastic-editor/document-core";
import { FANTASTIC_EDITOR_LIMITS, WECHAT_THEME_OPTIONS } from "@fantastic-editor/shared";
import type {
  ApproveOmissions,
  BeginOutputRequest,
  DerivedAssetManifest,
  OutputArtifact,
  OutputCommandResult,
  OutputContext,
  OutputPreflightContext,
  OutputResult,
  ResolutionSnapshot,
  WechatReplacementItem,
  WechatThemeId,
} from "@fantastic-editor/shared";
import type { SingleFileResolutionContext } from "./file-sessions.js";
import type { OutputFormulaAsset } from "./docx-adapter.js";
import { formulaReferenceKey } from "./docx-adapter.js";
import type { FormulaRenderResult } from "./formula-render-window.js";
import type { MermaidRenderResult } from "./mermaid-render-window.js";
import { collectMermaidNodes, mermaidReferenceKey, type OutputMermaidAsset } from "./mermaid-assets.js";
import type { OutputResourceAsset } from "./offline-html-adapter.js";
import type { WechatReplacementBinding } from "./wechat-adapter.js";
import type { SvgTransformResult } from "./svg-transform.js";
import { SVG_TRANSFORM_PROFILE } from "./svg-transform.js";
import { OutputJobRegistry } from "./output-job-registry.js";
import { preflightOutput } from "./output-preflight.js";
import type { AssetHandleRegistry } from "./single-file-resource-resolver.js";

interface OutputGenerator {
  generateOfflineHtml(context: OutputContext, assets: OutputResourceAsset[], mermaidAssets: OutputMermaidAsset[]): Promise<GeneratedOutput>;
  generateDocx(context: OutputContext, assets: OutputResourceAsset[], formulaAssets: OutputFormulaAsset[], mermaidAssets: OutputMermaidAsset[]): Promise<GeneratedOutput>;
  generateWechatHtml(context: OutputContext, assets: OutputResourceAsset[], formulaAssets: OutputFormulaAsset[], mermaidAssets: OutputMermaidAsset[]): Promise<GeneratedOutput>;
  cancelJob(jobId: string): boolean;
}

interface GeneratedOutput {
  status: OutputResult["status"];
  bytes: Uint8Array | null;
  diagnostics: Diagnostic[];
  usedReferenceKeys: string[];
  omittedReferenceKeys: string[];
  replacementItems?: WechatReplacementBinding[];
  suggestedTitle?: string;
}

interface FormulaRenderer {
  renderFormula(latex: string, displayMode: boolean): Promise<FormulaRenderResult>;
  dispose?(): void;
}

interface MermaidRenderer {
  renderDiagram(source: string, darkMode: boolean, fontFamily: string): Promise<MermaidRenderResult>;
  dispose?(): void;
}

interface PdfRenderer {
  generatePdf(context: OutputContext, assets: OutputResourceAsset[], mermaidAssets: OutputMermaidAsset[]): Promise<GeneratedOutput>;
  cancelJob(jobId: string): boolean;
}

interface SvgTransformer {
  transformSvg(bytes: Uint8Array): Promise<SvgTransformResult>;
}

export type SaveOutputResult =
  | { status: "saved"; artifact: OutputArtifact }
  | { status: "cancelled" }
  | { status: "failed"; error: string };

export interface WechatAcceptanceSummary {
  jobId: string;
  documentId: string;
  sourceHash: string;
  status: Extract<OutputResult["status"], "completed" | "completed-with-omissions">;
  themeId: WechatThemeId;
  replacementItems: WechatReplacementItem[];
  omittedReferenceKeys: string[];
}

export interface WechatDraftPayload {
  jobId: string;
  sourceHash: string;
  title: string;
  html: string;
  replacementItems: WechatReplacementItem[];
  replacements: Map<string, { bytes: Uint8Array; mimeType: string }>;
}

interface OutputRuntime {
  request: BeginOutputRequest;
  context: OutputContext;
  assets: OutputResourceAsset[];
  formulaAssets: OutputFormulaAsset[];
  mermaidAssets: OutputMermaidAsset[];
  startedAt: number;
  isCurrent(): boolean;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function outputDiagnostic(jobId: string, code: string, message: string, target: BeginOutputRequest["target"], referenceKey?: string, node?: DocumentNode): Diagnostic {
  return {
    id: `diagnostic-${jobId}-${referenceKey ?? "output"}-${code}`,
    code,
    severity: "blocking",
    category: code.includes("SVG") || code.includes("MERMAID") ? "compatibility" : "resource",
    message,
    outputTarget: target,
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

function collectFormulaReferences(nodes: readonly DocumentNode[]): string[] {
  return collectFormulaNodes(nodes).map(formulaReferenceKey);
}

function normalizeOutputFont(value: unknown): string {
  if (typeof value !== "string") return "Microsoft YaHei UI";
  const font = value.trim().replace(/\s+/g, " ");
  return font && font.length <= 64 && !/[\u0000-\u001f\u007f{};<>]/.test(font) ? font : "Microsoft YaHei UI";
}

const WECHAT_THEME_IDS = new Set<string>(WECHAT_THEME_OPTIONS.map((theme) => theme.id));

function normalizeWechatThemeId(value: unknown): WechatThemeId | null {
  if (value === undefined) return "wechat-native-enhanced";
  return typeof value === "string" && WECHAT_THEME_IDS.has(value) ? value as WechatThemeId : null;
}

function mergeDiagnostics(...groups: readonly Diagnostic[][]): Diagnostic[] {
  const seen = new Set<string>();
  return groups.flat().filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

export class OutputService {
  readonly #jobs = new OutputJobRegistry();
  readonly #snapshots = new Map<string, ResolutionSnapshot>();
  readonly #runtimes = new Map<string, OutputRuntime>();
  readonly #wechatReplacements = new Map<string, Map<string, { bytes: Uint8Array; mimeType: string }>>();
  readonly #wechatDraftPayloads = new Map<string, WechatDraftPayload>();
  readonly #handles: AssetHandleRegistry;
  readonly #svgTransformer: SvgTransformer;
  readonly #generator: OutputGenerator;
  readonly #formulaRenderer: FormulaRenderer | undefined;
  readonly #mermaidRenderer: MermaidRenderer | undefined;
  readonly #pdfRenderer: PdfRenderer | undefined;
  readonly #saveOutput: (suggestedName: string, bytes: Uint8Array, target: BeginOutputRequest["target"]) => Promise<SaveOutputResult>;

  constructor(
    handles: AssetHandleRegistry,
    svgTransformer: SvgTransformer,
    generator: OutputGenerator,
    saveOutput: (suggestedName: string, bytes: Uint8Array, target: BeginOutputRequest["target"]) => Promise<SaveOutputResult>,
    formulaRenderer?: FormulaRenderer,
    pdfRenderer?: PdfRenderer,
    mermaidRenderer?: MermaidRenderer,
  ) {
    this.#handles = handles;
    this.#svgTransformer = svgTransformer;
    this.#generator = generator;
    this.#saveOutput = saveOutput;
    this.#formulaRenderer = formulaRenderer;
    this.#mermaidRenderer = mermaidRenderer;
    this.#pdfRenderer = pdfRenderer;
  }

  getWechatReplacement(jobId: string, itemId: string): { bytes: Uint8Array; mimeType: string } | undefined {
    if (!/^[A-Za-z0-9-]{1,80}$/.test(jobId) || !/^wechat-item-\d{2,5}$/.test(itemId)) return undefined;
    const item = this.#wechatReplacements.get(jobId)?.get(itemId);
    return item ? { bytes: item.bytes.slice(), mimeType: item.mimeType } : undefined;
  }

  getWechatAcceptanceSummary(jobId: string): WechatAcceptanceSummary | undefined {
    if (!/^[A-Za-z0-9-]{1,80}$/.test(jobId)) return undefined;
    const result = this.#jobs.get(jobId)?.result;
    if (
      !result
      || result.target !== "wechat-clipboard"
      || (result.status !== "completed" && result.status !== "completed-with-omissions")
      || !result.wechatReplacementItems
      || !result.wechatThemeId
    ) return undefined;
    return {
      jobId: result.jobId,
      documentId: result.documentId,
      sourceHash: result.sourceHash,
      status: result.status,
      themeId: result.wechatThemeId,
      replacementItems: result.wechatReplacementItems.map((item) => ({ ...item })),
      omittedReferenceKeys: [...result.omittedReferenceKeys],
    };
  }

  getWechatDraftPayload(jobId: string): WechatDraftPayload | undefined {
    if (!/^[A-Za-z0-9-]{1,80}$/.test(jobId)) return undefined;
    const payload = this.#wechatDraftPayloads.get(jobId);
    if (!payload) return undefined;
    return {
      ...payload,
      replacementItems: payload.replacementItems.map((item) => ({ ...item })),
      replacements: new Map([...payload.replacements.entries()].map(([itemId, value]) => [itemId, { bytes: value.bytes.slice(), mimeType: value.mimeType }])),
    };
  }
  rememberResolution(parseCommitId: string, snapshot: ResolutionSnapshot): void {
    this.#snapshots.set(parseCommitId, snapshot);
  }

  async begin(
    request: BeginOutputRequest,
    context: SingleFileResolutionContext | undefined,
    isCurrent: () => boolean,
  ): Promise<OutputCommandResult> {
    const wechatThemeId = normalizeWechatThemeId(request.wechatThemeId);
    if (
      (request.target !== "offline-html" && request.target !== "docx" && request.target !== "pdf" && request.target !== "wechat-html" && request.target !== "wechat-clipboard")
      || !context
      || !isCurrent()
      || request.documentId !== request.parsedDocument.documentId
      || request.sourceHash !== request.parsedDocument.sourceHash
      || request.parserProfile !== request.parsedDocument.parserProfile
      || request.workspaceRevision !== context.workspaceRevision
      || request.parsedDocument.sourceLength > FANTASTIC_EDITOR_LIMITS.maxSourceCharacters
      || request.parsedDocument.resourceReferences.length > FANTASTIC_EDITOR_LIMITS.maxResourceReferences
      || ((request.target === "wechat-html" || request.target === "wechat-clipboard") && wechatThemeId === null)
    ) return { status: "failed", error: "导出请求无效、已过期或目标尚未实现。" };
    const snapshot = this.#snapshots.get(request.parseCommitId);
    if (!snapshot || snapshot.documentId !== request.documentId || snapshot.sourceHash !== request.sourceHash || snapshot.workspaceRevision !== request.workspaceRevision) {
      return { status: "failed", error: "找不到与当前解析提交匹配的资源快照。" };
    }

    const job = this.#jobs.create({
      documentId: request.documentId,
      target: request.target,
      sourceHash: request.sourceHash,
      workspaceRevision: request.workspaceRevision,
    });
    this.#jobs.transition(job.jobId, "parsing");
    this.#jobs.transition(job.jobId, "resolving-assets");
    this.#jobs.transition(job.jobId, "rendering-assets");
    const reservedOutputHashes = new Set<string>();
    let totalUniqueOutputBytes = 0;
    const reserveOutputBytes = (contentHash: string, byteLength: number): boolean => {
      if (reservedOutputHashes.has(contentHash)) return true;
      if (totalUniqueOutputBytes + byteLength > FANTASTIC_EDITOR_LIMITS.maxUniqueResolutionBytes) return false;
      reservedOutputHashes.add(contentHash);
      totalUniqueOutputBytes += byteLength;
      return true;
    };
    const collected = await this.collectAssets(job.jobId, request.target, snapshot, context, isCurrent, reserveOutputBytes);
    const formulaCollection = request.target === "docx" || request.target === "wechat-html" || request.target === "wechat-clipboard"
      ? await this.collectFormulaAssets(job.jobId, request.target, request.parsedDocument.children, isCurrent, reserveOutputBytes)
      : { assets: [] as OutputFormulaAsset[], diagnostics: [] as Diagnostic[], derivedEntries: {} as DerivedAssetManifest["entries"] };
    const mermaidCollection = await this.collectMermaidAssets(
      job.jobId,
      request.target,
      request.parsedDocument.children,
      false,
      normalizeOutputFont(request.fontFamily),
      isCurrent,
      reserveOutputBytes,
    );
    if (!isCurrent()) {
      const cancelled = this.#jobs.cancel(job.jobId)!;
      return { status: "cancelled", job: cancelled, error: "导出期间文档或工作区身份已变化。" };
    }
    this.#jobs.transition(job.jobId, "preflighting");
    const begun = this.#jobs.beginPreflight(job.jobId)!;
    const derivedAssetManifest: DerivedAssetManifest = {
      schema: "fantastic-editor-derived-asset-manifest",
      jobId: job.jobId,
      sourceHash: request.sourceHash,
      workspaceRevision: request.workspaceRevision,
      entries: { ...collected.derivedEntries, ...formulaCollection.derivedEntries, ...mermaidCollection.derivedEntries },
    };
    const preflightContext: OutputPreflightContext = {
      jobId: job.jobId,
      documentId: request.documentId,
      target: request.target,
      sourceHash: request.sourceHash,
      workspaceRevision: request.workspaceRevision,
      preflightId: begun.preflightId,
      parsedDocument: request.parsedDocument,
      resolutionSnapshot: {
        ...snapshot,
        diagnostics: mergeDiagnostics(snapshot.diagnostics, collected.diagnostics, formulaCollection.diagnostics, mermaidCollection.diagnostics),
      },
      derivedAssetManifest,
      theme: { id: request.target === "wechat-html" || request.target === "wechat-clipboard" ? wechatThemeId! : "user-preview", tokens: { "typography.body.fontFamily": normalizeOutputFont(request.fontFamily), "colorScheme": request.darkMode === true ? "dark" : "light" } },
      locale: "zh-CN",
      options: {},
    };
    const preflight = preflightOutput(preflightContext);
    const accepted = this.#jobs.acceptPreflight(preflight)!;
    const outputContext: OutputContext = { ...preflightContext, approvedOmittedReferenceKeys: [] };
    this.#runtimes.set(job.jobId, {
      request,
      context: outputContext,
      assets: collected.assets,
      formulaAssets: formulaCollection.assets,
      mermaidAssets: mermaidCollection.assets,
      startedAt: Date.now(),
      isCurrent,
    });
    if (preflight.status === "failed") {
      this.#runtimes.delete(job.jobId);
      return { status: "failed", job: accepted, preflight, error: "导出预检失败。" };
    }
    if (preflight.status === "approval-required") {
      return { status: "approval-required", job: accepted, preflight };
    }
    return this.generate(job.jobId);
  }

  async approve(request: ApproveOmissions): Promise<OutputCommandResult> {
    const approved = this.#jobs.approve(request);
    const runtime = this.#runtimes.get(request.jobId);
    if (!approved || !runtime || !runtime.isCurrent()) {
      const job = this.#jobs.get(request.jobId);
      return { status: "failed", ...(job ? { job } : {}), error: "省略批准身份不匹配或任务已过期。" };
    }
    runtime.context = { ...runtime.context, approvedOmittedReferenceKeys: [...request.approvedOmittedReferenceKeys] };
    return this.generate(request.jobId);
  }

  cancel(jobId: string): OutputCommandResult {
    this.#generator.cancelJob(jobId);
    this.#pdfRenderer?.cancelJob(jobId);
    this.#runtimes.delete(jobId);
    const job = this.#jobs.cancel(jobId);
    return job ? { status: "cancelled", job } : { status: "failed", error: "任务不存在或已经结束。" };
  }

  clear(): void {
    for (const jobId of this.#runtimes.keys()) {
      this.#generator.cancelJob(jobId);
      this.#pdfRenderer?.cancelJob(jobId);
    }
    this.#runtimes.clear();
    this.#snapshots.clear();
    this.#wechatReplacements.clear();
    this.#wechatDraftPayloads.clear();
    this.#jobs.clear();
  }

  private async generate(jobId: string): Promise<OutputCommandResult> {
    const runtime = this.#runtimes.get(jobId);
    const generating = this.#jobs.transition(jobId, "generating");
    if (!runtime || !generating || !runtime.isCurrent()) {
      const job = this.#jobs.get(jobId);
      return { status: "failed", ...(job ? { job } : {}), error: "导出任务未就绪或身份已过期。" };
    }
    const generated = runtime.context.target === "docx"
      ? await this.#generator.generateDocx(runtime.context, runtime.assets, runtime.formulaAssets, runtime.mermaidAssets)
      : runtime.context.target === "wechat-html" || runtime.context.target === "wechat-clipboard"
        ? await this.#generator.generateWechatHtml(runtime.context, runtime.assets, runtime.formulaAssets, runtime.mermaidAssets)
        : runtime.context.target === "pdf"
        ? this.#pdfRenderer
          ? await this.#pdfRenderer.generatePdf(runtime.context, runtime.assets, runtime.mermaidAssets)
          : { status: "failed" as const, bytes: null, diagnostics: [outputDiagnostic(jobId, "PDF_RENDERER_UNAVAILABLE", "PDF 隔离渲染器不可用。", "pdf")], usedReferenceKeys: [], omittedReferenceKeys: [] }
        : await this.#generator.generateOfflineHtml(runtime.context, runtime.assets, runtime.mermaidAssets);
    if (!runtime.isCurrent()) {
      this.#runtimes.delete(jobId);
      const cancelled = this.#jobs.cancel(jobId);
      return { status: "cancelled", ...(cancelled ? { job: cancelled } : {}), error: "导出期间文档或工作区身份已变化。" };
    }
    let status = generated.status;
    let artifact: OutputArtifact | null = null;
    const diagnostics = mergeDiagnostics(runtime.context.resolutionSnapshot.diagnostics, generated.diagnostics);
    let wechatReplacementItems: WechatReplacementItem[] | undefined;
    if (
      (runtime.context.target === "wechat-html" || runtime.context.target === "wechat-clipboard")
      && (status === "completed" || status === "completed-with-omissions")
    ) {
      const bindings = generated.replacementItems;
      const stored = new Map<string, { bytes: Uint8Array; mimeType: string }>();
      const metadata: WechatReplacementItem[] = [];
      const resources = new Map(runtime.assets.map((asset) => [asset.referenceKey, asset]));
      const formulas = new Map(runtime.formulaAssets.map((asset) => [asset.formulaReferenceKey, asset]));
      const mermaids = new Map(runtime.mermaidAssets.map((asset) => [asset.mermaidReferenceKey, asset]));
      if (!bindings) {
        status = "failed";
        diagnostics.push(outputDiagnostic(jobId, "WECHAT_REPLACEMENT_MANIFEST_MISSING", "公众号替换项清单缺失，未写入剪贴板。", runtime.context.target));
      } else {
        for (const binding of bindings) {
          const source = binding.kind === "image" ? resources.get(binding.sourceKey) : binding.kind === "formula" ? formulas.get(binding.sourceKey) : mermaids.get(binding.sourceKey);
          if (!source || source.mimeType !== binding.mimeType || source.bytes.byteLength === 0 || stored.has(binding.itemId)) {
            status = "failed";
            diagnostics.push(outputDiagnostic(jobId, "WECHAT_REPLACEMENT_BINDING_INVALID", "公众号替换项与本次导出资源包不匹配，未写入剪贴板。", runtime.context.target));
            break;
          }
          const { sourceKey: _sourceKey, ...item } = binding;
          stored.set(binding.itemId, { bytes: source.bytes.slice(), mimeType: source.mimeType });
          metadata.push(item);
        }
      }
      if (status === "completed" || status === "completed-with-omissions") {
        this.#wechatReplacements.clear();
        this.#wechatReplacements.set(jobId, stored);
        wechatReplacementItems = metadata;
        if (runtime.context.target === "wechat-clipboard" && generated.bytes) {
          const html = new TextDecoder("utf-8", { fatal: true }).decode(generated.bytes);
          this.#wechatDraftPayloads.clear();
          this.#wechatDraftPayloads.set(jobId, {
            jobId,
            sourceHash: runtime.context.sourceHash,
            title: generated.suggestedTitle ?? "fantastic-editor 草稿",
            html,
            replacementItems: metadata.map((item) => ({ ...item })),
            replacements: new Map([...stored.entries()].map(([itemId, value]) => [itemId, { bytes: value.bytes.slice(), mimeType: value.mimeType }])),
          });
        }
      }
    }
    if ((status === "completed" || status === "completed-with-omissions") && generated.bytes) {
      const suggestedName = runtime.context.target === "docx"
        ? "document.docx"
        : runtime.context.target === "pdf" ? "document.pdf" : runtime.context.target === "wechat-clipboard" ? "公众号剪贴板" : runtime.context.target === "wechat-html" ? "wechat.html" : "document.html";
      const saved = await this.#saveOutput(suggestedName, generated.bytes, runtime.context.target);
      if (saved.status === "saved") artifact = saved.artifact;
      else if (saved.status === "cancelled") status = "cancelled";
      else {
        status = "failed";
        const writeFailureCode = runtime.context.target === "wechat-clipboard"
          ? "OUTPUT_CLIPBOARD_WRITE_FAILED"
          : "OUTPUT_FILE_WRITE_FAILED";
        diagnostics.push(outputDiagnostic(jobId, writeFailureCode, saved.error, runtime.context.target));
      }
    }
    if ((runtime.context.target === "wechat-html" || runtime.context.target === "wechat-clipboard") && status !== "completed" && status !== "completed-with-omissions") {
      this.#wechatReplacements.delete(jobId);
      this.#wechatDraftPayloads.delete(jobId);
      wechatReplacementItems = undefined;
    }
    const completedAt = Date.now();
    const result: OutputResult = {
      jobId,
      documentId: runtime.context.documentId,
      target: runtime.context.target,
      sourceHash: runtime.context.sourceHash,
      workspaceRevision: runtime.context.workspaceRevision,
      preflightId: runtime.context.preflightId,
      status,
      artifact,
      diagnostics,
      usedReferenceKeys: generated.usedReferenceKeys,
      usedFormulaReferences: collectFormulaReferences(runtime.context.parsedDocument.children),
      omittedReferenceKeys: generated.omittedReferenceKeys,
      approvedOmittedReferenceKeys: generated.omittedReferenceKeys,
      derivedAssetManifest: runtime.context.derivedAssetManifest,
      ...(wechatReplacementItems ? { wechatReplacementItems } : {}),
      ...(generated.suggestedTitle ? { wechatSuggestedTitle: generated.suggestedTitle } : {}),
      ...((runtime.context.target === "wechat-html" || runtime.context.target === "wechat-clipboard") ? { wechatThemeId: runtime.context.theme.id as WechatThemeId } : {}),
      timing: {
        startedAt: new Date(runtime.startedAt).toISOString(),
        completedAt: new Date(completedAt).toISOString(),
        durationMs: completedAt - runtime.startedAt,
      },
    };
    this.#runtimes.delete(jobId);
    const finalized = this.#jobs.finalize(result);
    if (!finalized) {
      const job = this.#jobs.get(jobId);
      return { status: "failed", ...(job ? { job } : {}), error: "导出结果违反任务终态或省略批准协议。" };
    }
    return { status, job: finalized, result };
  }

  private async collectMermaidAssets(
    jobId: string,
    target: BeginOutputRequest["target"],
    nodes: readonly DocumentNode[],
    darkMode: boolean,
    fontFamily: string,
    isCurrent: () => boolean,
    reserveOutputBytes: (contentHash: string, byteLength: number) => boolean,
  ): Promise<{
    assets: OutputMermaidAsset[];
    diagnostics: Diagnostic[];
    derivedEntries: DerivedAssetManifest["entries"];
  }> {
    const assets: OutputMermaidAsset[] = [];
    const diagnostics: Diagnostic[] = [];
    const derivedEntries: DerivedAssetManifest["entries"] = {};
    const profile = "mermaid-chromium-png-0.1";
    const nodesToRender = collectMermaidNodes(nodes);
    if (nodesToRender.length > FANTASTIC_EDITOR_LIMITS.maxMermaidRendersPerOutput) {
      diagnostics.push(outputDiagnostic(jobId, "MERMAID_RENDER_LIMIT_EXCEEDED", `Mermaid 流程图数量超过 ${FANTASTIC_EDITOR_LIMITS.maxMermaidRendersPerOutput} 项导出上限。`, target, undefined, nodesToRender[FANTASTIC_EDITOR_LIMITS.maxMermaidRendersPerOutput]));
      return { assets, diagnostics, derivedEntries };
    }
    for (const node of nodesToRender) {
      if (!isCurrent()) break;
      if (!this.#mermaidRenderer) {
        diagnostics.push(outputDiagnostic(jobId, "MERMAID_RENDERER_UNAVAILABLE", "Mermaid 隔离渲染器不可用。", target, undefined, node));
        continue;
      }
      const source = typeof node.attributes.value === "string" ? node.attributes.value : "";
      const rendered = await this.#mermaidRenderer.renderDiagram(source, darkMode, fontFamily);
      if (rendered.status !== "completed") {
        diagnostics.push(outputDiagnostic(jobId, rendered.code, rendered.message, target, undefined, node));
        continue;
      }
      const contentHash = sha256(rendered.png);
      if (!reserveOutputBytes(contentHash, rendered.png.byteLength)) {
        diagnostics.push(outputDiagnostic(jobId, "OUTPUT_RESOURCE_BUDGET_EXCEEDED", "导出图片、公式与 Mermaid 资源超过 200 MiB 总预算。", target, undefined, node));
        continue;
      }
      const reference = mermaidReferenceKey(node);
      const derivedAssetKey = createHash("sha256").update(`${reference}:${profile}:${contentHash}`).digest("hex");
      assets.push({ mermaidReferenceKey: reference, contentHash, mimeType: "image/png", width: rendered.width, height: rendered.height, bytes: rendered.png.slice() });
      derivedEntries[derivedAssetKey] = { derivedAssetKey, sourceReferenceKey: null, sourceContentHash: null, transformProfile: profile, derivedContentHash: contentHash, mimeType: "image/png", width: rendered.width, height: rendered.height };
    }
    this.#mermaidRenderer?.dispose?.();
    return { assets, diagnostics, derivedEntries };
  }

  private async collectFormulaAssets(
    jobId: string,
    target: BeginOutputRequest["target"],
    nodes: readonly DocumentNode[],
    isCurrent: () => boolean,
    reserveOutputBytes: (contentHash: string, byteLength: number) => boolean,
  ): Promise<{
    assets: OutputFormulaAsset[];
    diagnostics: Diagnostic[];
    derivedEntries: DerivedAssetManifest["entries"];
  }> {
    const assets: OutputFormulaAsset[] = [];
    const diagnostics: Diagnostic[] = [];
    const derivedEntries: DerivedAssetManifest["entries"] = {};
    const profile = "katex-chromium-png-0.1";
    const formulaNodes = collectFormulaNodes(nodes);
    if (formulaNodes.length > FANTASTIC_EDITOR_LIMITS.maxFormulaRendersPerOutput) {
      diagnostics.push(outputDiagnostic(
        jobId,
        "FORMULA_RENDER_LIMIT_EXCEEDED",
        `公式图片数量超过 ${FANTASTIC_EDITOR_LIMITS.maxFormulaRendersPerOutput} 项导出上限。`,
        target,
        undefined,
        formulaNodes[FANTASTIC_EDITOR_LIMITS.maxFormulaRendersPerOutput],
      ));
      return { assets, diagnostics, derivedEntries };
    }
    for (const node of formulaNodes) {
      if (!isCurrent()) break;
      const latex = typeof node.attributes.latex === "string" ? node.attributes.latex : "";
      const displayMode = node.type === "formulaBlock" || node.attributes.displayMode === true;
      if (!this.#formulaRenderer) {
        diagnostics.push(outputDiagnostic(jobId, "FORMULA_RENDERER_UNAVAILABLE", "公式隔离渲染器不可用。", target, undefined, node));
        continue;
      }
      const rendered = await this.#formulaRenderer.renderFormula(latex, displayMode);
      if (rendered.status !== "completed") {
        diagnostics.push(outputDiagnostic(jobId, rendered.code, rendered.message, target, undefined, node));
        continue;
      }
      const contentHash = sha256(rendered.png);
      if (!reserveOutputBytes(contentHash, rendered.png.byteLength)) {
        diagnostics.push(outputDiagnostic(jobId, "OUTPUT_RESOURCE_BUDGET_EXCEEDED", "导出图片与公式资源超过 200 MiB 总预算。", target, undefined, node));
        continue;
      }
      const reference = formulaReferenceKey(node);
      const derivedAssetKey = createHash("sha256").update(`${reference}:${profile}:${contentHash}`).digest("hex");
      assets.push({
        formulaReferenceKey: reference,
        contentHash,
        mimeType: "image/png",
        width: rendered.width,
        height: rendered.height,
        bytes: rendered.png.slice(),
      });
      derivedEntries[derivedAssetKey] = {
        derivedAssetKey,
        sourceReferenceKey: null,
        sourceContentHash: null,
        transformProfile: profile,
        derivedContentHash: contentHash,
        mimeType: "image/png",
        width: rendered.width,
        height: rendered.height,
      };
    }
    this.#formulaRenderer?.dispose?.();
    return { assets, diagnostics, derivedEntries };
  }

  private async collectAssets(
    jobId: string,
    target: BeginOutputRequest["target"],
    snapshot: ResolutionSnapshot,
    context: SingleFileResolutionContext,
    isCurrent: () => boolean,
    reserveBytes: (contentHash: string, byteLength: number) => boolean,
  ): Promise<{
    assets: OutputResourceAsset[];
    diagnostics: Diagnostic[];
    derivedEntries: DerivedAssetManifest["entries"];
  }> {
    const assets: OutputResourceAsset[] = [];
    const diagnostics: Diagnostic[] = [];
    const derivedEntries: DerivedAssetManifest["entries"] = {};
    const rasterBytesByContentHash = new Map<string, { bytes: Uint8Array; mimeType: string }>();
    
    for (const record of Object.values(snapshot.records)) {
      if (!isCurrent() || record.state !== "resolved" || !record.assetHandle || !record.contentHash) continue;
      if (record.mimeType === "image/svg+xml") {
        const source = await this.#handles.readSvgForTransform(record.assetHandle, context);
        if (source.status !== "ok" || source.contentHash !== record.contentHash) {
          diagnostics.push(outputDiagnostic(jobId, "OUTPUT_SVG_SOURCE_INVALID", "SVG 源资源在导出前已失效。", target, record.referenceKey));
          continue;
        }
        const transformed = await this.#svgTransformer.transformSvg(source.bytes);
        if (transformed.status !== "completed") {
          diagnostics.push(outputDiagnostic(jobId, transformed.code, transformed.message, target, record.referenceKey));
          continue;
        }
        const contentHash = sha256(transformed.png);
        if (!reserveBytes(contentHash, transformed.png.byteLength)) {
          diagnostics.push(outputDiagnostic(jobId, "OUTPUT_RESOURCE_BUDGET_EXCEEDED", "导出图片与公式资源超过 200 MiB 总预算。", target, record.referenceKey));
          continue;
        }
        const derivedAssetKey = createHash("sha256").update(`${record.contentHash}:${SVG_TRANSFORM_PROFILE}:${contentHash}`).digest("hex");
        assets.push({
          referenceKey: record.referenceKey,
          sourceContentHash: record.contentHash,
          contentHash,
          mimeType: "image/png",
          width: transformed.width,
          height: transformed.height,
          bytes: transformed.png,
        });
        derivedEntries[derivedAssetKey] = {
          derivedAssetKey,
          sourceReferenceKey: record.referenceKey,
          sourceContentHash: record.contentHash,
          transformProfile: SVG_TRANSFORM_PROFILE,
          derivedContentHash: contentHash,
          mimeType: "image/png",
          width: transformed.width,
          height: transformed.height,
        };
        continue;
      }
      let source = rasterBytesByContentHash.get(record.contentHash);
      if (!source) {
        const read = await this.#handles.read(record.assetHandle, context);
        if (read.status !== "ok" || read.contentHash !== record.contentHash) {
          diagnostics.push(outputDiagnostic(jobId, "OUTPUT_RESOURCE_HANDLE_INVALID", "图片资源在导出前已失效或发生变化。", target, record.referenceKey));
          continue;
        }
        source = { bytes: read.bytes, mimeType: read.mimeType };
        rasterBytesByContentHash.set(record.contentHash, source);
      }
      if (!reserveBytes(record.contentHash, source.bytes.byteLength)) {
        diagnostics.push(outputDiagnostic(jobId, "OUTPUT_RESOURCE_BUDGET_EXCEEDED", "导出图片与公式资源超过 200 MiB 总预算。", target, record.referenceKey));
        continue;
      }
      assets.push({
        referenceKey: record.referenceKey,
        sourceContentHash: record.contentHash,
        contentHash: record.contentHash,
        mimeType: source.mimeType,
        ...(record.width ? { width: record.width } : {}),
        ...(record.height ? { height: record.height } : {}),
        bytes: source.bytes,
      });
    }
    return { assets, diagnostics, derivedEntries };
  }
}
