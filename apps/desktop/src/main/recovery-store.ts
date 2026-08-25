import { randomUUID } from "node:crypto";
import { open, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { FileFingerprint, TextEncoding } from "@fantastic-editor/shared";

const RECOVERY_SCHEMA = "fantastic-editor-recovery";
const MAX_RECOVERY_FILES = 3;
const MAX_SNAPSHOT_BYTES = 52 * 1024 * 1024;

export interface RecoveryEntry {
  sessionId: string;
  path: string | null;
  displayName: string;
  editorText: string;
  isUntitled: boolean;
  encoding: TextEncoding;
  lineSeparator: "lf" | "crlf";
  fingerprint: FileFingerprint;
  requiresSave?: boolean;
}

export interface RecoverySnapshot {
  schema: typeof RECOVERY_SCHEMA;
  version: 1;
  createdAt: string;
  activeSessionId: string | null;
  entries: RecoveryEntry[];
}

function isFingerprint(value: unknown): value is FileFingerprint {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<FileFingerprint>;
  return [item.byteLength, item.mtimeMs, item.ctimeMs].every((field) => typeof field === "number" && Number.isFinite(field) && field >= 0);
}

function parseSnapshot(value: unknown): RecoverySnapshot | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<RecoverySnapshot>;
  if (candidate.schema !== RECOVERY_SCHEMA || candidate.version !== 1 || typeof candidate.createdAt !== "string" || !Array.isArray(candidate.entries)) return null;
  if (candidate.activeSessionId !== null && typeof candidate.activeSessionId !== "string") return null;
  if (candidate.entries.length > 50) return null;
  for (const entry of candidate.entries) {
    if (!entry || typeof entry !== "object") return null;
    const item = entry as Partial<RecoveryEntry>;
    if (
      typeof item.sessionId !== "string"
      || (item.path !== null && typeof item.path !== "string")
      || typeof item.displayName !== "string"
      || typeof item.editorText !== "string"
      || item.editorText.length > 10 * 1024 * 1024
      || typeof item.isUntitled !== "boolean"
      || !["utf-8", "utf-8-bom"].includes(item.encoding ?? "")
      || !["lf", "crlf"].includes(item.lineSeparator ?? "")
      || !isFingerprint(item.fingerprint)
      || (item.requiresSave !== undefined && typeof item.requiresSave !== "boolean")
    ) return null;
  }
  return candidate as RecoverySnapshot;
}

export class RecoveryStore {
  constructor(private readonly directory: string) {}

  async write(snapshot: RecoverySnapshot): Promise<void> {
    const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
    if (bytes.byteLength > MAX_SNAPSHOT_BYTES) throw new Error("恢复快照超过 52 MiB 安全上限。");
    await mkdir(this.directory, { recursive: true });
    const generation = process.hrtime.bigint().toString().padStart(20, "0");
    const fileName = `snapshot-${Date.now()}-${generation}-${randomUUID()}.json`;
    const handle = await open(join(this.directory, fileName), "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.prune();
  }

  async readLatest(): Promise<RecoverySnapshot | null> {
    let files: string[];
    try {
      files = (await readdir(this.directory))
        .filter((name) => /^snapshot-\d+-(?:\d+-)?[\da-f-]+\.json$/i.test(name))
        .sort()
        .reverse();
    } catch {
      return null;
    }
    for (const name of files) {
      try {
        const bytes = await readFile(join(this.directory, name));
        if (bytes.byteLength > MAX_SNAPSHOT_BYTES) continue;
        const snapshot = parseSnapshot(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
        if (snapshot) return snapshot;
      } catch {
        // Try the previous complete generation.
      }
    }
    return null;
  }

  async clear(): Promise<void> {
    await rm(this.directory, { recursive: true, force: true });
  }

  private async prune(): Promise<void> {
    const files = (await readdir(this.directory))
      .filter((name) => /^snapshot-\d+-(?:\d+-)?[\da-f-]+\.json$/i.test(name))
      .sort()
      .reverse();
    await Promise.all(files.slice(MAX_RECOVERY_FILES).map((name) => rm(join(this.directory, name), { force: true }).catch(() => undefined)));
  }
}



