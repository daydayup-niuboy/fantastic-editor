import { readFile, rm, writeFile } from "node:fs/promises";
import type { AiInvocationRequest, AiInvocationResult, OpenAiCompatibleConfigSaveRequest, OpenAiCompatibleConfigSummary, OpenAiCompatibleModelSlot } from "@fantastic-editor/shared";
import { readBoundedResponseText } from "./bounded-response.js";

const KEY_MIN = 8;
const KEY_MAX = 1_000;
const MODEL_LIST_LIMIT = 1024 * 1024;
const MODEL_ID_MAX = 200;
const NAME_MAX = 80;
const TIMEOUT_MS = 20_000;
type Protector = { isAvailable(): boolean; encrypt(value: string): string; decrypt(value: string): string };
type StoredConfig = {
  schema: "fantastic-editor-openai-compatible-v1";
  encryptedApiKey: string;
  baseUrl: string;
  providerName: string;
  localName: string;
  modelSlots: [OpenAiCompatibleModelSlot | null, OpenAiCompatibleModelSlot | null];
  modelOptions: string[];
};

export function normalizeBaseUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2_000 || /[?#]/.test(trimmed)) return null;
  let url: URL;
  try { url = new URL(trimmed); } catch { return null; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  const normalized = url.toString().replace(/\/+$/, "");
  return normalized;
}

function cleanLabel(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, NAME_MAX) : "";
}

function validModelId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= MODEL_ID_MAX && !/[\s\u0000-\u001f\u007f]/.test(value);
}

function validSlot(value: unknown): value is OpenAiCompatibleModelSlot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const slot = value as Partial<OpenAiCompatibleModelSlot>;
  return Object.keys(slot).length === 2 && validModelId(slot.modelId) && typeof slot.localName === "string" && slot.localName.length <= NAME_MAX;
}

function validModelOptions(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 500 && value.every(validModelId) && new Set(value).size === value.length;
}

function assistantMessageText(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const text = content.map((part) => typeof part === "string" ? part : typeof part === "object" && part && "text" in part && typeof part.text === "string" ? part.text : "").join("");
  return text.trim() || null;
}

export function parseModelList(value: unknown): string[] {
  const items = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { data?: unknown }).data)
      ? (value as { data: unknown[] }).data
      : null;
  if (!items) throw new Error("模型列表格式不是标准 OpenAI /models 响应。");
  const models = items.flatMap((item) => {
    if (typeof item === "string") return validModelId(item) ? [item.trim()] : [];
    if (!item || typeof item !== "object") return [];
    const id = (item as { id?: unknown }).id;
    return validModelId(id) ? [id.trim()] : [];
  });
  if (models.length === 0) throw new Error("服务未返回可用模型。");
  return [...new Set(models)].slice(0, 500);
}

export function validateConfigSaveRequest(value: unknown): value is OpenAiCompatibleConfigSaveRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Partial<OpenAiCompatibleConfigSaveRequest>;
  const keys = Object.keys(request);
  return keys.length === (request.modelOptions === undefined ? 5 : 6)
    && keys.every((key) => ["baseUrl", "apiKey", "providerName", "localName", "modelSlots", "modelOptions"].includes(key))
    && normalizeBaseUrl(request.baseUrl) !== null
    && typeof request.apiKey === "string"
    && typeof request.providerName === "string" && request.providerName.length <= NAME_MAX
    && typeof request.localName === "string" && request.localName.length <= NAME_MAX
    && Array.isArray(request.modelSlots) && request.modelSlots.length === 2
    && request.modelSlots.every((slot) => slot === null || validSlot(slot))
    && (request.modelOptions === undefined || validModelOptions(request.modelOptions));
}
export function validateModelListRequest(value: unknown): value is { baseUrl: string; apiKey?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as { baseUrl?: unknown; apiKey?: unknown };
  const keys = Object.keys(request);
  return (keys.length === 1 || (keys.length === 2 && Object.hasOwn(request, "apiKey")))
    && keys.every((key) => key === "baseUrl" || key === "apiKey")
    && normalizeBaseUrl(request.baseUrl) !== null
    && (request.apiKey === undefined || typeof request.apiKey === "string");
}
function endpoint(baseUrl: string, path: string): string { return `${baseUrl}/${path}`; }

function apiError(status: number): string {
  if (status === 401 || status === 403) return "API Key 无效、已停用或没有访问权限。";
  if (status === 404) return "订阅地址未找到 OpenAI 兼容接口，请检查地址是否包含正确的 /v1 等路径。";
  if (status === 429) return "接口额度或速率限制已用尽，请稍后再试。";
  if (status >= 500) return `服务暂时不可用（${status}），请稍后再试。`;
  return `API 请求失败（${status}）。`;
}

export class OpenAiCompatibleApi {
  #controller: AbortController | null = null;
  constructor(readonly path: string, readonly protector: Protector, readonly fetcher: typeof fetch = fetch) {}

  async configured(): Promise<boolean> {
    const config = await this.#read();
    return Boolean(config && await this.#key(config) && config.modelSlots.some((slot) => slot));
  }

  async summary(): Promise<OpenAiCompatibleConfigSummary | null> {
    const config = await this.#read();
    if (!config) return null;
    return {
      configured: Boolean(await this.#key(config) && config.modelSlots.some((slot) => slot)),
      baseUrl: config.baseUrl,
      providerName: config.providerName,
      localName: config.localName,
      modelSlots: config.modelSlots,
      modelOptions: config.modelOptions,
    };
  }

  async save(request: OpenAiCompatibleConfigSaveRequest): Promise<boolean> {
    if (!validateConfigSaveRequest(request)) return false;
    const baseUrl = normalizeBaseUrl(request.baseUrl);
    const existing = await this.#read();
    const apiKey = typeof request.apiKey === "string" ? request.apiKey.trim() : "";
    const resolvedKey = apiKey || (existing ? await this.#key(existing) : null);
    if (!baseUrl || !this.protector.isAvailable() || !resolvedKey || resolvedKey.length < KEY_MIN || resolvedKey.length > KEY_MAX || /[\s]/.test(resolvedKey)) return false;
    if (!Array.isArray(request.modelSlots) || request.modelSlots.length !== 2 || request.modelSlots.some((slot) => slot !== null && !validSlot(slot))) return false;
    const modelOptions = request.modelOptions ?? existing?.modelOptions ?? [];
    if (!validModelOptions(modelOptions)) return false;
    const stored: StoredConfig = {
      schema: "fantastic-editor-openai-compatible-v1",
      encryptedApiKey: this.protector.encrypt(resolvedKey),
      baseUrl,
      providerName: cleanLabel(request.providerName) || "OpenAI 兼容服务",
      localName: cleanLabel(request.localName) || "自定义 API",
      modelSlots: [request.modelSlots[0] ?? null, request.modelSlots[1] ?? null],
      modelOptions,
    };
    await writeFile(this.path, JSON.stringify(stored), { encoding: "utf8", mode: 0o600 });
    return true;
  }

  async clear(): Promise<void> { await rm(this.path, { force: true }); }

  async test(baseUrlValue?: unknown, apiKeyValue?: unknown): Promise<boolean> {
    const stored = await this.#read();
    const baseUrl = normalizeBaseUrl(baseUrlValue) ?? stored?.baseUrl ?? null;
    const apiKey = typeof apiKeyValue === "string" && apiKeyValue.trim() ? apiKeyValue.trim() : stored ? await this.#key(stored) : null;
    if (!baseUrl || !apiKey) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await this.fetcher(endpoint(baseUrl, "models"), { method: "GET", redirect: "error", signal: controller.signal, headers: { Authorization: `Bearer ${apiKey}` } });
      return response.ok || response.status === 429;
    } catch { return false; }
    finally { clearTimeout(timer); }
  }

  async listModels(baseUrlValue: unknown, apiKeyValue?: unknown): Promise<string[]> {
    const baseUrl = normalizeBaseUrl(baseUrlValue);
    const stored = await this.#read();
    const apiKey = typeof apiKeyValue === "string" && apiKeyValue.trim() ? apiKeyValue.trim() : stored ? await this.#key(stored) : null;
    if (!baseUrl || !apiKey) throw new Error("请先填写订阅地址和 API Key。");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await this.fetcher(endpoint(baseUrl, "models"), {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!response.ok) throw new Error(apiError(response.status));
      const text = await readBoundedResponseText(response, MODEL_LIST_LIMIT);
      if (text === null) throw new Error("模型列表过大，无法读取。");
      return parseModelList(JSON.parse(text) as unknown);
    } catch (error) {
      if (controller.signal.aborted) throw new Error("获取模型列表超时，请检查订阅地址和网络。");
      if (error instanceof Error && (error.message.includes("模型列表") || error.message.includes("API Key") || error.message.includes("订阅地址") || error.message.includes("API 请求") || error.message.includes("服务暂时") || error.message.includes("额度"))) throw error;
      throw new Error("无法连接订阅地址，请检查地址、网络和跨域/证书设置。");
    } finally { clearTimeout(timer); }
  }

  cancel(): void { this.#controller?.abort(); }

  async invoke(request: AiInvocationRequest, prompt: string): Promise<AiInvocationResult> {
    const controller = new AbortController();
    this.#controller = controller;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 180_000);
    const interrupted = (): AiInvocationResult => timedOut
      ? { status: "failed", code: "TIMEOUT", error: "AI 请求超时，已停止。" }
      : { status: "cancelled" };
    try {
      const config = await this.#read();
      const apiKey = config ? await this.#key(config) : null;
      const model = config && request.modelSlot !== undefined ? config.modelSlots[request.modelSlot]?.modelId : undefined;
      if (controller.signal.aborted) return interrupted();
      if (!config || !apiKey || !model) return { status: "failed", code: "PROVIDER_UNAVAILABLE", error: "请先配置订阅地址、API Key 和至少一个模型。" };
      const response = await this.fetcher(endpoint(config.baseUrl, "chat/completions"), {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], stream: false }),
      });
      if (controller.signal.aborted) return interrupted();
      if (!response.ok) return { status: "failed", code: "API_FAILED", error: apiError(response.status) };
      const text = await readBoundedResponseText(response, 320 * 1024);
      if (controller.signal.aborted) return interrupted();
      if (text === null) return { status: "failed", code: "RESULT_TOO_LARGE", error: "AI 返回内容超过 256 KiB 上限。" };
      const data = JSON.parse(text) as { choices?: Array<{ message?: { content?: unknown } }> };
      const result = assistantMessageText(data.choices?.[0]?.message?.content);
      if (result && Buffer.byteLength(result) > 256 * 1024) return { status: "failed", code: "RESULT_TOO_LARGE", error: "AI 返回内容超过 256 KiB 上限。" };
      return result ? { status: "completed", result } : { status: "failed", code: "API_FAILED", error: "服务未返回有效建议。" };
    } catch {
      return controller.signal.aborted ? interrupted() : { status: "failed", code: "API_FAILED", error: "无法连接自定义 OpenAI 兼容 API。" };
    } finally {
      clearTimeout(timer);
      if (this.#controller === controller) this.#controller = null;
    }
  }

  async #key(config: StoredConfig): Promise<string | null> {
    if (!this.protector.isAvailable()) return null;
    try { return this.protector.decrypt(config.encryptedApiKey); } catch { return null; }
  }

  async #read(): Promise<StoredConfig | null> {
    try {
      const data = JSON.parse(await readFile(this.path, "utf8")) as Partial<StoredConfig>;
      if (data.schema !== "fantastic-editor-openai-compatible-v1" || typeof data.encryptedApiKey !== "string" || typeof data.baseUrl !== "string" || normalizeBaseUrl(data.baseUrl) === null || typeof data.providerName !== "string" || typeof data.localName !== "string" || !Array.isArray(data.modelSlots) || data.modelSlots.length !== 2 || !validModelOptions(data.modelOptions)) return null;
      return { ...data, schema: "fantastic-editor-openai-compatible-v1", baseUrl: normalizeBaseUrl(data.baseUrl)!, modelSlots: [data.modelSlots[0] ?? null, data.modelSlots[1] ?? null], modelOptions: data.modelOptions } as StoredConfig;
    } catch { return null; }
  }
}
