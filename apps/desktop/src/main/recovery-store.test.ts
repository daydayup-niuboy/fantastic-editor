import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RecoveryStore, type RecoverySnapshot } from "./recovery-store.js";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = resolve(await mkdtemp(join(tmpdir(), "fantastic-editor-recovery-test-")));
  if (!directory.startsWith(resolve(tmpdir()))) throw new Error("Unsafe temporary test path.");
  temporaryDirectories.push(directory);
  return directory;
}

function snapshot(editorText: string): RecoverySnapshot {
  return {
    schema: "fantastic-editor-recovery",
    version: 1,
    createdAt: new Date().toISOString(),
    activeSessionId: "session-1",
    entries: [{
      sessionId: "session-1",
      path: null,
      displayName: "未命名",
      editorText,
      isUntitled: true,
      encoding: "utf-8",
      lineSeparator: "lf",
      fingerprint: { byteLength: 0, mtimeMs: 0, ctimeMs: 0 },
      requiresSave: false,
    }],
  };
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("RecoveryStore", () => {
  it("returns the newest complete generation", async () => {
    const directory = await createTemporaryDirectory();
    const store = new RecoveryStore(directory);
    await store.write(snapshot("first"));
    await store.write(snapshot("second"));
    expect((await store.readLatest())?.entries[0]?.editorText).toBe("second");
  });

  it("falls back when the newest generation is corrupt", async () => {
    const directory = await createTemporaryDirectory();
    const store = new RecoveryStore(directory);
    await store.write(snapshot("complete"));
    await store.write(snapshot("newest"));
    const newest = (await readdir(directory)).sort().at(-1)!;
    await writeFile(join(directory, newest), "{broken", "utf8");
    expect((await store.readLatest())?.entries[0]?.editorText).toBe("complete");
  });

  it("accepts version 1 snapshots written before the requiresSave field", async () => {
    const directory = await createTemporaryDirectory();
    const store = new RecoveryStore(directory);
    await store.write(snapshot("legacy"));
    const fileName = (await readdir(directory))[0]!;
    const legacy = snapshot("legacy") as RecoverySnapshot & { entries: Array<Record<string, unknown>> };
    delete legacy.entries[0]!.requiresSave;
    await writeFile(join(directory, fileName), JSON.stringify(legacy), "utf8");
    expect((await store.readLatest())?.entries[0]?.editorText).toBe("legacy");
  });
  it("clears every recovery generation", async () => {
    const directory = await createTemporaryDirectory();
    const store = new RecoveryStore(directory);
    await store.write(snapshot("draft"));
    await store.clear();
    expect(await store.readLatest()).toBeNull();
  });
});


