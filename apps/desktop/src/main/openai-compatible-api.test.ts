import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { AiInvocationRequest, OpenAiCompatibleConfigSaveRequest } from "@fantastic-editor/shared";
import { OpenAiCompatibleApi, normalizeBaseUrl, parseModelList } from "./openai-compatible-api";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const request: AiInvocationRequest = {
  requestId: "123e4567-e89b-42d3-a456-426614174000",
  providerId: "openai-compatible",
  modelSlot: 0,
  scope: "selection",
  actionId: "polish",
  anchor: { documentId: "doc", sourceHash: "a".repeat(64), from: 0, to: 2, expectedText: "正文" },
  content: "正文",
};
async function api(fetcher: typeof fetch) {
  const root = await mkdtemp(join(tmpdir(), "openai-compatible-test-"));
  roots.push(root);
  return new OpenAiCompatibleApi(join(root, "config.json"), { isAvailable: () => true, encrypt: (value) => `encrypted:${value}`, decrypt: (value) => value.slice(10) }, fetcher);
}
const saveRequest: OpenAiCompatibleConfigSaveRequest = {
  baseUrl: "https://subscription.example/v1/",
  apiKey: "sk-1234567890abcdefghijklmnop",
  providerName: "我的订阅",
  localName: "软件内名称",
  modelSlots: [{ modelId: "official-model-a", localName: "别名 A" }, null],
  modelOptions: ["official-model-a", "official-model-b"],
}

describe("OpenAI-compatible API boundary", () => {
  it("normalizes only usable HTTP(S) base URLs and parses standard model lists", () => {
    expect(normalizeBaseUrl(" https://host/v1/ ")).toBe("https://host/v1");
    expect(normalizeBaseUrl("https://host")).toBe("https://host");
    expect(normalizeBaseUrl("file:///tmp")).toBeNull();
    expect(normalizeBaseUrl("https://user:pass@host/v1")).toBeNull();
    expect(parseModelList({ object: "list", data: [{ id: "model-a" }, { id: "model-a" }, { id: 42 }] })).toEqual(["model-a"]);
    expect(parseModelList([{ id: "array-model" }])).toEqual(["array-model"]);
  });

  it("encrypts the key, keeps official model ids, and never sends the local alias", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const service = await api(async (url, init) => {
      calls.push({ url: String(url), init });
      return String(url).endsWith("/models")
        ? new Response(JSON.stringify({ data: [{ id: "official-model-a" }] }), { status: 200 })
        : new Response(JSON.stringify({ choices: [{ message: { content: "处理结果" } }] }), { status: 200 });
    });
    expect(await service.save(saveRequest)).toBe(true);
    expect(await service.listModels(saveRequest.baseUrl)).toEqual(["official-model-a"]);
    await expect(service.invoke(request, "正文")).resolves.toEqual({ status: "completed", result: "处理结果" });
    const completion = calls.find((call) => call.url.endsWith("/chat/completions"));
    expect(completion?.url).toBe("https://subscription.example/v1/chat/completions");
    expect(String(completion?.init?.body)).toContain('"model":"official-model-a"');
    expect(String(completion?.init?.body)).not.toContain("别名 A");
    expect(JSON.stringify(await service.summary())).not.toContain("sk-1234567890abcdefghijklmnop");
  });

  it("rejects malformed endpoints and unauthorized model fetches without exposing secrets", async () => {
    const denied = await api(async () => new Response("secret-response", { status: 401 }));
    expect(await denied.save({ ...saveRequest, baseUrl: "ftp://host/v1" })).toBe(false);
    expect(await denied.save(saveRequest)).toBe(true);
    await expect(denied.listModels(saveRequest.baseUrl)).rejects.toThrow("API Key");
    expect(JSON.stringify(await denied.listModels(saveRequest.baseUrl).catch((error: unknown) => error))).not.toContain("secret-response");
  });

  it("reports connectivity from GET /models without leaking error bodies", async () => {
    const connected = await api(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    await connected.save(saveRequest);
    await expect(connected.test(saveRequest.baseUrl)).resolves.toBe(true);
    const failed = await api(async () => new Response("secret-response", { status: 401 }));
    await failed.save(saveRequest);
    await expect(failed.test(saveRequest.baseUrl)).resolves.toBe(false);
  });

  it("does not follow provider redirects for connectivity, model listing, or completion", async () => {
    let redirectedRequests = 0;
    const server = createServer((incoming, outgoing) => {
      if (incoming.url === "/unexpected") {
        redirectedRequests += 1;
        outgoing.writeHead(200, { "Content-Type": "application/json" }).end("{}");
        return;
      }
      outgoing.writeHead(307, { Location: "/unexpected" }).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing local test port");
      const baseUrl = `http://127.0.0.1:${address.port}/v1`;
      const service = await api(fetch);
      expect(await service.save({ ...saveRequest, baseUrl })).toBe(true);
      await expect(service.test(baseUrl)).resolves.toBe(false);
      await expect(service.listModels(baseUrl)).rejects.toThrow();
      await expect(service.invoke(request, "正文")).resolves.toMatchObject({ status: "failed", code: "API_FAILED" });
      expect(redirectedRequests).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
