import { describe, expect, it, vi } from "vitest";
import type { AiInvocationRequest } from "@fantastic-editor/shared";
import { EventEmitter } from "node:events";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { AiCliService, buildAiPrompt, validateAiCancelRequest, validateAiRequest } from "./ai-cli-service";

const request: AiInvocationRequest = {
  requestId: "123e4567-e89b-42d3-a456-426614174000",
  providerId: "codex-cli",
  scope: "selection",
  actionId: "polish",
  anchor: { documentId: "doc", sourceHash: "a".repeat(64), from: 0, to: 2, expectedText: "正文" },
  content: "正文",
};

describe("AI CLI boundary", () => {
  it("accepts a matching bounded anchor and keeps content out of command arguments", () => {
    expect(validateAiRequest(request)).toBe(true);
    expect(buildAiPrompt(request)).toContain("<content>\n正文\n</content>");
  });

  it("rejects stale or oversized request content", () => {
    expect(validateAiRequest({ ...request, content: "已变化" })).toBe(false);
    expect(validateAiRequest({ ...request, content: "x".repeat(64 * 1024 + 1), anchor: { ...request.anchor, expectedText: "x".repeat(64 * 1024 + 1) } })).toBe(false);
    expect(validateAiRequest({ ...request, content: "界".repeat(22_000), anchor: { ...request.anchor, to: 22_000, expectedText: "界".repeat(22_000) } })).toBe(false);
  });

  it("rejects renderer-controlled process fields and malformed identifiers", () => {
    expect(validateAiRequest({ ...request, executable: "evil.exe" })).toBe(false);
    expect(validateAiRequest({ ...request, args: ["--danger"] })).toBe(false);
    expect(validateAiRequest({ ...request, env: { SECRET: "x" } })).toBe(false);
    expect(validateAiRequest({ ...request, requestId: "------------------------------------" })).toBe(false);
    expect(validateAiRequest({ ...request, providerId: "other" })).toBe(false);
    expect(validateAiRequest({ ...request, anchor: { ...request.anchor, documentId: "x".repeat(201) } })).toBe(false);
    expect(validateAiCancelRequest({ requestId: request.requestId })).toBe(true);
    expect(validateAiCancelRequest({ requestId: request.requestId, pid: 1 })).toBe(false);
  });

  it("uses the de-AI preset without a custom instruction field", () => {
    const deai = { ...request, actionId: "deai" as const };
    expect(validateAiRequest(deai)).toBe(true);
    expect(buildAiPrompt(deai)).toContain("去掉 AI 腔");
    expect(validateAiRequest({ ...deai, customInstruction: "不应出现" })).toBe(false);
  });

  it("accepts only bounded custom instructions and keeps them in stdin prompt", () => {
    const custom = { ...request, actionId: "custom" as const, customInstruction: "改成口语表达" };
    expect(validateAiRequest(custom)).toBe(true);
    expect(buildAiPrompt(custom)).toContain("任务：改成口语表达。");
    expect(validateAiRequest({ ...custom, customInstruction: " " })).toBe(false);
    expect(validateAiRequest({ ...custom, customInstruction: "x".repeat(1_001) })).toBe(false);
    expect(validateAiRequest({ ...custom, customInstruction: "界".repeat(1_000) })).toBe(true);
    expect(validateAiRequest({ ...request, customInstruction: "不应出现" })).toBe(false);
  });

  const fakeService = (scenario: string, timeoutMs = 1_000) => new AiCliService({
    spawnSpec: { executable: process.execPath, argsPrefix: [resolve(process.cwd(), "scripts/fake-codex-cli.mjs"), scenario] }, timeoutMs,
  });

  it("accepts a complete JSONL lifecycle and ignores unknown events", async () => {
    const service = fakeService("normal");
    await expect(service.invoke(request, () => undefined)).resolves.toEqual({ status: "completed", result: "处理结果" });
  });

  it.each([
    ["out-of-order events", "out-of-order"],
    ["truncated JSON", "truncated"],
    ["non-zero exit", "non-zero"],
  ])("fails safely for %s without exposing stderr", async (_name, scenario) => {
    const result = await fakeService(scenario).invoke(request, () => undefined);
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("rejects output beyond the byte limit", async () => {
    await expect(fakeService("oversized").invoke(request, () => undefined)).resolves.toMatchObject({ status: "failed", code: "RESULT_TOO_LARGE" });
    await expect(fakeService("raw-oversized").invoke(request, () => undefined)).resolves.toMatchObject({ status: "failed", code: "RESULT_TOO_LARGE" });
    await expect(fakeService("oversized-buffered").invoke(request, () => undefined)).resolves.toMatchObject({ status: "failed", code: "RESULT_TOO_LARGE" });
  });

  it("detects CLI providers and keeps unconfigured API providers unavailable", async () => {
    await expect(fakeService("normal").detect()).resolves.toEqual([
      { providerId: "codex-cli", displayName: "Codex CLI", status: "available", version: "fake-cli" },
      { providerId: "claude-cli", displayName: "Claude CLI", status: "available", version: "fake-cli" },
      { providerId: "deepseek-api", displayName: "DeepSeek API", status: "unavailable", guidance: "请先配置 DeepSeek API Key。" },
      { providerId: "gemini-api", displayName: "Gemini API", status: "unavailable", guidance: "请先配置 Gemini API Key。" },
      { providerId: "kimi-api", displayName: "Kimi API", status: "unavailable", guidance: "请先配置 Kimi API Key。" },
      { providerId: "minimax-api", displayName: "MiniMax API", status: "unavailable", guidance: "请先配置 MiniMax API Key。" },
      { providerId: "openai-compatible", displayName: "OpenAI 兼容 API", status: "unavailable", guidance: "请先配置订阅地址、API Key 和至少一个模型。" },
    ]);
  });

  it("requires an explicit official-model slot only for the custom provider", () => {
    const custom = { ...request, providerId: "openai-compatible" as const, modelSlot: 1 as const };
    expect(validateAiRequest(custom)).toBe(true);
    expect(validateAiRequest({ ...custom, modelSlot: undefined })).toBe(false);
    expect(validateAiRequest({ ...custom, modelId: "local-alias" })).toBe(false);
    expect(validateAiRequest({ ...request, modelSlot: 0 })).toBe(false);
  });

  it("uses the fixed Claude safety invocation and accepts only its success envelope", async () => {
    const claudeRequest = { ...request, providerId: "claude-cli" as const };
    await expect(fakeService("claude-normal").invoke(claudeRequest, () => undefined)).resolves.toEqual({ status: "completed", result: "Claude 处理结果" });
    for (const scenario of ["claude-malformed", "claude-error"]) {
      const result = await fakeService(scenario).invoke(claudeRequest, () => undefined);
      expect(result.status).toBe("failed");
      expect(JSON.stringify(result)).not.toContain("secret-token");
    }
    await expect(fakeService("claude-oversized").invoke(claudeRequest, () => undefined)).resolves.toMatchObject({ status: "failed", code: "RESULT_TOO_LARGE" });
  });

  it("supports timeout and cancellation", async () => {
    await expect(fakeService("hang", 30).invoke(request, () => undefined)).resolves.toMatchObject({ status: "failed", code: "TIMEOUT" });
    const service = fakeService("hang");
    const pending = service.invoke(request, () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(service.cancel(request.requestId)).toBe(true);
    await expect(pending).resolves.toEqual({ status: "cancelled" });
  });

  it("keeps the active slot and temp directory until the killed child closes", async () => {
    const child = new EventEmitter() as unknown as ReturnType<typeof spawn>;
    Object.assign(child, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
    });
    let resolveCwd!: (value: string) => void;
    const childCwd = new Promise<string>((resolve) => { resolveCwd = resolve; });
    const service = new AiCliService({
      spawnSpec: { executable: "fake-cli" },
      timeoutMs: 20,
      spawnProcess: ((_, __, options) => {
        resolveCwd(String(options?.cwd));
        return child;
      }) as typeof spawn,
    });
    const pending = service.invoke(request, () => undefined);
    const directory = await childCwd;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(child.kill).toHaveBeenCalledOnce();
    await expect(access(directory)).resolves.toBeUndefined();
    await expect(service.invoke({ ...request, requestId: "123e4567-e89b-42d3-a456-426614174001" }, () => undefined))
      .resolves.toMatchObject({ status: "failed", code: "BUSY" });

    child.emit("close", null, "SIGTERM");
    await expect(pending).resolves.toMatchObject({ status: "failed", code: "TIMEOUT" });
    await expect(access(directory)).rejects.toThrow();
  });
});
