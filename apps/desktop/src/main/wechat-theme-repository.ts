import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  OFFICIAL_WECHAT_THEME_IDS,
  WECHAT_CUSTOM_THEME_ID_RE,
  WechatThemeError,
  buildWechatThemeDefinition,
  canonicalWechatThemeJson,
  normalizeWechatThemeTokens,
  resolveOfficialWechatTheme,
  validateWechatThemeName,
  type OfficialWechatThemeId,
  type ResolvedWechatTheme,
  type WechatThemeDefinition,
  type WechatThemeListItem,
  type WechatThemeOverlayFile,
  type WechatThemeOverlayInput,
  type WechatThemeTokens,
} from "@fantastic-editor/shared";
import { atomicWriteCandidate } from "./file-sessions.js";

export type WechatThemeStorage = "workspace" | "global";

export interface WechatThemeRepositoryOptions {
  globalRoot: string;
  workspaceRoot?: string | null;
}

interface StoredOverlay {
  file: WechatThemeOverlayFile;
  id: string;
  canonicalJson: string;
  slug: string;
  source: "workspace" | "global";
  path: string;
}

function hashCanonical(canonicalJson: string): string {
  return createHash("sha256").update(canonicalJson, "utf8").digest("hex").slice(0, 12);
}

function customId(baseThemeId: OfficialWechatThemeId, tokens: WechatThemeTokens): string {
  return `${baseThemeId}+${hashCanonical(canonicalWechatThemeJson(baseThemeId, tokens))}`;
}

function assertObject(value: unknown, message: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WechatThemeError("WECHAT_THEME_OVERLAY_SCHEMA_INVALID", message);
}

function parseOverlay(value: unknown): WechatThemeOverlayFile {
  assertObject(value, "主题 Overlay 必须是 JSON 对象。");
  const keys = Object.keys(value).sort();
  if (value.schemaVersion !== "0.1") {
    throw new WechatThemeError(value.schemaVersion === undefined ? "WECHAT_THEME_OVERLAY_SCHEMA_INVALID" : "WECHAT_THEME_UNSUPPORTED_VERSION", "主题 Overlay schemaVersion 必须是 0.1。");
  }
  if (keys.join("\0") !== ["baseThemeId", "name", "schemaVersion", "tokens"].join("\0")) {
    throw new WechatThemeError("WECHAT_THEME_OVERLAY_SCHEMA_INVALID", "主题 Overlay 含有未知字段。");
  }
  const name = validateWechatThemeName(value.name);
  if (typeof value.baseThemeId !== "string" || !OFFICIAL_WECHAT_THEME_IDS.includes(value.baseThemeId as OfficialWechatThemeId)) {
    throw new WechatThemeError("WECHAT_THEME_OVERLAY_SCHEMA_INVALID", "主题 baseThemeId 必须是官方主题 ID，不能使用历史别名。");
  }
  assertObject(value.tokens, "主题 tokens 必须是对象。");
  const tokenKeys = Object.keys(value.tokens).sort();
  const expected = ["accent", "align", "border", "codeBg", "codeText", "heading", "muted", "page", "sizeBodyPx", "text"].join("\0");
  if (tokenKeys.join("\0") !== expected) throw new WechatThemeError("WECHAT_THEME_OVERLAY_SCHEMA_INVALID", "磁盘 Overlay 必须包含完整且唯一的 10 个 Token。");
  const tokens = normalizeWechatThemeTokens(value.baseThemeId as OfficialWechatThemeId, value.tokens as WechatThemeOverlayInput["tokens"]);
  return { schemaVersion: "0.1", name, baseThemeId: value.baseThemeId as OfficialWechatThemeId, tokens };
}

function parseOverlayInput(value: unknown): WechatThemeOverlayInput {
  assertObject(value, "主题 Overlay 必须是 JSON 对象。");
  const keys = Object.keys(value).sort();
  const allowed = ["baseThemeId", "name", "schemaVersion", "tokens"].join("\0");
  if (value.schemaVersion !== "0.1") {
    throw new WechatThemeError(value.schemaVersion === undefined ? "WECHAT_THEME_OVERLAY_SCHEMA_INVALID" : "WECHAT_THEME_UNSUPPORTED_VERSION", "主题 Overlay schemaVersion 必须是 0.1。");
  }
  if (keys.join("\0") !== allowed) {
    throw new WechatThemeError("WECHAT_THEME_OVERLAY_SCHEMA_INVALID", "主题 Overlay 含有未知字段。");
  }
  const name = validateWechatThemeName(value.name);
  if (typeof value.baseThemeId !== "string" || !OFFICIAL_WECHAT_THEME_IDS.includes(value.baseThemeId as OfficialWechatThemeId)) {
    throw new WechatThemeError("WECHAT_THEME_OVERLAY_SCHEMA_INVALID", "主题 baseThemeId 必须是官方主题 ID，不能使用历史别名。");
  }
  assertObject(value.tokens, "主题 tokens 必须是对象。");
  return { schemaVersion: "0.1", name, baseThemeId: value.baseThemeId as OfficialWechatThemeId, tokens: normalizeWechatThemeTokens(value.baseThemeId as OfficialWechatThemeId, value.tokens as WechatThemeOverlayInput["tokens"]) };
}

async function jsonFiles(directory: string): Promise<string[]> {
  try {
    if (!(await stat(directory)).isDirectory()) return [];
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
      .map((entry) => join(directory, entry.name))
      .sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
  } catch {
    return [];
  }
}

export class WechatThemeRepository {
  readonly #globalRoot: string;
  readonly #workspaceRoot: string | null;

  constructor(options: WechatThemeRepositoryOptions) {
    this.#globalRoot = options.globalRoot;
    this.#workspaceRoot = options.workspaceRoot ?? null;
  }

  get workspaceRoot(): string | null { return this.#workspaceRoot; }
  get globalRoot(): string { return this.#globalRoot; }

  private async readDirectory(directory: string, source: "workspace" | "global"): Promise<StoredOverlay[]> {
    const result: StoredOverlay[] = [];
    for (const path of await jsonFiles(directory)) {
      try {
        const file = parseOverlay(JSON.parse(await readFile(path, "utf8")));
        const canonicalJson = canonicalWechatThemeJson(file.baseThemeId, file.tokens);
        result.push({ file, id: customId(file.baseThemeId, file.tokens), canonicalJson, slug: basename(path, ".json"), source, path });
      } catch {
        // Invalid files are intentionally not exposed in the UI list. Resolve reports missing/invalid IDs explicitly.
      }
    }
    return result;
  }

  async list(): Promise<WechatThemeListItem[]> {
    const official = OFFICIAL_WECHAT_THEME_IDS.map((id) => {
      const definition = resolveOfficialWechatTheme(id);
      return { id, name: definition.baseThemeId === "wechat-native-enhanced" ? "微信原生增强" : definition.baseThemeId === "minimal-ink" ? "极简墨白" : "深蓝科技", baseThemeId: id, source: "official" as const };
    });
    const workspace = this.#workspaceRoot ? await this.readDirectory(join(this.#workspaceRoot, "themes"), "workspace") : [];
    const global = await this.readDirectory(this.#globalRoot, "global");
    const workspaceSlugs = new Set(workspace.map((item) => item.slug.toLowerCase()));
    const seenIds = new Set<string>();
    const custom: WechatThemeListItem[] = [];
    for (const item of [...workspace, ...global.filter((entry) => !workspaceSlugs.has(entry.slug.toLowerCase()))]) {
      if (seenIds.has(item.id)) continue;
      seenIds.add(item.id);
      custom.push({ id: item.id, name: item.file.name, baseThemeId: item.file.baseThemeId, source: item.source, slug: item.slug, shortHash: item.id.slice(-12, -6) });
    }
    return [...official, ...custom];
  }

  async resolve(themeId: string): Promise<ResolvedWechatTheme> {
    const official = themeId === "wechat-green" || OFFICIAL_WECHAT_THEME_IDS.includes(themeId as OfficialWechatThemeId);
    if (official) {
      const definition = resolveOfficialWechatTheme(themeId);
      return { id: definition.id, baseThemeId: definition.baseThemeId, tokens: { ...definition.tokens }, definition, source: "official", name: WECHAT_THEME_OPTIONS_NAME[definition.baseThemeId] };
    }
    if (!WECHAT_CUSTOM_THEME_ID_RE.test(themeId)) throw new WechatThemeError("WECHAT_THEME_UNKNOWN", `未知公众号主题：${themeId}`);
    const [baseThemeId, requestedHash] = themeId.split("+") as [OfficialWechatThemeId, string];
    const workspace = this.#workspaceRoot ? await this.readDirectory(join(this.#workspaceRoot, "themes"), "workspace") : [];
    const global = await this.readDirectory(this.#globalRoot, "global");
    const matches = [...workspace, ...global].filter((item) => item.id === themeId && item.id.startsWith(`${baseThemeId}+${requestedHash}`));
    if (matches.length === 0) throw new WechatThemeError("WECHAT_THEME_OVERLAY_MISSING", `找不到自定义主题 ${themeId}。请把文章的 themes 目录一起复制过来，或重新选择一个可用的公众号主题。`);
    const canonical = new Set(matches.map((item) => item.canonicalJson));
    if (canonical.size > 1) throw new WechatThemeError("WECHAT_THEME_HASH_COLLISION", `自定义主题 ${themeId} 存在 Hash 碰撞，无法安全选择。`);
    const selected = matches.find((item) => item.source === "workspace") ?? matches[0]!;
    const definition = buildWechatThemeDefinition(selected.file.baseThemeId, selected.file.tokens);
    return { id: selected.id, baseThemeId: selected.file.baseThemeId, tokens: { ...selected.file.tokens }, definition: { ...definition, id: selected.id }, source: selected.source, name: selected.file.name };
  }

  async resolveWechatThemeForOutput(themeId: string): Promise<ResolvedWechatTheme> {
    return this.resolve(themeId);
  }

  async save(input: WechatThemeOverlayInput, storage: WechatThemeStorage = "workspace"): Promise<ResolvedWechatTheme> {
    assertObject(input, "自定义主题输入必须是对象。");
    if (Object.keys(input).sort().join("\0") !== ["baseThemeId", "name", "schemaVersion", "tokens"].join("\0")) {
      throw new WechatThemeError("WECHAT_THEME_OVERLAY_SCHEMA_INVALID", "自定义主题输入含有未知字段。");
    }
    if (input.schemaVersion !== "0.1") throw new WechatThemeError("WECHAT_THEME_UNSUPPORTED_VERSION", "主题 Overlay schemaVersion 必须是 0.1。");
    assertObject(input.tokens, "主题 tokens 必须是对象。");
    if (storage === "workspace" && !this.#workspaceRoot) throw new WechatThemeError("WECHAT_THEME_OVERLAY_SCHEMA_INVALID", "当前文档没有可写入的 Markdown 工作区。");
    if (!OFFICIAL_WECHAT_THEME_IDS.includes(input.baseThemeId)) throw new WechatThemeError("WECHAT_THEME_OVERLAY_SCHEMA_INVALID", "自定义主题必须基于官方主题，不能使用历史别名。");
    const file: WechatThemeOverlayFile = { schemaVersion: "0.1", name: validateWechatThemeName(input.name), baseThemeId: input.baseThemeId, tokens: normalizeWechatThemeTokens(input.baseThemeId, input.tokens) };
    const id = customId(file.baseThemeId, file.tokens);
    const root = storage === "workspace" ? join(this.#workspaceRoot!, "themes") : this.#globalRoot;
    const slug = `custom-${randomUUID().slice(0, 8)}`;
    const path = join(root, `${slug}.json`);
    const bytes = new TextEncoder().encode(JSON.stringify(file, null, 2) + "\n");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(root, { recursive: true });
    await atomicWriteCandidate(path, bytes);
    const definition = buildWechatThemeDefinition(file.baseThemeId, file.tokens);
    return { id, baseThemeId: file.baseThemeId, tokens: { ...file.tokens }, definition: { ...definition, id }, source: storage, name: file.name };
  }

  async importFile(filePath: string, storage: WechatThemeStorage = "workspace"): Promise<ResolvedWechatTheme> {
    const input = parseOverlayInput(JSON.parse(await readFile(filePath, "utf8")));
    return this.save(input, storage);
  }

  async export(themeId: string): Promise<WechatThemeOverlayFile> {
    const resolved = await this.resolve(themeId);
    if (resolved.source === "official") throw new WechatThemeError("WECHAT_THEME_OVERLAY_SCHEMA_INVALID", "官方主题不能导出为自定义 Overlay。");
    const folder = resolved.source === "workspace" ? join(this.#workspaceRoot!, "themes") : this.#globalRoot;
    for (const path of await jsonFiles(folder)) {
      try {
        const file = parseOverlay(JSON.parse(await readFile(path, "utf8")));
        if (customId(file.baseThemeId, file.tokens) === resolved.id) return file;
      } catch {
        // Ignore invalid files while locating the resolved overlay.
      }
    }
    throw new WechatThemeError("WECHAT_THEME_OVERLAY_MISSING", `找不到自定义主题 ${themeId}。`);
  }

  async delete(themeId: string, currentThemeId?: string): Promise<void> {
    if (currentThemeId && themeId === currentThemeId) throw new WechatThemeError("WECHAT_THEME_IN_USE", "当前主题正在使用，请先选择其它公众号主题，再删除此主题。");
    const resolved = await this.resolve(themeId);
    if (resolved.source === "official") throw new WechatThemeError("WECHAT_THEME_IN_USE", "官方主题不能删除。");
    let removed = 0;
    const folders = [...(this.#workspaceRoot ? [join(this.#workspaceRoot, "themes")] : []), this.#globalRoot];
    for (const folder of folders) {
      for (const path of await jsonFiles(folder)) {
        try {
          const file = parseOverlay(JSON.parse(await readFile(path, "utf8")));
          if (customId(file.baseThemeId, file.tokens) === resolved.id) {
            await rm(path, { force: true });
            removed += 1;
          }
        } catch {
          // Ignore invalid files while locating the resolved overlay.
        }
      }
    }
    if (removed > 0) return;
    throw new WechatThemeError("WECHAT_THEME_OVERLAY_MISSING", `找不到自定义主题 ${themeId}。`);
  }
}

const WECHAT_THEME_OPTIONS_NAME: Record<OfficialWechatThemeId, string> = {
  "wechat-native-enhanced": "微信原生增强",
  "minimal-ink": "极简墨白",
  "deep-blue-tech": "深蓝科技",
};

export { customId as buildWechatCustomThemeId, hashCanonical as hashWechatThemeCanonicalJson, parseOverlay as parseWechatThemeOverlay };
