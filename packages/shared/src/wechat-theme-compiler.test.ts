import { describe, expect, it } from "vitest";
import { compileWechatPublishHtml, normalizeWechatHtmlMarkup } from "./wechat-theme-compiler.js";
import { buildWechatThemeDefinition, normalizeWechatThemeTokens } from "./wechat-themes.js";

describe("wechat publish compiler", () => {
  it("uses the resolved definition and preserves original style after theme style", () => {
    const tokens = normalizeWechatThemeTokens("minimal-ink", { accent: "#07C160", page: "#FAFAFA" });
    const definition = { ...buildWechatThemeDefinition("minimal-ink", tokens), id: "minimal-ink+0123456789ab" };
    const html = compileWechatPublishHtml({ fragment: '<p style="text-align:center;color:#ABCDEF">正文</p>', definition, wrapperFontFromContext: "Microsoft YaHei UI" });
    expect(html).toContain("background:#fafafa");
    expect(html).toContain("color:#abcdef");
    expect(html.indexOf(`font-size:${tokens.sizeBodyPx}px`)).toBeLessThan(html.indexOf("text-align:center"));
    expect(html).not.toContain("#FFFFFF");
  });

  it("normalizes colors only inside style attributes", () => {
    const html = normalizeWechatHtmlMarkup('<p style="color:#FFFFFF">正文代码 #FFFFFF</p>');
    expect(html).toBe('<p style="color:#fefefe">正文代码 #FFFFFF</p>');
  });
});
