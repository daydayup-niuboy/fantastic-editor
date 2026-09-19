export const MIN_SPLIT_RATIO = 28;
export const MAX_SPLIT_RATIO = 72;
export const DEFAULT_SIDEBAR_WIDTH = 222;
export const MIN_SIDEBAR_WIDTH = 180;
export const MAX_SIDEBAR_WIDTH = 520;
export const DEFAULT_WECHAT_INSPECTOR_WIDTH = 360;
export const MIN_WECHAT_INSPECTOR_WIDTH = 320;
export const MAX_WECHAT_INSPECTOR_WIDTH = 720;

export function clampSplitRatio(value: number): number {
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, value));
}

export function splitRatioForKey(current: number, key: string, shiftKey = false): number | null {
  if (key === "Home") return MIN_SPLIT_RATIO;
  if (key === "End") return MAX_SPLIT_RATIO;
  const step = shiftKey ? 8 : 2;
  if (key === "ArrowLeft") return clampSplitRatio(current - step);
  if (key === "ArrowRight") return clampSplitRatio(current + step);
  return null;
}

export function clampSidebarWidth(value: number): number {
  return Number.isFinite(value)
    ? Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(value)))
    : DEFAULT_SIDEBAR_WIDTH;
}

export function sidebarWidthForKey(current: number, key: string, shiftKey = false): number | null {
  if (key === "Home") return MIN_SIDEBAR_WIDTH;
  if (key === "End") return MAX_SIDEBAR_WIDTH;
  const step = shiftKey ? 40 : 10;
  if (key === "ArrowLeft") return clampSidebarWidth(current - step);
  if (key === "ArrowRight") return clampSidebarWidth(current + step);
  return null;
}

export function clampWechatInspectorWidth(value: number): number {
  return Number.isFinite(value)
    ? Math.min(MAX_WECHAT_INSPECTOR_WIDTH, Math.max(MIN_WECHAT_INSPECTOR_WIDTH, Math.round(value)))
    : DEFAULT_WECHAT_INSPECTOR_WIDTH;
}

export function wechatInspectorWidthForKey(current: number, key: string, shiftKey = false): number | null {
  if (key === "Home") return MIN_WECHAT_INSPECTOR_WIDTH;
  if (key === "End") return MAX_WECHAT_INSPECTOR_WIDTH;
  const step = shiftKey ? 40 : 10;
  if (key === "ArrowLeft") return clampWechatInspectorWidth(current + step);
  if (key === "ArrowRight") return clampWechatInspectorWidth(current - step);
  return null;
}
