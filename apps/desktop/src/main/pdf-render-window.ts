import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BrowserWindow, session } from "electron";
import type { Diagnostic } from "@fantastic-editor/document-core";
import type { OutputContext } from "@fantastic-editor/shared";
import { generateOfflineHtml, type OfflineHtmlGeneration, type OutputResourceAsset } from "./offline-html-adapter.js";
import type { OutputMermaidAsset } from "./mermaid-assets.js";

const PDF_TIMEOUT_MS = 45_000;

interface PdfController {
  window: BrowserWindow;
  cancelled: boolean;
}

function failed(context: OutputContext, status: "failed" | "cancelled" | "timed-out", code: string, message: string): OfflineHtmlGeneration {
  const diagnostic: Diagnostic = {
    id: `diagnostic-${context.jobId}-${code}`,
    code,
    severity: status === "cancelled" ? "info" : "blocking",
    category: code.includes("FONT") ? "compatibility" : "export",
    message,
    outputTarget: "pdf",
  };
  return { status, bytes: null, diagnostics: [diagnostic], usedReferenceKeys: [], omittedReferenceKeys: [] };
}

function validPdf(bytes: Uint8Array): boolean {
  return bytes.byteLength > 8
    && bytes[0] === 0x25
    && bytes[1] === 0x50
    && bytes[2] === 0x44
    && bytes[3] === 0x46
    && bytes[4] === 0x2d;
}

export class PdfRenderWindow {
  readonly #controllers = new Map<string, PdfController>();

  async generatePdf(context: OutputContext, assets: OutputResourceAsset[], mermaidAssets: OutputMermaidAsset[] = []): Promise<OfflineHtmlGeneration> {
    if (context.target !== "pdf" || this.#controllers.has(context.jobId)) {
      return failed(context, "failed", "PDF_REQUEST_INVALID", "PDF 导出任务身份无效或重复。 ");
    }
    const htmlGeneration = generateOfflineHtml(context, assets, mermaidAssets);
    if ((htmlGeneration.status !== "completed" && htmlGeneration.status !== "completed-with-omissions") || !htmlGeneration.bytes) {
      return htmlGeneration;
    }

    const temporaryDirectory = await mkdtemp(join(tmpdir(), "fantastic-editor-pdf-"));
    const htmlPath = join(temporaryDirectory, "document.html");
    const isolatedSession = session.fromPartition(`fantastic-pdf-${randomUUID()}`, { cache: false });
    isolatedSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, callback) => callback({ cancel: true }));
    const window = new BrowserWindow({
      width: 1200,
      height: 900,
      show: false,
      backgroundColor: "#ffffff",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        session: isolatedSession,
      },
    });
    window.setMenuBarVisibility(false);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      if (url !== window.webContents.getURL()) event.preventDefault();
    });
    const controller: PdfController = { window, cancelled: false };
    this.#controllers.set(context.jobId, controller);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await writeFile(htmlPath, htmlGeneration.bytes);
      const operation = (async () => {
        await window.loadFile(htmlPath);
        await window.webContents.executeJavaScript(`Promise.all([
          document.fonts ? document.fonts.ready : Promise.resolve(),
          Promise.all(Array.from(document.images).map((image) => image.complete
            ? Promise.resolve()
            : new Promise((resolve, reject) => {
                image.addEventListener("load", resolve, { once: true });
                image.addEventListener("error", () => reject(new Error("image-load-failed")), { once: true });
              })))
        ]).then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))`, true);
        if (controller.cancelled) return failed(context, "cancelled", "PDF_CANCELLED", "PDF 导出任务已取消。");
        const buffer = await window.webContents.printToPDF({
          printBackground: true,
          pageSize: "A4",
          preferCSSPageSize: true,
          generateTaggedPDF: true,
          generateDocumentOutline: true,
        });
        const bytes = new Uint8Array(buffer);
        if (!validPdf(bytes)) return failed(context, "failed", "PDF_RESULT_INVALID", "Chromium 返回了无效 PDF 数据。");
        return { ...htmlGeneration, bytes };
      })();
      const timedOut = new Promise<OfflineHtmlGeneration>((resolve) => {
        timeout = setTimeout(() => {
          controller.cancelled = true;
          if (!window.isDestroyed()) window.destroy();
          resolve(failed(context, "timed-out", "PDF_TIMED_OUT", "PDF 导出超过 45 秒，隔离窗口已销毁。"));
        }, PDF_TIMEOUT_MS);
      });
      return await Promise.race([operation, timedOut]);
    } catch {
      return controller.cancelled
        ? failed(context, "cancelled", "PDF_CANCELLED", "PDF 导出任务已取消。")
        : failed(context, "failed", "PDF_RENDER_PROCESS_FAILED", "PDF 隔离渲染窗口不可用或页面资源未就绪。");
    } finally {
      if (timeout) clearTimeout(timeout);
      this.#controllers.delete(context.jobId);
      if (!window.isDestroyed()) window.destroy();
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  cancelJob(jobId: string): boolean {
    const controller = this.#controllers.get(jobId);
    if (!controller) return false;
    controller.cancelled = true;
    if (!controller.window.isDestroyed()) controller.window.destroy();
    return true;
  }

  dispose(): void {
    for (const [jobId] of this.#controllers) this.cancelJob(jobId);
    this.#controllers.clear();
  }
}
