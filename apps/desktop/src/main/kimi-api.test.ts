import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { AiInvocationRequest } from "@fantastic-editor/shared";
import { KimiApi } from "./kimi-api";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const request: AiInvocationRequest = { requestId: "123e4567-e89b-42d3-a456-426614174000", providerId: "kimi-api", scope: "selection", actionId: "polish", anchor: { documentId: "doc", sourceHash: "a".repeat(64), from: 0, to: 2, expectedText: "正文" }, content: "正文" };
const validKey = "sk-kimi-fake-key-for-tests-0001";
async function service(fetcher: typeof fetch) {
  const root = await mkdtemp(join(tmpdir(), "kimi-test-")); roots.push(root);
  return new KimiApi(join(root, "config.json"), { isAvailable: () => true, encrypt: (value) => `encrypted:${value}`, decrypt: (value) => value.slice(10) }, fetcher);
}

describe("Kimi API boundary", () => {
  it("encrypts the key and sends only the prompt to the fixed official endpoint and model", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const api = await service(async (url, init) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify({ choices: [{ message: { content: "处理结果" } }] }), { status: 200 }); });
    expect(await api.save(validKey)).toBe(true);
    await expect(api.invoke(request, "安全提示\n正文")).resolves.toEqual({ status: "completed", result: "处理结果" });
    expect(calls[0]?.url).toBe("https://api.moonshot.cn/v1/chat/completions");
    expect(String((calls[0]?.init?.headers as Record<string, string> | undefined)?.Authorization)).toBe(`Bearer ${validKey}`);
    expect(String(calls[0]?.init?.body)).toContain("kimi-k3");
    expect(String(calls[0]?.init?.body)).toContain("安全提示\\n正文");
    // 端点和模型不接受外部覆盖
    expect(String(calls[0]?.init?.body)).not.toContain("api.moonshot.ai");
  });

  it("rejects invalid keys, authentication failures and oversized results without exposing secrets", async () => {
    const denied = await service(async () => new Response("secret", { status: 401 }));
    expect(await denied.save("bad-key")).toBe(false);
    expect(await denied.save("sk-kimi-fake-key-for-tests-0002")).toBe(true);
    const failed = await denied.invoke(request, "正文");
    expect(failed).toMatchObject({ status: "failed", code: "API_FAILED" });
    expect(JSON.stringify(failed)).not.toContain("secret");
    const oversized = await service(async () => new Response(JSON.stringify({ choices: [{ message: { content: "界".repeat(88_000) } }] }), { status: 200 }));
    await oversized.save(validKey);
    await expect(oversized.invoke(request, "正文")).resolves.toMatchObject({ status: "failed", code: "RESULT_TOO_LARGE" });
  });

  it("ignores reasoning_content and fails when the answer body is empty", async () => {
    const reasoningOnly = await service(async () => new Response(JSON.stringify({ choices: [{ message: { reasoning_content: "思考中", content: "" } }] }), { status: 200 }));
    await reasoningOnly.save(validKey);
    await expect(reasoningOnly.invoke(request, "正文")).resolves.toMatchObject({ status: "failed", code: "API_FAILED" });
  });

  it("joins array content parts and still ignores empty bodies", async () => {
    const api = await service(async () => new Response(JSON.stringify({ choices: [{ message: { content: [{ type: "text", text: "处理" }, { type: "text", text: "结果" }] } }] }), { status: 200 }));
    await api.save(validKey);
    await expect(api.invoke(request, "正文")).resolves.toEqual({ status: "completed", result: "处理结果" });
  });

  it("does not store a key when system encryption is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "kimi-test-")); roots.push(root);
    const api = new KimiApi(join(root, "config.json"), { isAvailable: () => false, encrypt: (value) => value, decrypt: (value) => value }, async () => new Response("{}", { status: 200 }));
    expect(await api.save(validKey)).toBe(false);
    expect(await api.configured()).toBe(false);
    await expect(api.invoke(request, "正文")).resolves.toMatchObject({ status: "failed", code: "PROVIDER_UNAVAILABLE" });
  });
});
