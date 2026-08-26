import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { BrowserWindow, session, type Session } from "electron";

export type MermaidRenderResult =
  | { status: "completed"; png: Uint8Array; width: number; height: number }
  | { status: "failed"; code: string; message: string };

interface MermaidPageResult {
  status: "completed" | "failed";
  width?: number;
  height?: number;
  code?: string;
}

const MERMAID_TIMEOUT_MS = 12_000;

function failure(code: string, message: string): MermaidRenderResult {
  return { status: "failed", code, message };
}

export class MermaidRenderWindow {
  #window: BrowserWindow | null = null;
  #session: Session | null = null;
  #tail: Promise<void> = Promise.resolve();

  renderDiagram(source: string, darkMode: boolean, fontFamily: string): Promise<MermaidRenderResult> {
    const task = this.#tail.then(() => this.renderOne(source, darkMode, fontFamily));
    this.#tail = task.then(() => undefined, () => undefined);
    return task;
  }

  dispose(): void {
    const window = this.#window;
    this.#window = null;
    this.#session = null;
    if (window && !window.isDestroyed()) window.destroy();
  }

  private async ensureWindow(): Promise<BrowserWindow> {
    if (this.#window && !this.#window.isDestroyed()) return this.#window;
    const isolatedSession = session.fromPartition(`fantastic-mermaid-${randomUUID()}`, { cache: false });
    isolatedSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, callback) => callback({ cancel: true }));
    const window = new BrowserWindow({
      width: 1600,
      height: 1000,
      useContentSize: true,
      show: false,
      transparent: true,
      backgroundColor: "#00000000",
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
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.on("closed", () => {
      if (this.#window === window) this.#window = null;
    });
    await window.loadFile(join(__dirname, "../renderer/mermaid.html"));
    const ready = await window.webContents.executeJavaScript("Boolean(window.fantasticMermaidRendererReady)", true) as boolean;
    if (!ready) {
      window.destroy();
      throw new Error("Mermaid renderer did not initialize");
    }
    this.#session = isolatedSession;
    this.#window = window;
    return window;
  }

  private async renderOne(source: string, darkMode: boolean, fontFamily: string): Promise<MermaidRenderResult> {
    if (typeof source !== "string" || !source.trim() || source.length > 100_000) {
      return failure("MERMAID_REQUEST_INVALID", "Mermaid 源码为空或超过 100,000 字符安全上限。");
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const operation = (async () => {
        const window = await this.ensureWindow();
        const payload = JSON.stringify({ source, darkMode, fontFamily });
        const pageResult = await window.webContents.executeJavaScript(`window.renderFantasticMermaid(${payload})`, true) as MermaidPageResult;
        if (
          pageResult.status !== "completed"
          || !Number.isInteger(pageResult.width)
          || !Number.isInteger(pageResult.height)
          || pageResult.width! <= 0
          || pageResult.height! <= 0
          || pageResult.width! > 4096
          || pageResult.height! > 4096
        ) return failure(pageResult.code ?? "MERMAID_RENDER_FAILED", "Mermaid 流程图无法安全渲染或超出尺寸上限。");
        const width = pageResult.width!;
        const height = pageResult.height!;
        window.setContentSize(width, height, false);
        await window.webContents.executeJavaScript("new Promise((resolve) => requestAnimationFrame(() => resolve(true)))", true);
        const image = await window.webContents.capturePage({ x: 0, y: 0, width, height });
        const png = image.toPNG();
        if (image.isEmpty() || png.byteLength === 0) return failure("MERMAID_CAPTURE_EMPTY", "Mermaid 流程图截图为空。");
        const size = image.getSize();
        return { status: "completed", png, width: size.width, height: size.height } as MermaidRenderResult;
      })();
      const timedOut = new Promise<MermaidRenderResult>((resolve) => {
        timeout = setTimeout(() => {
          this.dispose();
          resolve(failure("MERMAID_RENDER_TIMED_OUT", "Mermaid 渲染超过 12 秒，隔离窗口已重置。"));
        }, MERMAID_TIMEOUT_MS);
      });
      return await Promise.race([operation, timedOut]);
    } catch {
      this.dispose();
      return failure("MERMAID_RENDER_PROCESS_FAILED", "Mermaid 隔离渲染窗口不可用。");
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
