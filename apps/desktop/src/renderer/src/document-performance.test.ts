import { describe, expect, it } from "vitest";
import { createDocumentPerformanceSnapshot, documentPerformanceDescription, documentPerformanceLabel } from "./document-performance";

describe("document performance projection", () => {
  it("classifies normal, large and slow document work without mutating source state", () => {
    expect(createDocumentPerformanceSnapshot({ characterCount: 2_000, resourceCount: 2, parseDurationMs: 20.4, resolveDurationMs: 8.4 })).toMatchObject({ level: "normal", totalDurationMs: 28 });
    expect(createDocumentPerformanceSnapshot({ characterCount: 250_000, resourceCount: 0, parseDurationMs: 80, resolveDurationMs: 0 }).level).toBe("notice");
    expect(createDocumentPerformanceSnapshot({ characterCount: 1_000, resourceCount: 1, parseDurationMs: 1_001, resolveDurationMs: 2 }).level).toBe("slow");
  });

  it("produces concise visual and accessible descriptions", () => {
    const snapshot = createDocumentPerformanceSnapshot({ characterCount: 320_000, resourceCount: 1_200, parseDurationMs: 420, resolveDurationMs: 210 });
    expect(documentPerformanceLabel(snapshot)).toContain("解析 420 ms");
    expect(documentPerformanceDescription(snapshot)).toContain("320,000 字符");
    expect(documentPerformanceDescription(snapshot)).toContain("1,200 个资源");
  });

  it("sanitizes invalid measurements", () => {
    expect(createDocumentPerformanceSnapshot({ characterCount: -1, resourceCount: -2, parseDurationMs: Number.NaN, resolveDurationMs: -5 })).toEqual({
      characterCount: 0,
      resourceCount: 0,
      parseDurationMs: 0,
      resolveDurationMs: 0,
      totalDurationMs: 0,
      level: "normal",
    });
  });
});
