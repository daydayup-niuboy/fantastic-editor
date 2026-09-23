import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { AiInvocationRequest } from "@fantastic-editor/shared";
import { MiniMaxApi } from "./minimax-api";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const request: AiInvocationRequest = { requestId: "123e4567-e89b-42d3-a456-426614174000", providerId: "minimax-api", scope: "selection", actionId: "polish", anchor: { documentId: "doc", sourceHash: "a".repeat(64), from: 0, to: 2, expectedText: "正文" }, content: "正文" };
const validKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.fake-minimax-test-key.0001";
async function service(fetcher: typeof fetch) {
  const root = await mkdtemp(join(tmpdir(), "minimax-test-")); roots.push(root);
  return new MiniMaxApi(join(root, "config.json"), { isAvailable: () => true, encrypt: (value) => `encrypted:${value}`, decrypt: (value) => value.slice(10) }, fetcher);
}

describe("MiniMax API boundary", () => {
  it("encrypts the key and sends only the prompt to the fixed official endpoint and model", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const api = await service(async (url, init) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify({ choices: [{ message: { content: "处理结果", reasoning_content: "思考中" } }] }), { status: 200 }); });
    expect(await api.save(validKey)).toBe(true);
    await expect(api.invoke(request, "安全提示\n正文")).resolves.toEqual({ status: "completed", result: "处理结果" });
    expect(calls[0]?.url).toBe("https://api.minimax.cn/v1/chat/completions");
    expect(String((calls[0]?.init?.headers as Record<string, string> | undefined)?.Authorization)).toBe(`Bearer ${validKey}`);
    expect(String(calls[0]?.init?.body)).toContain("MiniMax-M3");
    expect(String(calls[0]?.init?.body)).toContain("reasoning_split");
    expect(String(calls[0]?.init?.body)).not.toContain("api.minimax.io");
  });

  it("accepts JWT-shaped keys and rejects malformed ones", async () => {
    const api = await service(async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }));
    expect(await api.save("short")).toBe(false);
    expect(await api.save(validKey)).toBe(true);
  });

  it("maps authentication and quota failures without exposing the service body", async () => {
    const denied = await service(async () => new Response("secret", { status: 401 }));
    await denied.save(validKey);
    const failed = await denied.invoke(request, "正文");
    expect(failed).toMatchObject({ status: "failed", code: "API_FAILED" });
    expect(JSON.stringify(failed)).not.toContain("secret");
    const throttled = await service(async () => new Response("secret", { status: 429 }));
    await throttled.save(validKey);
    await expect(throttled.invoke(request, "正文")).resolves.toMatchObject({ status: "failed", code: "API_FAILED" });
  });

  it("rejects oversized results", async () => {
    const oversized = await service(async () => new Response(JSON.stringify({ choices: [{ message: { content: "界".repeat(88_000) } }] }), { status: 200 }));
    await oversized.save(validKey);
    await expect(oversized.invoke(request, "正文")).resolves.toMatchObject({ status: "failed", code: "RESULT_TOO_LARGE" });
  });
});
