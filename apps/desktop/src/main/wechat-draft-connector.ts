import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { CreateWechatDraftResult, PublishWechatArticleResult, TestWechatApiConnectionResult } from "@fantastic-editor/shared";
import type { WechatDraftPayload } from "./output-service.js";

const API_ROOT = "https://api.weixin.qq.com/cgi-bin";
const PUBLIC_IP_URL = "https://api.ipify.org?format=json";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ARTICLE_BYTES = 1024 * 1024;
const MAX_COVER_BYTES = 10 * 1024 * 1024;
const MAX_UPLOAD_CONCURRENCY = 4;
const PUBLISH_POLL_INTERVAL_MS = 1_000;
const PUBLISH_POLL_ATTEMPTS = 30;
const PUBLISH_MAX_DURATION_MS = 90_000;

export interface WechatDraftConnectorConfig {
  appId: string;
  appSecret: string;
  coverPath: string;
}

export interface WechatDraftConnectorInput {
  payload: WechatDraftPayload;
  config: WechatDraftConnectorConfig;
}

type FetchLike = typeof fetch;
type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function errorMessage(value: unknown, fallback: string): string {
  if (isRecord(value)) {
    const message = stringValue(value.errmsg) ?? stringValue(value.message);
    if (message) return message.slice(0, 300);
  }
  return fallback;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function validateConfig(config: WechatDraftConnectorConfig): string | null {
  if (!config.appId) return "尚未配置公众号 AppID。请在主界面的“公众号设置”中填写。";
  if (!/^[\w-]{4,128}$/.test(config.appId)) return "公众号 AppID 格式无效。";
  if (!config.appSecret) return "尚未配置公众号 AppSecret。请在主界面的“公众号设置”中填写。";
  if (!/^[\w-]{8,256}$/.test(config.appSecret)) return "公众号 AppSecret 格式无效。";
  if (!config.coverPath) return "尚未配置公众号封面路径。请设置 FANTASTIC_EDITOR_WECHAT_COVER_PATH。";
  if (config.coverPath.length > 4096) return "公众号封面图片路径过长。";
  return null;
}

function validateRemoteUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(url.hostname)) return null;
    const hostname = url.hostname.toLowerCase();
    if (!hostname.endsWith(".qpic.cn") && !hostname.endsWith(".weixin.qq.com")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function validIpv4(value: unknown): string | null {
  if (typeof value !== "string" || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) return null;
  return value.split(".").every((part) => Number(part) <= 255) ? value : null;
}

function publishStatusMessage(status: number): string {
  return ({
    2: "原创声明校验失败",
    3: "微信发布失败",
    4: "平台审核未通过",
    5: "文章发布后已被删除",
    6: "文章发布后被系统封禁",
  } as Record<number, string>)[status] ?? `微信返回未知发布状态 ${status}`;
}

function articleUrlFromStatus(value: JsonRecord): string | null {
  const detail = value.article_detail;
  if (!isRecord(detail) || !Array.isArray(detail.item)) return null;
  const first = detail.item[0];
  return isRecord(first) ? stringValue(first.article_url) : null;
}

async function readJson(response: Response): Promise<JsonRecord> {
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`微信接口返回非 JSON（HTTP ${response.status}）。`);
  }
  if (!isRecord(parsed)) throw new Error("微信接口返回结构无效。");
  if (!response.ok) throw new Error(errorMessage(parsed, `微信接口请求失败（HTTP ${response.status}）。`));
  const errorCode = typeof parsed.errcode === "number" ? parsed.errcode : 0;
  if (errorCode !== 0) throw new Error(`微信接口失败（${errorCode}）：${errorMessage(parsed, "未知错误")}`);
  return parsed;
}

async function requestJson(fetchImpl: FetchLike, url: string, init?: RequestInit): Promise<JsonRecord> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await readJson(await fetchImpl(url, { ...init, signal: controller.signal }));
  } catch (error) {
    if (controller.signal.aborted) throw new Error("微信接口请求超时。");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function uploadForm(fetchImpl: FetchLike, url: string, bytes: Uint8Array, mimeType: string, filename: string): Promise<JsonRecord> {
  const form = new FormData();
  form.append("media", new Blob([Buffer.from(bytes)], { type: mimeType }), filename);
  return requestJson(fetchImpl, url, { method: "POST", body: form });
}

async function mapConcurrent<T, R>(values: readonly T[], concurrency: number, worker: (value: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let cursor = 0;
  const run = async () => {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await worker(values[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, values.length)) }, () => run()));
  return results;
}

function replacementImage(item: WechatDraftPayload["replacementItems"][number], url: string): string {
  const style = item.placement === "inline"
    ? "display:inline-block;max-width:100%;height:auto;vertical-align:middle;margin:0 2px;"
    : "display:block;max-width:100%;height:auto;margin:1em auto;";
  return `<img src="${escapeHtml(url)}" alt="${escapeHtml(item.label)}" style="${style}">`;
}

export function configFromEnvironment(env: NodeJS.ProcessEnv = process.env): WechatDraftConnectorConfig {
  return {
    appId: env.FANTASTIC_EDITOR_WECHAT_APP_ID ?? "",
    appSecret: env.FANTASTIC_EDITOR_WECHAT_APP_SECRET ?? "",
    coverPath: env.FANTASTIC_EDITOR_WECHAT_COVER_PATH ?? "",
  };
}

export class WechatDraftConnector {
  readonly #fetch: FetchLike;

  constructor(fetchImpl: FetchLike = fetch) {
    this.#fetch = fetchImpl;
  }

  async testConnection(config: WechatDraftConnectorConfig): Promise<TestWechatApiConnectionResult> {
    const credentialError = validateConfig({ ...config, coverPath: config.coverPath || "connection-test-cover" });
    if (credentialError) return { status: "failed", error: credentialError };
    try {
      await this.accessToken(config);
      let ip: string | null = null;
      try {
        ip = validIpv4((await requestJson(this.#fetch, PUBLIC_IP_URL)).ip);
      } catch {
        // 公网 IP 查询失败不应覆盖已经成功的微信接口检测结果。
      }
      return {
        status: "ready",
        ip,
        message: ip
          ? `公众号接口连接正常；当前公网 IP ${ip} 已在微信白名单中。`
          : "公众号接口连接正常，当前网络已在微信白名单中；公网 IP 查询暂不可用。",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "公众号接口连接检测失败。";
      const ip = /invalid ip\s+((?:\d{1,3}\.){3}\d{1,3})\b/i.exec(message)?.[1];
      if (ip) {
        return {
          status: "whitelist-required",
          ip,
          message: `微信拒绝了当前公网 IP ${ip}。请将它加入该公众号的 IP 白名单。`,
        };
      }
      return { status: "failed", error: message };
    }
  }

  async create(input: WechatDraftConnectorInput): Promise<CreateWechatDraftResult> {
    const configError = validateConfig(input.config);
    if (configError) return { status: "failed", error: configError };
    if (input.payload.replacementItems.length !== input.payload.replacements.size) {
      return { status: "failed", error: "公众号任务替换资源不完整，不能创建自动草稿。" };
    }
    const title = input.payload.title.trim().slice(0, 120) || "fantastic-editor 草稿";
    let uploadedImageCount = 0;
    try {
      const token = await this.accessToken(input.config);
      const uploaded = await mapConcurrent(input.payload.replacementItems, MAX_UPLOAD_CONCURRENCY, async (item) => {
        const source = input.payload.replacements.get(item.itemId);
        if (!source || source.bytes.byteLength === 0) throw new Error(`替换项 ${item.sequence} 图片字节缺失。`);
        const extension = item.mimeType === "image/jpeg" ? ".jpg" : item.mimeType === "image/gif" ? ".gif" : ".png";
        const response = await uploadForm(this.#fetch, `${API_ROOT}/media/uploadimg?access_token=${encodeURIComponent(token)}`, source.bytes, item.mimeType, `fantastic-editor-${item.itemId}${extension}`);
        const url = stringValue(response.url);
        const safeUrl = url ? validateRemoteUrl(url) : null;
        if (!safeUrl) throw new Error(`替换项 ${item.sequence} 未获得有效的微信图片地址。`);
        uploadedImageCount += 1;
        return { item, url: safeUrl };
      });

      let html = input.payload.html;
      for (const { item, url } of uploaded) {
        const marker = escapeHtml(item.placeholderText);
        if (!html.includes(marker)) throw new Error(`正文缺少第 ${item.sequence} 项占位标记。`);
        html = html.replaceAll(marker, replacementImage(item, url));
      }
      if (/【FE(?:图片|公式|流程图)\d{2,5}｜(?:行内替换|整段替换)】/.test(html)) {
        throw new Error("正文仍含未替换的 fantastic-editor 图片标记。 ");
      }
      const htmlBytes = new TextEncoder().encode(html);
      if (htmlBytes.byteLength > MAX_ARTICLE_BYTES) throw new Error("微信草稿正文超过 1 MiB 接口安全上限，请减少内容或图片数量。 ");

      const cover = await readFile(input.config.coverPath);
      if (cover.byteLength === 0) throw new Error("公众号封面图片为空。 ");
      if (cover.byteLength > MAX_COVER_BYTES) throw new Error("公众号封面图片超过 10 MiB 安全上限。 ");
      const coverExtension = extname(input.config.coverPath).toLowerCase();
      if (coverExtension !== ".png" && coverExtension !== ".jpg" && coverExtension !== ".jpeg") throw new Error("公众号封面只支持 PNG 或 JPEG 文件。 ");
      const coverMime = coverExtension === ".png" ? "image/png" : "image/jpeg";
      const coverResponse = await uploadForm(this.#fetch, `${API_ROOT}/material/add_material?access_token=${encodeURIComponent(token)}&type=thumb`, new Uint8Array(cover), coverMime, basename(input.config.coverPath));
      const thumbMediaId = stringValue(coverResponse.media_id);
      if (!thumbMediaId) throw new Error("微信未返回有效的封面素材 ID。 ");

      const draft = await requestJson(this.#fetch, `${API_ROOT}/draft/add?access_token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ articles: [{ article_type: "news", title, author: "", digest: "", content: html, content_source_url: "", thumb_media_id: thumbMediaId, need_open_comment: 0, only_fans_can_comment: 0 }] }),
      });
      const draftMediaId = stringValue(draft.media_id);
      if (!draftMediaId) throw new Error("微信未返回有效的草稿 ID。 ");
      const verified = await requestJson(this.#fetch, `${API_ROOT}/draft/get?access_token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ media_id: draftMediaId }),
      });
      if (typeof verified.errcode === "number" && verified.errcode !== 0) throw new Error(errorMessage(verified, "草稿回读失败。"));
      return { status: "created", draftMediaId, uploadedImageCount, verified: true };
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : "创建公众号草稿失败。", uploadedImageCount };
    }
  }

  async publish(draftMediaId: string, config: WechatDraftConnectorConfig): Promise<PublishWechatArticleResult> {
    if (!draftMediaId || draftMediaId.length > 256) return { status: "failed", error: "公众号草稿 ID 无效。" };
    const credentialError = validateConfig(config);
    if (credentialError) return { status: "failed", error: credentialError, draftMediaId };
    try {
      const token = await this.accessToken(config);
      const submitted = await requestJson(this.#fetch, `${API_ROOT}/freepublish/submit?access_token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ media_id: draftMediaId }),
      });
      const publishId = stringValue(submitted.publish_id);
      if (!publishId) return { status: "failed", error: "微信未返回有效的发布任务 ID。", draftMediaId };

      const deadline = Date.now() + PUBLISH_MAX_DURATION_MS;
      for (let attempt = 0; attempt < PUBLISH_POLL_ATTEMPTS && Date.now() < deadline; attempt += 1) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, PUBLISH_POLL_INTERVAL_MS));
        const status = await requestJson(this.#fetch, `${API_ROOT}/freepublish/get?access_token=${encodeURIComponent(token)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ publish_id: publishId }),
        });
        const publishStatus = typeof status.publish_status === "number" ? status.publish_status : null;
        if (publishStatus === 0) {
          return { status: "published", draftMediaId, publishId, articleUrl: articleUrlFromStatus(status), verified: true };
        }
        if (publishStatus !== 1) {
          return { status: "failed", error: `${publishStatus === null ? "微信未返回发布状态" : publishStatus + "：" + publishStatusMessage(publishStatus)}。`, draftMediaId, publishId };
        }
      }
      return { status: "processing", draftMediaId, publishId, message: "微信已接受发布任务，但审核仍在进行中；请稍后在公众号后台查看。" };
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : "提交公众号发布失败。", draftMediaId };
    }
  }

  private async accessToken(config: WechatDraftConnectorConfig): Promise<string> {
    const response = await requestJson(this.#fetch, `${API_ROOT}/token?grant_type=client_credential&appid=${encodeURIComponent(config.appId)}&secret=${encodeURIComponent(config.appSecret)}`);
    const token = stringValue(response.access_token);
    if (!token) throw new Error("微信未返回 access_token。 ");
    return token;
  }
}
