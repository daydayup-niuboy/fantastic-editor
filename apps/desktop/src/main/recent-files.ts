import { randomUUID } from "node:crypto";
import { readFile, realpath, stat, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute } from "node:path";
import type { RecentFileEntry } from "@fantastic-editor/shared";

interface StoredRecentFile extends RecentFileEntry {
  path: string;
}

const MAX_RECENT_FILES = 10;

function validStoredEntry(value: unknown): value is StoredRecentFile {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<StoredRecentFile>;
  return typeof item.recentId === "string" && item.recentId.length > 0
    && typeof item.displayName === "string" && item.displayName.length > 0
    && typeof item.lastOpenedAt === "string" && Number.isFinite(Date.parse(item.lastOpenedAt))
    && typeof item.path === "string" && isAbsolute(item.path) && item.path.length <= 32_768;
}

export class RecentFileStore {
  readonly #storagePath: string;
  #entries: StoredRecentFile[] | null = null;

  constructor(storagePath: string) {
    if (!isAbsolute(storagePath)) throw new Error("最近文件存储路径必须是绝对路径。");
    this.#storagePath = storagePath;
  }

  async list(): Promise<RecentFileEntry[]> {
    await this.#load();
    return this.#entries!.map(({ recentId, displayName, lastOpenedAt }) => ({ recentId, displayName, lastOpenedAt }));
  }

  async remember(filePath: string): Promise<void> {
    if (!isAbsolute(filePath) || filePath.length > 32_768 || ![".md", ".markdown"].includes(extname(filePath).toLowerCase())) return;
    const canonicalPath = await realpath(filePath);
    const info = await stat(canonicalPath);
    if (!info.isFile()) return;
    await this.#load();
    const normalized = canonicalPath.toLocaleLowerCase("en-US");
    const existing = this.#entries!.find((entry) => entry.path.toLocaleLowerCase("en-US") === normalized);
    const entry: StoredRecentFile = {
      recentId: existing?.recentId ?? randomUUID(),
      displayName: basename(canonicalPath),
      lastOpenedAt: new Date().toISOString(),
      path: canonicalPath,
    };
    this.#entries = [entry, ...this.#entries!.filter((item) => item.recentId !== entry.recentId)].slice(0, MAX_RECENT_FILES);
    await this.#persist();
  }

  async resolve(recentId: string): Promise<string | null> {
    await this.#load();
    return this.#entries!.find((entry) => entry.recentId === recentId)?.path ?? null;
  }

  async forget(recentId: string): Promise<void> {
    await this.#load();
    const next = this.#entries!.filter((entry) => entry.recentId !== recentId);
    if (next.length === this.#entries!.length) return;
    this.#entries = next;
    await this.#persist();
  }

  async #load(): Promise<void> {
    if (this.#entries) return;
    try {
      const parsed = JSON.parse(await readFile(this.#storagePath, "utf8")) as unknown;
      this.#entries = Array.isArray(parsed) ? parsed.filter(validStoredEntry).slice(0, MAX_RECENT_FILES) : [];
    } catch {
      this.#entries = [];
    }
  }

  async #persist(): Promise<void> {
    await mkdir(dirname(this.#storagePath), { recursive: true });
    await writeFile(this.#storagePath, JSON.stringify(this.#entries, null, 2), { encoding: "utf8", mode: 0o600 });
  }
}
