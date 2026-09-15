import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { DocumentHistoryStore } from "./document-history-store";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("document history", () => {
  it("deduplicates consecutive saves, restores by opaque id and retains twenty versions", async () => {
    const root = await mkdtemp(join(tmpdir(), "fantastic-history-")); roots.push(root);
    const store = new DocumentHistoryStore(root); const path = "C:\\docs\\article.md";
    await store.record(path, "same"); await store.record(path, "same");
    expect(await store.list(path)).toHaveLength(1);
    for (let index = 0; index < 22; index++) await store.record(path, `version-${index}`);
    const items = await store.list(path);
    expect(items).toHaveLength(20);
    expect(await store.read(path, items[0]!.snapshotId)).toBe("version-21");
    expect(await store.read(path, "../../secret")).toBeNull();
  });
});
