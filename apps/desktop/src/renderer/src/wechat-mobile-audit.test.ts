import { describe, expect, it } from "vitest";
import { actionableOverflowCandidates, calculateContrastRatio, evaluateHeadingSpacing, mobileAuditSummary, type WechatMobileAuditIssue, type WechatOverflowCandidate } from "./wechat-mobile-audit.js";

describe("mobileAuditSummary", () => {
  it("distinguishes safe, locally scrollable and blocking overflow results", () => {
    expect(mobileAuditSummary([])).toBe("passed");
    expect(mobileAuditSummary([{ severity: "notice", kind: "horizontal-overflow", label: "pre" }])).toBe("review");
    const issues: WechatMobileAuditIssue[] = [{ severity: "warning", kind: "horizontal-overflow", label: "table", overflowPixels: 42 }];
    expect(mobileAuditSummary(issues)).toBe("warning");
  });

  it("calculates WCAG contrast ratios from computed rgb colors", () => {
    expect(calculateContrastRatio("rgb(0, 0, 0)", "rgb(255, 255, 255)")).toBe(21);
    expect(calculateContrastRatio("rgb(119, 119, 119)", "rgb(255, 255, 255)")).toBeCloseTo(4.48, 2);
    expect(calculateContrastRatio("invalid", "rgb(255, 255, 255)")).toBeNull();
  });

  it("uses font-relative heading spacing thresholds", () => {
    expect(evaluateHeadingSpacing(18, 10, 24).passed).toBe(true);
    expect(evaluateHeadingSpacing(8, 10, 24).passed).toBe(false);
    expect(evaluateHeadingSpacing(null, 6, 16).passed).toBe(false);
  });

  it("reports the actionable overflow source without repeating ancestor warnings", () => {
    const leaf = { contains: () => false } as unknown as HTMLElement;
    const paragraph = { contains: (element: HTMLElement) => element === leaf } as unknown as HTMLElement;
    const section = { contains: (element: HTMLElement) => element === paragraph || element === leaf } as unknown as HTMLElement;
    const candidates: WechatOverflowCandidate[] = [
      { element: section, overflowPixels: 230, locallyScrollable: false },
      { element: paragraph, overflowPixels: 220, locallyScrollable: false },
      { element: leaf, overflowPixels: 210, locallyScrollable: false },
    ];
    expect(actionableOverflowCandidates(candidates)).toEqual([candidates[2]]);

    candidates[1]!.locallyScrollable = true;
    expect(actionableOverflowCandidates(candidates)).toEqual([candidates[1]]);
  });
});
