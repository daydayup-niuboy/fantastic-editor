import { readFile, rm, writeFile } from "node:fs/promises";
import type { AiInvocationRequest, AiInvocationResult } from "@fantastic-editor/shared";
import { readBoundedResponseText } from "./bounded-response.js";

const ENDPOINT = "https://api.deepseek.com";
const KEY_RE = /^sk-[A-Za-z0-9_-]{16,200}$/;
type Protector = { isAvailable(): boolean; encrypt(value: string): string; decrypt(value: string): string };

export class DeepSeekApi {
  #controller: AbortController | null = null;
  constructor(readonly path: string, readonly protector: Protector, readonly fetcher: typeof fetch = fetch) {}
  async configured(): Promise<boolean> { return Boolean(await this.#key()); }
  async save(apiKey: string): Promise<boolean> {
    const key = apiKey.trim();
    if (!KEY_RE.test(key) || !this.protector.isAvailable()) return false;
    await writeFile(this.path, JSON.stringify({ schema: "fantastic-editor-deepseek-v1", encryptedApiKey: this.protector.encrypt(key) }), { encoding: "utf8", mode: 0o600 });
    return true;
  }
  async clear(): Promise<void> { await rm(this.path, { force: true }); }
  async test(): Promise<boolean> {
    const key = await this.#key(); if (!key) return false;
    try { const response = await this.fetcher(`${ENDPOINT}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) }); return response.ok; } catch { return false; }
  }
  cancel(): void { this.#controller?.abort(); }
  async invoke(request: AiInvocationRequest, prompt: string): Promise<AiInvocationResult> {
    const controller = new AbortController(); this.#controller = controller;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 180_000);
    const interrupted = (): AiInvocationResult => timedOut ? { status: "failed", code: "TIMEOUT", error: "AI 请求超时，已停止。" } : { status: "cancelled" };
    try {
      const key = await this.#key();
      if (controller.signal.aborted) return interrupted();
      if (!key) return { status: "failed", code: "PROVIDER_UNAVAILABLE", error: "请先配置 DeepSeek API Key。" };
      const response = await this.fetcher(`${ENDPOINT}/chat/completions`, { method: "POST", signal: controller.signal, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "deepseek-chat", messages: [{ role: "user", content: prompt }], stream: false }) });
      if (controller.signal.aborted) return interrupted();
      if (!response.ok) return { status: "failed", code: "API_FAILED", error: response.status === 401 ? "DeepSeek API Key 无效。" : `DeepSeek API 请求失败（${response.status}）。` };
      const text = await readBoundedResponseText(response, 320 * 1024);
      if (controller.signal.aborted) return interrupted();
      if (text === null) return { status: "failed", code: "RESULT_TOO_LARGE", error: "AI 返回内容超过 256 KiB 上限。" };
      const data = JSON.parse(text) as { choices?: Array<{ message?: { content?: unknown } }> };
      const result = data.choices?.[0]?.message?.content;
      if (typeof result === "string" && Buffer.byteLength(result) > 256 * 1024) return { status: "failed", code: "RESULT_TOO_LARGE", error: "AI 返回内容超过 256 KiB 上限。" };
      return typeof result === "string" && result.trim() ? { status: "completed", result: result.trim() } : { status: "failed", code: "API_FAILED", error: "DeepSeek 未返回有效建议。" };
    } catch { return controller.signal.aborted ? interrupted() : { status: "failed", code: "API_FAILED", error: "无法连接 DeepSeek API。" }; }
    finally { clearTimeout(timer); if (this.#controller === controller) this.#controller = null; }
  }
  async #key(): Promise<string | null> {
    if (!this.protector.isAvailable()) return null;
    try { const data = JSON.parse(await readFile(this.path, "utf8")) as { schema?: string; encryptedApiKey?: string }; return data.schema === "fantastic-editor-deepseek-v1" && typeof data.encryptedApiKey === "string" ? this.protector.decrypt(data.encryptedApiKey) : null; } catch { return null; }
  }
}
