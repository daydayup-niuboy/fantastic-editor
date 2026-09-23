import { describe, expect, it } from "vitest";
import { aiDisclosureStorageKey } from "./App";

describe("AI disclosure", () => {
  it("keeps consent separate for every provider", () => {
    expect(new Set(["codex-cli", "claude-cli", "deepseek-api", "gemini-api", "kimi-api", "minimax-api", "openai-compatible"].map((id) => aiDisclosureStorageKey(id as "codex-cli" | "claude-cli" | "deepseek-api" | "gemini-api" | "kimi-api" | "minimax-api" | "openai-compatible"))).size).toBe(7);
  });
});
