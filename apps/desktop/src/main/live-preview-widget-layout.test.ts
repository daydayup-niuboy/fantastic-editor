import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// 块级 widget(Decoration.replace({block:true}))直接挂在 DocTile 下,CodeMirror 量高只取
// getBoundingClientRect().height(不含 margin)。纵向留白必须写在 padding,否则高度图漏算,
// widget 之下的行会出现鼠标命中与光标绘制整体偏移。
const BLOCK_WIDGET_ROOTS = [".cm-live-table", ".cm-live-mermaid", ".cm-live-structured-code", ".cm-live-formula-block"];

const css = readFileSync(new URL("../renderer/src/styles.css", import.meta.url), "utf8");

function auditVerticalMargins(selector: string): { rules: number; vertical: string[] } {
  const vertical: string[] = [];
  let rules = 0;
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1]!.split(",").map((item) => item.trim());
    if (!selectors.includes(selector)) continue;
    rules += 1;
    for (const declaration of match[2]!.split(";")) {
      const margin = /^\s*margin(-(?:top|bottom))?\s*:\s*(.+)$/.exec(declaration);
      if (!margin) continue;
      const values = margin[2]!.trim().split(/\s+/);
      const verticalValues = margin[1] ? [values[0]!] : values.length <= 2 ? [values[0]!] : [values[0]!, values[2]!];
      vertical.push(...verticalValues);
    }
  }
  return { rules, vertical };
}

describe("block widget layout stays measurable", () => {
  for (const selector of BLOCK_WIDGET_ROOTS) {
    it(`${selector} keeps vertical spacing in padding only`, () => {
      const { rules, vertical } = auditVerticalMargins(selector);
      expect(rules).toBeGreaterThan(0);
      expect(vertical.every((value) => /^(?:0|auto)/.test(value))).toBe(true);
    });
  }
});
