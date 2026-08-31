import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { WechatApiConfigStore, type WechatSecretProtector } from "./wechat-api-config-store";

const roots: string[] = [];
const protector: WechatSecretProtector = {
  isAvailable: () => true,
  encrypt: (value) => Buffer.from(`protected:${value}`, "utf8").toString("base64"),
  decrypt: (value) => Buffer.from(value, "base64").toString("utf8").replace(/^protected:/, ""),
};

afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()))) throw new Error("Unsafe temporary test path.");
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const temporaryBase = resolve(tmpdir());
  await mkdir(temporaryBase, { recursive: true });
  const root = await mkdtemp(join(temporaryBase, "fantastic-wechat-config-"));
  roots.push(root);
  const coverPath = join(root, "cover.png");
  await writeFile(coverPath, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  return { root, coverPath, storagePath: join(root, "wechat-api.json") };
}

describe("WechatApiConfigStore", () => {
  it("persists the secret only through the system protector and never exposes it in summaries", async () => {
    const { coverPath, storagePath } = await fixture();
    const store = new WechatApiConfigStore(storagePath, protector);
    const summary = await store.save({ appId: "wx1234567890abcdef", appSecret: "secret-12345678", coverPath });
    expect(summary).toMatchObject({ appId: "wx1234567890abcdef", hasAppSecret: true, configured: true, source: "stored" });
    expect(summary).not.toHaveProperty("appSecret");
    const persisted = await readFile(storagePath, "utf8");
    expect(persisted).not.toContain("secret-12345678");
    expect(await store.connectorConfig()).toEqual({ appId: "wx1234567890abcdef", appSecret: "secret-12345678", coverPath });
  });

  it("retains an existing encrypted secret when the edit form leaves it blank", async () => {
    const { coverPath, storagePath } = await fixture();
    const store = new WechatApiConfigStore(storagePath, protector);
    await store.save({ appId: "wx1234567890abcdef", appSecret: "secret-12345678", coverPath });
    await store.save({ appId: "wxabcdef1234567890", coverPath });
    expect(await store.connectorConfig()).toEqual({ appId: "wxabcdef1234567890", appSecret: "secret-12345678", coverPath });
  });

  it("clears all locally persisted values", async () => {
    const { coverPath, storagePath } = await fixture();
    const store = new WechatApiConfigStore(storagePath, protector);
    await store.save({ appId: "wx1234567890abcdef", appSecret: "secret-12345678", coverPath });
    expect(await store.clear()).toMatchObject({ configured: false, source: "none" });
    expect(await store.connectorConfig()).toBeNull();
  });
});
