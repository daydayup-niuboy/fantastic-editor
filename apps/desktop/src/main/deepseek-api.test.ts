import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { AiInvocationRequest } from "@fantastic-editor/shared";
import { DeepSeekApi } from "./deepseek-api";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const request: AiInvocationRequest = { requestId: "123e4567-e89b-42d3-a456-426614174000", providerId: "deepseek-api", scope: "selection", actionId: "polish", anchor: { documentId: "doc", sourceHash: "a".repeat(64), from: 0, to: 2, expectedText: "正文" }, content: "正文" };
async function service(fetcher: typeof fetch) {
  const root = await mkdtemp(join(tmpdir(), "deepseek-test-")); roots.push(root);
  return new DeepSeekApi(join(root, "config.json"), { isAvailable: () => true, encrypt: (value) => `encrypted:${value}`, decrypt: (value) => value.slice(10) }, fetcher);
}

describe("DeepSeek API boundary", () => {
  it("encrypts the key and sends only the prompt to the fixed official endpoint", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const api = await service(async (url, init) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify({ choices: [{ message: { content: "处理结果" } }] }), { status: 200 }); });
    expect(await api.save("sk-1234567890abcdefghijklmnop")).toBe(true);
    await expect(api.invoke(request, "安全提示\n正文")).resolves.toEqual({ status: "completed", result: "处理结果" });
    expect(calls[0]?.url).toBe("https://api.deepseek.com/chat/completions");
    expect(String(calls[0]?.init?.headers && (calls[0].init.headers as Record<string, string>).Authorization)).toContain("sk-");
    expect(String(calls[0]?.init?.body)).toContain("安全提示\\n正文");
  });

  it("rejects invalid keys, authentication failures and oversized results without exposing secrets", async () => {
    const denied = await service(async () => new Response("secret", { status: 401 }));
    expect(await denied.save("bad-key")).toBe(false);
    expect(await denied.save("sk-1234567890abcdefghijklmnop")).toBe(true);
    expect(JSON.stringify(await denied.invoke(request, "正文"))).not.toContain("secret");
    const oversized = await service(async () => new Response(JSON.stringify({ choices: [{ message: { content: "界".repeat(88_000) } }] }), { status: 200 }));
    await oversized.save("sk-1234567890abcdefghijklmnop");
    await expect(oversized.invoke(request, "正文")).resolves.toMatchObject({ status: "failed", code: "RESULT_TOO_LARGE" });
  });
});
