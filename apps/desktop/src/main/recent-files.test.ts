import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { RecentFileStore } from "./recent-files";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()))) throw new Error("Unsafe temporary test path.");
    await rm(root, { recursive: true, force: true });
  }
});

describe("RecentFileStore", () => {
  it("exposes opaque ids and display names without renderer-visible paths", async () => {
    const temporaryBase = resolve(tmpdir());
    await mkdir(temporaryBase, { recursive: true });
    const root = await mkdtemp(join(temporaryBase, "fantastic-recent-"));
    roots.push(root);
    const article = join(root, "article.md");
    await writeFile(article, "# Article\n");
    const store = new RecentFileStore(join(root, "recent.json"));
    await store.remember(article);
    const items = await store.list();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ displayName: "article.md" });
    expect(items[0]).not.toHaveProperty("path");
    expect(await store.resolve(items[0]!.recentId)).toBe(await import("node:fs/promises").then(({ realpath }) => realpath(article)));
  });

  it("deduplicates paths, persists order and forgets stale ids", async () => {
    const temporaryBase = resolve(tmpdir());
    await mkdir(temporaryBase, { recursive: true });
    const root = await mkdtemp(join(temporaryBase, "fantastic-recent-"));
    roots.push(root);
    const first = join(root, "first.md");
    const second = join(root, "second.markdown");
    await writeFile(first, "first");
    await writeFile(second, "second");
    const storage = join(root, "recent.json");
    const store = new RecentFileStore(storage);
    await store.remember(first);
    await store.remember(second);
    await store.remember(first);
    const items = await new RecentFileStore(storage).list();
    expect(items.map((item) => item.displayName)).toEqual(["first.md", "second.markdown"]);
    await store.forget(items[0]!.recentId);
    expect((await store.list()).map((item) => item.displayName)).toEqual(["second.markdown"]);
    expect(await readFile(storage, "utf8")).toContain("second.markdown");
  });
});
