import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { BrowserWindow, session, type Session } from "electron";

export type FormulaRenderResult =
  | { status: "completed"; png: Uint8Array; width: number; height: number }
  | { status: "failed"; code: string; message: string };

interface FormulaPageResult {
  status: "completed" | "failed";
  width?: number;
  height?: number;
  code?: string;
}

const FORMULA_TIMEOUT_MS = 10_000;

function failure(code: string, message: string): FormulaRenderResult {
  return { status: "failed", code, message };
}

export class FormulaRenderWindow {
  #window: BrowserWindow | null = null;
  #session: Session | null = null;
  #tail: Promise<void> = Promise.resolve();

  renderFormula(latex: string, displayMode: boolean): Promise<FormulaRenderResult> {
    const task = this.#tail.then(() => this.renderOne(latex, displayMode));
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
    const isolatedSession = session.fromPartition(`fantastic-formula-${randomUUID()}`, { cache: false });
    isolatedSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, callback) => callback({ cancel: true }));
    const window = new BrowserWindow({
      width: 1600,
      height: 800,
      useContentSize: true,
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
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.on("closed", () => {
      if (this.#window === window) this.#window = null;
    });
    await window.loadFile(join(__dirname, "../renderer/formula.html"));
    const ready = await window.webContents.executeJavaScript("Boolean(window.fantasticFormulaRendererReady)", true) as boolean;
    if (!ready) {
      window.destroy();
      throw new Error("formula renderer did not initialize");
    }
    this.#session = isolatedSession;
    this.#window = window;
    return window;
  }

  private async renderOne(latex: string, displayMode: boolean): Promise<FormulaRenderResult> {
    if (typeof latex !== "string" || latex.length === 0 || latex.length > 100_000) {
      return failure("FORMULA_REQUEST_INVALID", "公式为空或超过 100,000 字符安全上限。");
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const operation = (async () => {
        const window = await this.ensureWindow();
        const payload = JSON.stringify({ latex, displayMode });
        const pageResult = await window.webContents.executeJavaScript(
          `window.renderFantasticFormula(${payload})`,
          true,
        ) as FormulaPageResult;
        if (
          pageResult.status !== "completed"
          || !Number.isInteger(pageResult.width)
          || !Number.isInteger(pageResult.height)
          || pageResult.width! <= 0
          || pageResult.height! <= 0
          || pageResult.width! > 4096
          || pageResult.height! > 2048
        ) {
          return failure(pageResult.code ?? "FORMULA_RENDER_FAILED", "公式无法安全渲染或超出尺寸上限。");
        }
        const width = pageResult.width!;
        const height = pageResult.height!;
        window.setContentSize(width, height, false);
        await window.webContents.executeJavaScript("new Promise((resolve) => requestAnimationFrame(() => resolve(true)))", true);
        const image = await window.webContents.capturePage({ x: 0, y: 0, width, height });
        const png = image.toPNG();
        if (image.isEmpty() || png.byteLength === 0) return failure("FORMULA_CAPTURE_EMPTY", "公式截图为空。");
        const size = image.getSize();
        return { status: "completed", png, width: size.width, height: size.height } as FormulaRenderResult;
      })();
      const timedOut = new Promise<FormulaRenderResult>((resolve) => {
        timeout = setTimeout(() => {
          this.dispose();
          resolve(failure("FORMULA_RENDER_TIMED_OUT", "公式渲染超过 10 秒，隔离窗口已重置。"));
        }, FORMULA_TIMEOUT_MS);
      });
      return await Promise.race([operation, timedOut]);
    } catch {
      this.dispose();
      return failure("FORMULA_RENDER_PROCESS_FAILED", "公式隔离渲染窗口不可用。");
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}