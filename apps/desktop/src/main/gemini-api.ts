import { readFile, rm, writeFile } from "node:fs/promises";
import type { AiInvocationRequest, AiInvocationResult } from "@fantastic-editor/shared";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta";
const MODEL = "gemini-3.8-flash";
const KEY_RE = /^[A-Za-z0-9._-]{20,200}$/;
type Protector = { isAvailable(): boolean; encrypt(value: string): string; decrypt(value: string): string };

export class GeminiApi {
  #controller: AbortController | null = null;
  constructor(readonly path: string, readonly protector: Protector, readonly fetcher: typeof fetch = fetch) {}
  async configured(): Promise<boolean> { return Boolean(await this.#key()); }
  async save(apiKey: string): Promise<boolean> {
    const key = apiKey.trim();
    if (!KEY_RE.test(key) || !this.protector.isAvailable()) return false;
    await writeFile(this.path, JSON.stringify({ schema: "fantastic-editor-gemini-v1", encryptedApiKey: this.protector.encrypt(key) }), { encoding: "utf8", mode: 0o600 });
    return true;
  }
  async clear(): Promise<void> { await rm(this.path, { force: true }); }
  async test(): Promise<boolean> {
    const key = await this.#key(); if (!key) return false;
    try { const response = await this.fetcher(`${ENDPOINT}/models/${MODEL}`, { headers: { "x-goog-api-key": key } }); return response.ok; } catch { return false; }
  }
  cancel(): void { this.#controller?.abort(); }
  async invoke(_request: AiInvocationRequest, prompt: string): Promise<AiInvocationResult> {
    const key = await this.#key();
    if (!key) return { status: "failed", code: "PROVIDER_UNAVAILABLE", error: "请先配置 Gemini API Key。" };
    const controller = new AbortController(); this.#controller = controller;
    const timer = setTimeout(() => controller.abort(), 180_000);
    try {
      const request = () => this.fetcher(`${ENDPOINT}/models/${MODEL}:generateContent`, { method: "POST", signal: controller.signal, headers: { "x-goog-api-key": key, "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }] }) });
      let response = await request();
      if (!response.ok && (response.status === 408 || response.status === 429 || response.status >= 500)) {
        await new Promise((resolve) => setTimeout(resolve, 1_000 + Math.floor(Math.random() * 250)));
        if (controller.signal.aborted) return { status: "cancelled" };
        response = await request();
      }
      if (!response.ok) return { status: "failed", code: "API_FAILED", error: response.status === 400 || response.status === 401 || response.status === 403
        ? "Gemini API Key 无效或没有 3.8 Flash 模型权限。"
        : response.status === 429
          ? "Gemini API 请求过于频繁或额度不足（429），请稍后重试。"
          : response.status === 503
            ? "Gemini 3.8 Flash 服务暂时不可用（503），自动重试仍失败，请稍后再试。"
            : `Gemini API 临时请求失败（${response.status}），请稍后重试。` };
      const text = await response.text();
      if (Buffer.byteLength(text) > 320 * 1024) return { status: "failed", code: "RESULT_TOO_LARGE", error: "AI 返回内容超过 256 KiB 上限。" };
      const data = JSON.parse(text) as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> };
      const result = data.candidates?.[0]?.content?.parts?.flatMap((part) => typeof part.text === "string" ? [part.text] : []).join("") ?? "";
      if (Buffer.byteLength(result) > 256 * 1024) return { status: "failed", code: "RESULT_TOO_LARGE", error: "AI 返回内容超过 256 KiB 上限。" };
      return result.trim() ? { status: "completed", result: result.trim() } : { status: "failed", code: "API_FAILED", error: "Gemini 未返回有效建议，内容可能被安全策略拦截。" };
    } catch { return controller.signal.aborted ? { status: "cancelled" } : { status: "failed", code: "API_FAILED", error: "无法连接 Gemini API。" }; }
    finally { clearTimeout(timer); if (this.#controller === controller) this.#controller = null; }
  }
  async #key(): Promise<string | null> {
    if (!this.protector.isAvailable()) return null;
    try { const data = JSON.parse(await readFile(this.path, "utf8")) as { schema?: string; encryptedApiKey?: string }; return data.schema === "fantastic-editor-gemini-v1" && typeof data.encryptedApiKey === "string" ? this.protector.decrypt(data.encryptedApiKey) : null; } catch { return null; }
  }
}
