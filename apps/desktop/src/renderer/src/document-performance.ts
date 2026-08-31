export type DocumentPerformanceLevel = "normal" | "notice" | "slow";

export interface DocumentPerformanceSnapshot {
  characterCount: number;
  resourceCount: number;
  parseDurationMs: number;
  resolveDurationMs: number;
  totalDurationMs: number;
  level: DocumentPerformanceLevel;
}

function safeMilliseconds(value: number): number {
  return Math.max(0, Math.round(Number.isFinite(value) ? value : 0));
}

export function createDocumentPerformanceSnapshot(input: {
  characterCount: number;
  resourceCount: number;
  parseDurationMs: number;
  resolveDurationMs: number;
}): DocumentPerformanceSnapshot {
  const parseDurationMs = safeMilliseconds(input.parseDurationMs);
  const resolveDurationMs = safeMilliseconds(input.resolveDurationMs);
  const characterCount = Math.max(0, Math.trunc(input.characterCount));
  const resourceCount = Math.max(0, Math.trunc(input.resourceCount));
  const totalDurationMs = parseDurationMs + resolveDurationMs;
  const level: DocumentPerformanceLevel = totalDurationMs >= 1_500
    || parseDurationMs >= 1_000
    || resolveDurationMs >= 1_000
    ? "slow"
    : totalDurationMs >= 500 || characterCount >= 250_000 || resourceCount >= 1_000
      ? "notice"
      : "normal";
  return { characterCount, resourceCount, parseDurationMs, resolveDurationMs, totalDurationMs, level };
}

export function documentPerformanceLabel(snapshot: DocumentPerformanceSnapshot): string {
  return `解析 ${snapshot.parseDurationMs.toLocaleString()} ms · 资源 ${snapshot.resolveDurationMs.toLocaleString()} ms`;
}

export function documentPerformanceDescription(snapshot: DocumentPerformanceSnapshot): string {
  const level = snapshot.level === "slow" ? "较慢" : snapshot.level === "notice" ? "需关注" : "正常";
  return `交互性能${level}；${snapshot.characterCount.toLocaleString()} 字符，${snapshot.resourceCount.toLocaleString()} 个资源，解析 ${snapshot.parseDurationMs.toLocaleString()} 毫秒，资源解析 ${snapshot.resolveDurationMs.toLocaleString()} 毫秒`;
}
