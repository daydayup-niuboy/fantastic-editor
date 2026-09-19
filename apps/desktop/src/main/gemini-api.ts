import { readFile, rm, writeFile } from "node:fs/promises";
import type { AiInvocationRequest, AiInvocationResult } from "@fantastic-editor/shared";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta";
const MODEL = "gemini-3.8-flash";
const KEY_RE = /^[A-Za-z0-9._-]{20,200}$/;
const MAX_RETRIES = 4;
type Protector = { isAvailable(): boolean; encrypt(value: string): string; decrypt(value: string): string };

function retryable(status: number): boolean { return status === 408 || status === 429 || (status >= 500 && status <= 599); }
function retryDelay(attempt: number): number { return Math.min(8_000, 1_000 * 2 ** attempt) + Math.floor(Math.random() * 250); }
function apiError(status: number): string {
  if (status === 400) return "Gemini API 拒绝了请求参数（400）。当前软件固定使用 3.8 Flash，请升级软件或检查该模型是否向你的项目开放。";
  if (status === 401 || status === 403) return "Gemini API Key 无效、已被停用，或没有 3.8 Flash 模型权限。";
  if (status === 404) return "当前 Google 项目找不到 Gemini 3.8 Flash（404）。请检查 AI Studio 中该模型是否可用；程序不会自动切换模型。";
  if (status === 429) return "Gemini 项目配额或速率限制已用尽（429），自动重试仍失败。请稍后再试；免费层可能达到 RPM、TPM 或 RPD 限额，同一项目下的 API Key 共用配额。";
  if (status === 503) return "Gemini 3.8 Flash 服务暂时不可用（503），指数退避重试仍失败，请稍后再试。";
  return `Gemini API 临时请求失败（${status}），指数退避重试仍失败，请稍后再试。`;
}

export class GeminiApi {
  #controller: AbortController | null = null;
  constructor(readonly path: string, readonly protector: Protector, readonly fetcher: typeof fetch = fetch, readonly wait: (ms: number) => Promise<unknown> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {}
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
      for (let attempt = 0; !response.ok && retryable(response.status) && attempt < MAX_RETRIES; attempt++) {
        await this.wait(retryDelay(attempt));
        if (controller.signal.aborted) return { status: "cancelled" };
        response = await request();
      }
      if (!response.ok) return { status: "failed", code: "API_FAILED", error: apiError(response.status) };
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
