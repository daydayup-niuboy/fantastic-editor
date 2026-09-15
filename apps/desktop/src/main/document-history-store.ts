import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DocumentHistoryItem } from "@fantastic-editor/shared";

const MAX_SNAPSHOTS = 20;
const MAX_CHARACTERS = 10_000_000;
type Snapshot = DocumentHistoryItem & { schema: "fantastic-editor-history-v1"; contentHash: string; editorText: string };

export class DocumentHistoryStore {
  constructor(readonly root: string) {}
  async record(path: string, editorText: string): Promise<void> {
    if (!path || editorText.length > MAX_CHARACTERS) return;
    const directory = this.#directory(path); await mkdir(directory, { recursive: true });
    const contentHash = createHash("sha256").update(editorText).digest("hex");
    const existing = await this.#snapshots(directory);
    if (existing[0]?.contentHash === contentHash) return;
    const snapshot: Snapshot = { schema: "fantastic-editor-history-v1", snapshotId: randomUUID(), createdAt: new Date().toISOString(), characterCount: editorText.length, contentHash, editorText };
    await writeFile(join(directory, `${snapshot.createdAt.replace(/[:.]/g, "-")}-${snapshot.snapshotId}.json`), JSON.stringify(snapshot), { encoding: "utf8", mode: 0o600 });
    const files = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort().reverse();
    await Promise.all(files.slice(MAX_SNAPSHOTS).map((name) => rm(join(directory, name), { force: true })));
  }
  async list(path: string): Promise<DocumentHistoryItem[]> {
    return (await this.#snapshots(this.#directory(path))).map(({ snapshotId, createdAt, characterCount }) => ({ snapshotId, createdAt, characterCount }));
  }
  async read(path: string, snapshotId: string): Promise<string | null> {
    if (!/^[0-9a-f-]{36}$/i.test(snapshotId)) return null;
    return (await this.#snapshots(this.#directory(path))).find((item) => item.snapshotId === snapshotId)?.editorText ?? null;
  }
  #directory(path: string): string { return join(this.root, createHash("sha256").update(path.toLocaleLowerCase()).digest("hex")); }
  async #snapshots(directory: string): Promise<Snapshot[]> {
    try {
      const files = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort().reverse();
      const values = await Promise.all(files.map(async (name) => { try { const value = JSON.parse(await readFile(join(directory, name), "utf8")) as Snapshot; return value.schema === "fantastic-editor-history-v1" && typeof value.editorText === "string" ? value : null; } catch { return null; } }));
      return values.filter((value): value is Snapshot => Boolean(value));
    } catch { return []; }
  }
}
