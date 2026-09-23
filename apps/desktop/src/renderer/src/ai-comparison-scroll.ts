export interface ScrollMetrics {
  sourceScrollTop: number;
  sourceScrollHeight: number;
  sourceClientHeight: number;
  targetScrollHeight: number;
  targetClientHeight: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function synchronizedScrollTop(metrics: ScrollMetrics): number {
  const sourceRange = metrics.sourceScrollHeight - metrics.sourceClientHeight;
  const targetRange = metrics.targetScrollHeight - metrics.targetClientHeight;
  if (!Number.isFinite(sourceRange) || !Number.isFinite(targetRange) || sourceRange <= 0 || targetRange <= 0) return 0;
  const ratio = clamp(metrics.sourceScrollTop / sourceRange, 0, 1);
  return Math.round(ratio * targetRange);
}

export function syncAiComparisonScroll(source: HTMLElement, target: HTMLElement | null): void {
  if (!target || target.dataset.aiScrollSyncing === "1") return;
  const nextTop = synchronizedScrollTop({
    sourceScrollTop: source.scrollTop,
    sourceScrollHeight: source.scrollHeight,
    sourceClientHeight: source.clientHeight,
    targetScrollHeight: target.scrollHeight,
    targetClientHeight: target.clientHeight,
  });
  target.dataset.aiScrollSyncing = "1";
  target.scrollTop = nextTop;
  window.requestAnimationFrame(() => { target.dataset.aiScrollSyncing = ""; });
}
