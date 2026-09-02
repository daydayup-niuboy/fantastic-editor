import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("renderer theme boundary", () => {
  it("keeps overlay filesystem and custom-id parsing out of Renderer", async () => {
    const sources = await Promise.all([
      readFile(new URL("../renderer/src/App.tsx", import.meta.url), "utf8"),
      readFile(new URL("../renderer/src/WechatThemePreview.tsx", import.meta.url), "utf8"),
    ]);
    const source = sources.join("\n");
    expect(source).not.toMatch(/from\s+["']node:(?:fs|path|crypto)/);
    expect(source).not.toMatch(/readdir|readFile|writeFile|mkdir|randomUUID/);
    expect(source).not.toMatch(/split\(["']\+["']\).*buildWechatThemeDefinition/s);
  });
});
