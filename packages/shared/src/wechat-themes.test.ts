import { describe, expect, it } from "vitest";
import { WECHAT_THEME_OPTIONS, applyWechatThemeToFragment, resolveWechatTheme } from "./wechat-themes.js";

describe("wechat theme compiler", () => {
  it("uses one controlled definition set for preview and final output", () => {
    expect(WECHAT_THEME_OPTIONS).toHaveLength(3);
    for (const theme of WECHAT_THEME_OPTIONS) {
      const html = applyWechatThemeToFragment('<h2 data-source-from="1">标题</h2><table><tr><td>长内容</td></tr></table>', theme.id);
      expect(html).toContain(`color:${theme.id === "minimal-ink" ? "#171717" : theme.id === "deep-blue-tech" ? "#214c85" : "#1e563d"}`);
      expect(html).toContain("table-layout:fixed");
      expect(html).toContain('data-source-from="1"');
    }
  });

  it("preserves existing attributes while prepending controlled styles", () => {
    const html = applyWechatThemeToFragment('<p style="text-align:center" data-x="1">正文</p>', "wechat-native-enhanced");
    expect(html).toContain('style="margin:.85em 0;');
    expect(html).toContain("text-align:center");
    expect(resolveWechatTheme("unknown").id).toBe("wechat-native-enhanced");
  });
});
