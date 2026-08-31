import { readFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute } from "node:path";
import type { WechatApiConfigSummary } from "@fantastic-editor/shared";
import type { WechatDraftConnectorConfig } from "./wechat-draft-connector.js";

const CONFIG_SCHEMA = "fantastic-editor-wechat-api-config-v1";
const MAX_COVER_BYTES = 10 * 1024 * 1024;

interface StoredWechatApiConfig {
  schema: typeof CONFIG_SCHEMA;
  appId: string;
  encryptedAppSecret: string;
  coverPath: string;
  updatedAt: string;
}

export interface WechatSecretProtector {
  isAvailable(): boolean;
  encrypt(value: string): string;
  decrypt(value: string): string;
}

export interface SaveStoredWechatApiConfig {
  appId: string;
  appSecret?: string;
  coverPath: string;
}

function validRecord(value: unknown): value is StoredWechatApiConfig {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<StoredWechatApiConfig>;
  return record.schema === CONFIG_SCHEMA
    && typeof record.appId === "string"
    && typeof record.encryptedAppSecret === "string"
    && typeof record.coverPath === "string"
    && typeof record.updatedAt === "string";
}

function emptySummary(): WechatApiConfigSummary {
  return {
    appId: "",
    hasAppSecret: false,
    coverPath: "",
    coverDisplayName: null,
    configured: false,
    source: "none",
  };
}

export class WechatApiConfigStore {
  readonly #storagePath: string;
  readonly #protector: WechatSecretProtector;

  constructor(storagePath: string, protector: WechatSecretProtector) {
    if (!isAbsolute(storagePath)) throw new Error("公众号配置存储路径必须是绝对路径。");
    this.#storagePath = storagePath;
    this.#protector = protector;
  }

  async summary(): Promise<WechatApiConfigSummary> {
    const record = await this.#readRecord();
    if (!record) return emptySummary();
    return {
      appId: record.appId,
      hasAppSecret: record.encryptedAppSecret.length > 0,
      coverPath: record.coverPath,
      coverDisplayName: record.coverPath ? basename(record.coverPath) : null,
      configured: Boolean(record.appId && record.encryptedAppSecret && record.coverPath),
      source: "stored",
    };
  }

  async connectorConfig(): Promise<WechatDraftConnectorConfig | null> {
    const record = await this.#readRecord();
    if (!record) return null;
    if (!this.#protector.isAvailable()) throw new Error("当前系统无法解密已保存的公众号 AppSecret。");
    let appSecret: string;
    try {
      appSecret = this.#protector.decrypt(record.encryptedAppSecret);
    } catch {
      throw new Error("公众号 AppSecret 解密失败，请清除配置后重新填写。");
    }
    return { appId: record.appId, appSecret, coverPath: record.coverPath };
  }

  async save(input: SaveStoredWechatApiConfig): Promise<WechatApiConfigSummary> {
    const appId = input.appId.trim();
    const coverPath = input.coverPath.trim();
    if (!/^[\w-]{4,128}$/.test(appId)) throw new Error("公众号 AppID 格式无效。");
    if (!isAbsolute(coverPath) || coverPath.length > 4096) throw new Error("请选择有效的本地封面图片。");
    const extension = extname(coverPath).toLowerCase();
    if (![".png", ".jpg", ".jpeg"].includes(extension)) throw new Error("公众号封面只支持 PNG 或 JPEG 文件。");
    const coverInfo = await stat(coverPath).catch(() => null);
    if (!coverInfo?.isFile()) throw new Error("封面图片不存在或无法读取。");
    if (coverInfo.size <= 0 || coverInfo.size > MAX_COVER_BYTES) throw new Error("封面图片为空或超过 10 MiB 上限。");
    if (!this.#protector.isAvailable()) throw new Error("当前系统无法安全加密 AppSecret，配置未保存。");

    const existing = await this.#readRecord();
    const submittedSecret = input.appSecret?.trim() ?? "";
    if (submittedSecret && !/^[\w-]{8,256}$/.test(submittedSecret)) throw new Error("公众号 AppSecret 格式无效。");
    if (!submittedSecret && !existing?.encryptedAppSecret) throw new Error("请填写公众号 AppSecret。");
    const encryptedAppSecret = submittedSecret
      ? this.#protector.encrypt(submittedSecret)
      : existing!.encryptedAppSecret;
    const record: StoredWechatApiConfig = {
      schema: CONFIG_SCHEMA,
      appId,
      encryptedAppSecret,
      coverPath,
      updatedAt: new Date().toISOString(),
    };
    await mkdir(dirname(this.#storagePath), { recursive: true });
    await writeFile(this.#storagePath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return this.summary();
  }

  async clear(): Promise<WechatApiConfigSummary> {
    await rm(this.#storagePath, { force: true });
    return emptySummary();
  }

  async #readRecord(): Promise<StoredWechatApiConfig | null> {
    try {
      const parsed = JSON.parse(await readFile(this.#storagePath, "utf8")) as unknown;
      return validRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}
