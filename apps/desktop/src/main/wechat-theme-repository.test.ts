import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { WechatThemeError } from "@fantastic-editor/shared";
import { WechatThemeRepository, parseWechatThemeOverlay } from "./wechat-theme-repository.js";

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "fantastic-editor-theme-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  const globalRoot = join(root, "global");
  await mkdir(workspaceRoot, { recursive: true });
  return { root, workspaceRoot, globalRoot, repository: new WechatThemeRepository({ workspaceRoot, globalRoot }) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("WechatThemeRepository", () => {
  it("saves a partial input as an immutable full 10-token overlay", async () => {
    const { repository, workspaceRoot } = await fixture();
    const saved = await repository.save({ schemaVersion: "0.1", name: " 品牌绿 ", baseThemeId: "minimal-ink", tokens: { accent: "#07C160", page: "#FFFFFF", sizeBodyPx: 17, align: "justify" } });

    expect(saved.id).toMatch(/^minimal-ink\+[0-9a-f]{12}$/);
    expect(saved.name).toBe("品牌绿");
    expect(saved.tokens.accent).toBe("#07c160");
    expect(saved.tokens.page).toBe("#fefefe");
    expect(Object.keys(saved.tokens)).toHaveLength(10);
    const files = await readdir(join(workspaceRoot, "themes"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^custom-[0-9a-f]{8}\.json$/);
    const disk = JSON.parse(await readFile(join(workspaceRoot, "themes", files[0]!), "utf8"));
    expect(parseWechatThemeOverlay(disk).tokens).toEqual(saved.tokens);
  });

  it("lists official themes first and resolves the legacy alias only at read time", async () => {
    const { repository } = await fixture();
    const listed = await repository.list();
    expect(listed.slice(0, 3).map((theme) => theme.id)).toEqual(["wechat-native-enhanced", "minimal-ink", "deep-blue-tech"]);
    expect((await repository.resolve("wechat-green")).id).toBe("wechat-native-enhanced");
    await expect(repository.resolve("unknown")).rejects.toMatchObject({ code: "WECHAT_THEME_UNKNOWN" });
  });

  it("fails closed for missing custom overlays and prevents deleting the active theme", async () => {
    const { repository } = await fixture();
    await expect(repository.resolve("minimal-ink+000000000000")).rejects.toMatchObject({ code: "WECHAT_THEME_OVERLAY_MISSING" });
    const saved = await repository.save({ schemaVersion: "0.1", name: "可删除", baseThemeId: "minimal-ink", tokens: { accent: "#123456" } });
    await expect(repository.delete(saved.id, saved.id)).rejects.toMatchObject({ code: "WECHAT_THEME_IN_USE" });
    await repository.delete(saved.id, "wechat-native-enhanced");
    await expect(repository.resolve(saved.id)).rejects.toMatchObject({ code: "WECHAT_THEME_OVERLAY_MISSING" });
  });

  it("deletes every stored copy of the same content-addressed theme", async () => {
    const { repository } = await fixture();
    const input = { schemaVersion: "0.1" as const, name: "重复主题", baseThemeId: "minimal-ink" as const, tokens: { accent: "#345678" } };
    const workspace = await repository.save(input, "workspace");
    const global = await repository.save(input, "global");
    expect(global.id).toBe(workspace.id);

    await repository.delete(workspace.id, "minimal-ink");

    expect((await repository.list()).some((theme) => theme.id === workspace.id)).toBe(false);
    await expect(repository.resolve(workspace.id)).rejects.toMatchObject({ code: "WECHAT_THEME_OVERLAY_MISSING" });
  });

  it("rejects unknown root and token properties before import writes a file", async () => {
    const { repository, root } = await fixture();
    const badRoot = join(root, "bad-root.json");
    await writeFile(badRoot, JSON.stringify({ schemaVersion: "0.1", name: "危险", baseThemeId: "minimal-ink", tokens: {}, style: "display:flex" }));
    await expect(repository.importFile(badRoot)).rejects.toBeInstanceOf(WechatThemeError);
    const badToken = join(root, "bad-token.json");
    await writeFile(badToken, JSON.stringify({ schemaVersion: "0.1", name: "危险", baseThemeId: "minimal-ink", tokens: { customCss: "display:flex" } }));
    await expect(repository.importFile(badToken)).rejects.toMatchObject({ code: "WECHAT_THEME_INVALID_TOKEN" });
  });
});
