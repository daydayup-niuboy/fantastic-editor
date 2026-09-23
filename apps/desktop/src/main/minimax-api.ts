import { readFile, rm, writeFile } from "node:fs/promises";
import type { AiInvocationRequest, AiInvocationResult } from "@fantastic-editor/shared";

const ENDPOINT = "https://api.minimax.cn/v1";
const MODEL = "MiniMax-M3";
const KEY_RE = /^[A-Za-z0-9._-]{16,512}$/;
type Protector = { isAvailable(): boolean; encrypt(value: string): string; decrypt(value: string): string };

function assistantMessageText(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const text = content.map((part) => typeof part === "string" ? part : typeof part === "object" && part && "text" in part && typeof part.text === "string" ? part.text : "").join("");
  return text.trim() || null;
}

function apiError(status: number): string {
  if (status === 400) return "MiniMax API 拒绝了请求参数（400）。当前软件固定使用 MiniMax M3，请升级软件或检查该模型是否向你的账号开放。";
  if (status === 401) return "MiniMax API Key 无效或已被停用（401）。";
  if (status === 403) return "MiniMax API Key 没有访问该模型的权限（403）。";
  if (status === 429) return "MiniMax 账号额度或速率限制已用尽（429），请充值或稍后再试。";
  if (status >= 500) return "MiniMax 服务暂时不可用（" + status + "），请稍后再试。";
  return `MiniMax API 请求失败（${status}）。`;
}

export class MiniMaxApi {
  #controller: AbortController | null = null;
  constructor(readonly path: string, readonly protector: Protector, readonly fetcher: typeof fetch = fetch) {}
  async configured(): Promise<boolean> { return Boolean(await this.#key()); }
  async save(apiKey: string): Promise<boolean> {
    const key = apiKey.trim();
    if (!KEY_RE.test(key) || !this.protector.isAvailable()) return false;
    await writeFile(this.path, JSON.stringify({ schema: "fantastic-editor-minimax-v1", encryptedApiKey: this.protector.encrypt(key) }), { encoding: "utf8", mode: 0o600 });
    return true;
  }
  async clear(): Promise<void> { await rm(this.path, { force: true }); }
  async test(): Promise<boolean> {
    const key = await this.#key(); if (!key) return false;
    try {
      // MiniMax 没有独立的模型列表接口，用最小补全请求验证 Key 与模型权限。
      const response = await this.fetcher(`${ENDPOINT}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "ping" }], max_completion_tokens: 1, stream: false }) });
      return response.ok || response.status === 429;
    } catch { return false; }
  }
  cancel(): void { this.#controller?.abort(); }
  async invoke(_request: AiInvocationRequest, prompt: string): Promise<AiInvocationResult> {
    const key = await this.#key();
    if (!key) return { status: "failed", code: "PROVIDER_UNAVAILABLE", error: "请先配置 MiniMax API Key。" };
    const controller = new AbortController(); this.#controller = controller;
    const timer = setTimeout(() => controller.abort(), 180_000);
    try {
      // reasoning_split 把思考内容放到 reasoning_content，正文仍只取 message.content。
      const response = await this.fetcher(`${ENDPOINT}/chat/completions`, { method: "POST", signal: controller.signal, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: prompt }], stream: false, reasoning_split: true }) });
      if (!response.ok) return { status: "failed", code: "API_FAILED", error: apiError(response.status) };
      const text = await response.text();
      if (Buffer.byteLength(text) > 320 * 1024) return { status: "failed", code: "RESULT_TOO_LARGE", error: "AI 返回内容超过 256 KiB 上限。" };
      const data = JSON.parse(text) as { choices?: Array<{ message?: { content?: unknown } }> };
      const result = assistantMessageText(data.choices?.[0]?.message?.content);
      if (result && Buffer.byteLength(result) > 256 * 1024) return { status: "failed", code: "RESULT_TOO_LARGE", error: "AI 返回内容超过 256 KiB 上限。" };
      return result ? { status: "completed", result } : { status: "failed", code: "API_FAILED", error: "MiniMax 未返回有效建议，内容可能被安全策略拦截。" };
    } catch (error) { return controller.signal.aborted ? { status: "cancelled" } : { status: "failed", code: "API_FAILED", error: "无法连接 MiniMax API。" }; }
    finally { clearTimeout(timer); if (this.#controller === controller) this.#controller = null; }
  }
  async #key(): Promise<string | null> {
    if (!this.protector.isAvailable()) return null;
    try { const data = JSON.parse(await readFile(this.path, "utf8")) as { schema?: string; encryptedApiKey?: string }; return data.schema === "fantastic-editor-minimax-v1" && typeof data.encryptedApiKey === "string" ? this.protector.decrypt(data.encryptedApiKey) : null; } catch { return null; }
  }
}
