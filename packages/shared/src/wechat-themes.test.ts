import { describe, expect, it } from "vitest";
import { WECHAT_THEME_OPTIONS, applyOfficialWechatThemeToFragment, resolveWechatTheme } from "./wechat-themes.js";

describe("wechat theme compiler", () => {
  it("preserves the official theme recipes byte-for-byte after tokenization", () => {
    expect(resolveWechatTheme("wechat-native-enhanced")).toMatchObject({
      wrapperStyle: "box-sizing:border-box;max-width:677px;margin:0 auto;padding:8px 4px;word-break:break-word;overflow-wrap:anywhere;",
      styles: {
        h2: "margin:1.5em 0 .7em;padding-left:.55em;border-left:4px solid #2f8f63;color:#1e563d;font-size:1.4em;line-height:1.4;font-weight:700;",
        blockquote: "margin:1em 0;padding:.8em 1em;border-left:4px solid #79ad91;background:#f3f8f5;color:#526158;overflow-wrap:anywhere;",
        code: "padding:.1em .3em;border-radius:3px;background:#eef2ef;color:#b54a3a;font-family:Consolas,monospace;overflow-wrap:anywhere;",
        th: "padding:7px 9px;border:1px solid #b9c9c0;background:#eaf3ee;color:#214b37;font-weight:700;overflow-wrap:anywhere;word-break:break-word;",
      },
    });
    expect(resolveWechatTheme("minimal-ink")).toMatchObject({
      wrapperStyle: "box-sizing:border-box;max-width:677px;margin:0 auto;padding:10px 6px;word-break:break-word;overflow-wrap:anywhere;",
      styles: {
        h1: "margin:1.75em 0 .9em;padding-bottom:.42em;border-bottom:1px solid #202124;color:#111;font-size:1.68em;line-height:1.35;font-weight:700;letter-spacing:.02em;",
        blockquote: "margin:1.1em 0;padding:.85em 1em;border-left:3px solid #3c4043;background:#f7f7f6;color:#555;overflow-wrap:anywhere;",
        code: "padding:.1em .3em;border-radius:2px;background:#f1f1ef;color:#9b3d34;font-family:Consolas,monospace;overflow-wrap:anywhere;",
        td: "padding:8px 9px;border:1px solid #d1d2cf;color:#292929;overflow-wrap:anywhere;word-break:break-word;",
      },
    });
    expect(resolveWechatTheme("deep-blue-tech")).toMatchObject({
      wrapperStyle: "box-sizing:border-box;max-width:677px;margin:0 auto;padding:8px 5px;word-break:break-word;overflow-wrap:anywhere;",
      styles: {
        h2: "margin:1.5em 0 .72em;padding:.3em .65em;border-left:4px solid #3478c7;background:#f1f6fc;color:#214c85;font-size:1.4em;line-height:1.4;font-weight:700;",
        blockquote: "margin:1em 0;padding:.85em 1em;border-left:4px solid #70a7df;background:#f2f7fc;color:#516477;overflow-wrap:anywhere;",
        code: "padding:.1em .3em;border-radius:3px;background:#edf3fa;color:#b04455;font-family:Consolas,monospace;overflow-wrap:anywhere;",
        th: "padding:7px 9px;border:1px solid #adc5dd;background:#eaf2fa;color:#214c78;font-weight:700;overflow-wrap:anywhere;word-break:break-word;",
      },
    });
  });

  it("uses one controlled definition set for preview and final output", () => {
    expect(WECHAT_THEME_OPTIONS).toHaveLength(3);
    for (const theme of WECHAT_THEME_OPTIONS) {
      const html = applyOfficialWechatThemeToFragment('<h2 data-source-from="1">标题</h2><table><tr><td>长内容</td></tr></table>', theme.id);
      expect(html).toContain(`color:${theme.id === "minimal-ink" ? "#171717" : theme.id === "deep-blue-tech" ? "#214c85" : "#1e563d"}`);
      expect(html).toContain("table-layout:fixed");
      expect(html).toContain('data-source-from="1"');
    }
  });

  it("preserves existing attributes while prepending controlled styles", () => {
    const html = applyOfficialWechatThemeToFragment('<p style="text-align:center" data-x="1">正文</p>', "wechat-native-enhanced");
    expect(html).toContain('style="margin:.85em 0;');
    expect(html).toContain("text-align:center");
    expect(resolveWechatTheme("wechat-green").id).toBe("wechat-native-enhanced");
    expect(() => resolveWechatTheme("unknown")).toThrowError(/未知公众号主题/);
  });
});
