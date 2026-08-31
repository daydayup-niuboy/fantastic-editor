export type WechatMobileAuditSeverity = "warning" | "notice";

export interface WechatMobileAuditIssue {
  severity: WechatMobileAuditSeverity;
  kind: "horizontal-overflow" | "tiny-text" | "low-contrast" | "heading-spacing";
  label: string;
  overflowPixels?: number;
  contrastRatio?: number;
  spacingPixels?: number;
}

function elementLabel(element: HTMLElement): string {
  const tag = element.tagName.toLowerCase();
  const text = (element.getAttribute("alt") || element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 32);
  return text ? `${tag}：${text}` : tag;
}

export function auditWechatMobileLayout(root: HTMLElement): WechatMobileAuditIssue[] {
  const issues: WechatMobileAuditIssue[] = [];
  const rootWidth = root.clientWidth;
  if (rootWidth <= 0) return issues;
  for (const element of root.querySelectorAll<HTMLElement>("section,h1,h2,h3,h4,h5,h6,p,blockquote,ul,ol,pre,code,table,img,svg,a")) {
    const overflowPixels = Math.ceil(element.scrollWidth - Math.min(element.clientWidth || rootWidth, rootWidth));
    if (overflowPixels > 2) {
      const overflowX = getComputedStyle(element).overflowX;
      issues.push({
        severity: overflowX === "auto" || overflowX === "scroll" ? "notice" : "warning",
        kind: "horizontal-overflow",
        label: elementLabel(element),
        overflowPixels,
      });
    }
    const fontSize = Number.parseFloat(getComputedStyle(element).fontSize);
    if (Number.isFinite(fontSize) && fontSize > 0 && fontSize < 12) {
      issues.push({ severity: "notice", kind: "tiny-text", label: elementLabel(element) });
    }
    if ((element.textContent || "").trim() && !["UL", "OL", "TABLE"].includes(element.tagName)) {
      const style = getComputedStyle(element);
      let background = style.backgroundColor;
      let parent = element.parentElement;
      while (isTransparent(background) && parent && root.contains(parent)) {
        background = getComputedStyle(parent).backgroundColor;
        parent = parent.parentElement;
      }
      if (isTransparent(background)) background = "rgb(255, 255, 255)";
      const contrastRatio = calculateContrastRatio(style.color, background);
      const largeText = fontSize >= 24 || (fontSize >= 18.66 && Number.parseFloat(style.fontWeight) >= 700);
      if (contrastRatio !== null && contrastRatio < (largeText ? 3 : 4.5)) {
        issues.push({ severity: "warning", kind: "low-contrast", label: elementLabel(element), contrastRatio });
      }
    }
  }
  const blocks = [...root.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6,p,blockquote,ul,ol,pre,table,.mermaid-diagram,img")]
    .filter((element) => element.getBoundingClientRect().height > 0);
  for (const heading of blocks.filter((element) => /^H[1-6]$/.test(element.tagName))) {
    const index = blocks.indexOf(heading);
    const previous = index > 0 ? blocks[index - 1] : null;
    const next = index < blocks.length - 1 ? blocks[index + 1] : null;
    const headingRect = heading.getBoundingClientRect();
    const fontSize = Number.parseFloat(getComputedStyle(heading).fontSize) || 16;
    const before = previous ? headingRect.top - previous.getBoundingClientRect().bottom : null;
    const after = next ? next.getBoundingClientRect().top - headingRect.bottom : null;
    const spacing = evaluateHeadingSpacing(before, after, fontSize);
    if (!spacing.passed) {
      issues.push({
        severity: "warning",
        kind: "heading-spacing",
        label: elementLabel(heading),
        spacingPixels: Math.round(Math.min(...[before, after].filter((value): value is number => value !== null))),
      });
    }
  }
  return issues.slice(0, 20);
}

export function evaluateHeadingSpacing(before: number | null, after: number | null, fontSize: number): { passed: boolean; minimumBefore: number; minimumAfter: number } {
  const minimumBefore = Math.max(12, fontSize * .55);
  const minimumAfter = Math.max(8, fontSize * .28);
  return {
    passed: (before === null || before >= minimumBefore) && (after === null || after >= minimumAfter),
    minimumBefore,
    minimumAfter,
  };
}

function isTransparent(color: string): boolean {
  return color === "transparent" || /rgba\([^)]*,\s*0(?:\.0+)?\s*\)/i.test(color);
}

function rgb(color: string): [number, number, number] | null {
  const match = color.match(/rgba?\(\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)/i);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function luminance([red, green, blue]: [number, number, number]): number {
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= .03928 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4;
  };
  return .2126 * channel(red) + .7152 * channel(green) + .0722 * channel(blue);
}

export function calculateContrastRatio(foreground: string, background: string): number | null {
  const foregroundRgb = rgb(foreground);
  const backgroundRgb = rgb(background);
  if (!foregroundRgb || !backgroundRgb) return null;
  const lighter = Math.max(luminance(foregroundRgb), luminance(backgroundRgb));
  const darker = Math.min(luminance(foregroundRgb), luminance(backgroundRgb));
  return Math.round(((lighter + .05) / (darker + .05)) * 100) / 100;
}

export function mobileAuditSummary(issues: readonly WechatMobileAuditIssue[]): "passed" | "review" | "warning" {
  if (issues.some((issue) => issue.severity === "warning")) return "warning";
  return issues.length > 0 ? "review" : "passed";
}
