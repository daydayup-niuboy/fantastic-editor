import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { utilityProcess, type UtilityProcess } from "electron";
import type { SvgProcessRequest, SvgProcessResponse } from "./image-process-protocol.js";
import type { SvgTransformResult } from "./svg-transform.js";

const PROCESS_TIMEOUT_MS = 10_000;

interface PendingTransform {
  resolve(result: SvgTransformResult): void;
  timeout: ReturnType<typeof setTimeout>;
}

function processFailure(code: string, message: string): SvgTransformResult {
  return { status: "failed", code, message };
}

function isResponse(value: unknown): value is SvgProcessResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SvgProcessResponse>;
  if (typeof candidate.taskId !== "string") return false;
  if (candidate.type === "svg-transform-failed") {
    return typeof candidate.code === "string" && typeof candidate.message === "string";
  }
  return candidate.type === "svg-transformed"
    && candidate.png instanceof Uint8Array
    && typeof candidate.width === "number"
    && typeof candidate.height === "number";
}

export class ImageTransformProcess {
  #process: UtilityProcess | null = null;
  readonly #pending = new Map<string, PendingTransform>();
  #disposed = false;

  transformSvg(svgBytes: Uint8Array): Promise<SvgTransformResult> {
    if (this.#disposed) return Promise.resolve(processFailure("SVG_PROCESS_DISPOSED", "图片处理进程已关闭。"));
    let child: UtilityProcess;
    try {
      child = this.ensureProcess();
    } catch {
      return Promise.resolve(processFailure("SVG_PROCESS_START_FAILED", "无法启动隔离图片处理进程。"));
    }
    const taskId = randomUUID();
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (!this.#pending.delete(taskId)) return;
        resolve(processFailure("SVG_TRANSFORM_TIMED_OUT", "SVG 安全转换超时。"));
        this.stopProcess("SVG_PROCESS_RESTARTED", "图片处理进程因超时已重启。");
      }, PROCESS_TIMEOUT_MS);
      this.#pending.set(taskId, { resolve, timeout });
      const request: SvgProcessRequest = { type: "transform-svg", taskId, svgBytes: svgBytes.slice() };
      try {
        child.postMessage(request);
      } catch {
        clearTimeout(timeout);
        this.#pending.delete(taskId);
        resolve(processFailure("SVG_PROCESS_SEND_FAILED", "无法向隔离图片处理进程发送任务。"));
        this.stopProcess("SVG_PROCESS_RESTARTED", "图片处理进程通信失败，已重启。");
      }
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.stopProcess("SVG_PROCESS_DISPOSED", "图片处理进程已关闭。");
  }

  private ensureProcess(): UtilityProcess {
    if (this.#process) return this.#process;
    const child = utilityProcess.fork(join(__dirname, "image-process.js"), [], {
      serviceName: "fantastic-editor-image-transform",
      stdio: "ignore",
    });
    this.#process = child;
    child.on("message", (message) => this.handleMessage(message));
    child.on("exit", () => {
      if (this.#process !== child) return;
      this.#process = null;
      this.resolveAll(processFailure("SVG_PROCESS_EXITED", "隔离图片处理进程意外退出。"));
    });
    child.on("error", () => {
      if (this.#process === child) this.stopProcess("SVG_PROCESS_FAILED", "隔离图片处理进程发生致命错误。");
    });
    return child;
  }

  private handleMessage(message: unknown): void {
    if (!isResponse(message)) return;
    const pending = this.#pending.get(message.taskId);
    if (!pending) return;
    this.#pending.delete(message.taskId);
    clearTimeout(pending.timeout);
    if (message.type === "svg-transform-failed") {
      pending.resolve(processFailure(message.code.slice(0, 128), message.message.slice(0, 512)));
      return;
    }
    if (
      message.width <= 0
      || message.height <= 0
      || message.width > 4096
      || message.height > 4096
      || message.png.byteLength === 0
      || message.png.byteLength > 128 * 1024 * 1024
    ) {
      pending.resolve(processFailure("SVG_PROCESS_RESULT_INVALID", "隔离图片处理进程返回了无效结果。"));
      return;
    }
    pending.resolve({
      status: "completed",
      png: message.png.slice(),
      width: message.width,
      height: message.height,
    });
  }

  private stopProcess(code: string, message: string): void {
    const child = this.#process;
    this.#process = null;
    if (child) child.kill();
    this.resolveAll(processFailure(code, message));
  }

  private resolveAll(result: SvgTransformResult): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.resolve(result);
    }
    this.#pending.clear();
  }
}