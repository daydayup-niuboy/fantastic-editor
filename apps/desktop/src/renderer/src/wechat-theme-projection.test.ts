import { describe, expect, it } from "vitest";
import { resolveOfficialWechatTheme } from "@fantastic-editor/shared";
import { buildWechatThemeProjectionCss } from "./wechat-theme-projection";

describe("buildWechatThemeProjectionCss", () => {
  it("scopes the resolved WeChat theme to the WYSIWYG content", () => {
    const definition = resolveOfficialWechatTheme("minimal-ink");
    const css = buildWechatThemeProjectionCss(definition);

    expect(css).toContain(".wysiwyg-editor.wechat-theme-active .wysiwyg-content{");
    expect(css).toContain(".wysiwyg-editor.wechat-theme-active .wysiwyg-content h1{");
    expect(css).toContain(definition.styles.blockquote);
    expect(css).not.toContain(".markdown-preview h1{");
  });
});
