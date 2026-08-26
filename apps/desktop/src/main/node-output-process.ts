import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { utilityProcess, type UtilityProcess } from "electron";
import type { Diagnostic } from "@fantastic-editor/document-core";
import type { OutputContext } from "@fantastic-editor/shared";
import type { DocxGeneration, OutputFormulaAsset } from "./docx-adapter.js";
import type { OfflineHtmlGeneration, OutputResourceAsset } from "./offline-html-adapter.js";
import type { WechatGeneration } from "./wechat-adapter.js";
import type { OutputMermaidAsset } from "./mermaid-assets.js";
import type { OutputProcessRequest, OutputProcessResponse } from "./output-process-protocol.js";

const OUTPUT_TIMEOUT_MS = 30_000;
type NodeGeneration = OfflineHtmlGeneration | DocxGeneration | WechatGeneration;
type OutputKind = "offline-html" | "docx" | "wechat";

interface PendingOutput {
  jobId: string;
  kind: OutputKind;
  context: OutputContext;
  resolve(result: NodeGeneration): void;
  timeout: ReturnType<typeof setTimeout>;
}

function copyAssetsWithSharedBytes<T extends { bytes: Uint8Array }>(assets: readonly T[]): T[] {
  const copies = new Map<Uint8Array, Uint8Array>();
  return assets.map((asset) => {
    let bytes = copies.get(asset.bytes);
    if (!bytes) {
      bytes = asset.bytes.slice();
      copies.set(asset.bytes, bytes);
    }
    return { ...asset, bytes };
  });
}
function failedGeneration(context: OutputContext, status: "failed" | "cancelled" | "timed-out", code: string, message: string): NodeGeneration {
  const diagnostic: Diagnostic = {
    id: `diagnostic-${context.jobId}-${code}`,
    code,
    severity: status === "cancelled" ? "info" : "blocking",
    category: "export",
    message,
    outputTarget: context.target,
  };
  return { status, bytes: null, diagnostics: [diagnostic], usedReferenceKeys: [], omittedReferenceKeys: [] };
}

function isResponse(value: unknown): value is OutputProcessResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<OutputProcessResponse>;
  return typeof candidate.taskId === "string"
    && ["offline-html-generated", "docx-generated", "wechat-html-generated", "output-process-failed"].includes(candidate.type ?? "");
}

export class NodeOutputProcess {
  #process: UtilityProcess | null = null;
  readonly #pending = new Map<string, PendingOutput>();
  #disposed = false;

  generateOfflineHtml(context: OutputContext, assets: OutputResourceAsset[], mermaidAssets: OutputMermaidAsset[] = []): Promise<OfflineHtmlGeneration> {
    return this.start("offline-html", context, assets, [], mermaidAssets);
  }

  generateDocx(context: OutputContext, assets: OutputResourceAsset[], formulaAssets: OutputFormulaAsset[], mermaidAssets: OutputMermaidAsset[] = []): Promise<DocxGeneration> {
    return this.start("docx", context, assets, formulaAssets, mermaidAssets);
  }

  generateWechatHtml(context: OutputContext, assets: OutputResourceAsset[], formulaAssets: OutputFormulaAsset[], mermaidAssets: OutputMermaidAsset[] = []): Promise<WechatGeneration> {
    return this.start("wechat", context, assets, formulaAssets, mermaidAssets);
  }

  cancelJob(jobId: string): boolean {
    const matches = [...this.#pending.entries()].filter(([, pending]) => pending.jobId === jobId);
    if (matches.length === 0) return false;
    for (const [taskId, pending] of matches) {
      this.#pending.delete(taskId);
      clearTimeout(pending.timeout);
      pending.resolve(failedGeneration(pending.context, "cancelled", "OUTPUT_CANCELLED", "导出任务已取消。"));
    }
    this.stopProcess("OUTPUT_PROCESS_RESTARTED", "Node 导出进程因任务取消已重启。", "failed");
    return true;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.stopProcess("OUTPUT_PROCESS_DISPOSED", "Node 导出进程已关闭。", "failed");
  }

  private start(
    kind: OutputKind,
    context: OutputContext,
    assets: OutputResourceAsset[],
    formulaAssets: OutputFormulaAsset[],
    mermaidAssets: OutputMermaidAsset[],
  ): Promise<NodeGeneration> {
    if (this.#disposed) return Promise.resolve(failedGeneration(context, "failed", "OUTPUT_PROCESS_DISPOSED", "Node 导出进程已关闭。"));
    let child: UtilityProcess;
    try {
      child = this.ensureProcess();
    } catch {
      return Promise.resolve(failedGeneration(context, "failed", "OUTPUT_PROCESS_START_FAILED", "无法启动 Node 导出进程。"));
    }
    const taskId = randomUUID();
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (!this.#pending.delete(taskId)) return;
        resolve(failedGeneration(context, "timed-out", "OUTPUT_PROCESS_TIMED_OUT", `${kind === "docx" ? "DOCX" : kind === "wechat" ? "公众号 HTML" : "离线 HTML"} 导出超时。`));
        this.stopProcess("OUTPUT_PROCESS_RESTARTED", "Node 导出进程因超时已重启。", "failed");
      }, OUTPUT_TIMEOUT_MS);
      this.#pending.set(taskId, { jobId: context.jobId, kind, context, resolve, timeout });
      const copiedAssets = copyAssetsWithSharedBytes(assets);
      const copiedFormulaAssets = copyAssetsWithSharedBytes(formulaAssets);
      const copiedMermaidAssets = copyAssetsWithSharedBytes(mermaidAssets);
      const request: OutputProcessRequest = kind === "docx"
        ? { type: "generate-docx", taskId, context, assets: copiedAssets, formulaAssets: copiedFormulaAssets, mermaidAssets: copiedMermaidAssets }
        : kind === "wechat"
          ? { type: "generate-wechat-html", taskId, context, assets: copiedAssets, formulaAssets: copiedFormulaAssets, mermaidAssets: copiedMermaidAssets }
          : { type: "generate-offline-html", taskId, context, assets: copiedAssets, mermaidAssets: copiedMermaidAssets };
      try {
        child.postMessage(request);
      } catch {
        clearTimeout(timeout);
        this.#pending.delete(taskId);
        resolve(failedGeneration(context, "failed", "OUTPUT_PROCESS_SEND_FAILED", "无法向 Node 导出进程发送任务。"));
        this.stopProcess("OUTPUT_PROCESS_RESTARTED", "Node 导出进程通信失败，已重启。", "failed");
      }
    });
  }

  private ensureProcess(): UtilityProcess {
    if (this.#process) return this.#process;
    const child = utilityProcess.fork(join(__dirname, "output-process.js"), [], {
      serviceName: "fantastic-editor-node-output",
      stdio: "ignore",
    });
    this.#process = child;
    child.on("message", (message) => this.handleMessage(message));
    child.on("exit", () => {
      if (this.#process !== child) return;
      this.#process = null;
      this.resolveAll("OUTPUT_PROCESS_EXITED", "Node 导出进程意外退出。", "failed");
    });
    child.on("error", () => {
      if (this.#process === child) this.stopProcess("OUTPUT_PROCESS_FAILED", "Node 导出进程发生致命错误。", "failed");
    });
    return child;
  }

  private handleMessage(message: unknown): void {
    if (!isResponse(message)) return;
    const pending = this.#pending.get(message.taskId);
    if (!pending) return;
    this.#pending.delete(message.taskId);
    clearTimeout(pending.timeout);
    if (message.type === "output-process-failed") {
      pending.resolve(failedGeneration(pending.context, "failed", message.code.slice(0, 128), message.message.slice(0, 512)));
      return;
    }
    if (
      (pending.kind === "docx" && message.type !== "docx-generated")
      || (pending.kind === "wechat" && message.type !== "wechat-html-generated")
      || (pending.kind === "offline-html" && message.type !== "offline-html-generated")
    ) {
      pending.resolve(failedGeneration(pending.context, "failed", "OUTPUT_PROCESS_RESULT_KIND_MISMATCH", "Node 导出进程返回了错误目标的结果。"));
      return;
    }
    const generation = message.generation;
    if (
      !generation
      || !["completed", "completed-with-omissions", "failed", "cancelled", "timed-out"].includes(generation.status)
      || (generation.bytes !== null && !(generation.bytes instanceof Uint8Array))
    ) {
      pending.resolve(failedGeneration(pending.context, "failed", "OUTPUT_PROCESS_RESULT_INVALID", "Node 导出进程返回了无效结果。"));
      return;
    }
    pending.resolve({ ...generation, bytes: generation.bytes?.slice() ?? null });
  }

  private stopProcess(code: string, message: string, status: "failed" | "cancelled" | "timed-out"): void {
    const child = this.#process;
    this.#process = null;
    if (child) child.kill();
    this.resolveAll(code, message, status);
  }

  private resolveAll(code: string, message: string, status: "failed" | "cancelled" | "timed-out"): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.resolve(failedGeneration(pending.context, status, code, message));
    }
    this.#pending.clear();
  }
}
