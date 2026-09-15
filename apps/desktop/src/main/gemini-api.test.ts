import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { AiInvocationRequest } from "@fantastic-editor/shared";
import { GeminiApi } from "./gemini-api";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const request: AiInvocationRequest = { requestId: "123e4567-e89b-42d3-a456-426614174000", providerId: "gemini-api", scope: "selection", actionId: "polish", anchor: { documentId: "doc", sourceHash: "a".repeat(64), from: 0, to: 2, expectedText: "正文" }, content: "正文" };
async function service(fetcher: typeof fetch) {
  const root = await mkdtemp(join(tmpdir(), "gemini-test-")); roots.push(root);
  return new GeminiApi(join(root, "config.json"), { isAvailable: () => true, encrypt: (value) => `encrypted:${value}`, decrypt: (value) => value.slice(10) }, fetcher);
}

describe("Gemini API boundary", () => {
  it("encrypts the key and sends only the prompt to the fixed official endpoint", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const api = await service(async (url, init) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "处理" }, { text: "结果" }] } }] }), { status: 200 }); });
    const testKey = `test_${"x".repeat(32)}`;
    expect(await api.save(testKey)).toBe(true);
    await expect(api.invoke(request, "安全提示\n正文")).resolves.toEqual({ status: "completed", result: "处理结果" });
    expect(calls[0]?.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
    expect((calls[0]?.init?.headers as Record<string, string>)["x-goog-api-key"]).toBe(testKey);
    expect(String(calls[0]?.init?.body)).toContain("安全提示\\n正文");
  });

  it("rejects invalid keys, authentication failures and oversized results without exposing secrets", async () => {
    const denied = await service(async () => new Response("secret", { status: 403 }));
    expect(await denied.save("bad-key")).toBe(false);
    expect(await denied.save(`test_${"x".repeat(32)}`)).toBe(true);
    expect(JSON.stringify(await denied.invoke(request, "正文"))).not.toContain("secret");
    const oversized = await service(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "界".repeat(88_000) }] } }] }), { status: 200 }));
    await oversized.save(`test_${"x".repeat(32)}`);
    await expect(oversized.invoke(request, "正文")).resolves.toMatchObject({ status: "failed", code: "RESULT_TOO_LARGE" });
  });

  it("accepts the current AQ dot-separated Gemini key format", async () => {
    const calls: string[] = [];
    const api = await service(async (url) => { calls.push(String(url)); return new Response("{}", { status: 200 }); });
    expect(await api.save(`AQ.${"x".repeat(48)}`)).toBe(true);
    expect(await api.test()).toBe(true);
    expect(calls).toEqual(["https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash"]);
  });
});
