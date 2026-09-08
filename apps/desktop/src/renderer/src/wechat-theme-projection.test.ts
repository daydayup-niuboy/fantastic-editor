import { describe, expect, it } from "vitest";
import { resolveOfficialWechatTheme } from "@fantastic-editor/shared";
import { buildCodeMirrorWechatThemeProjectionCss, buildWechatThemeProjectionCss } from "./wechat-theme-projection";

describe("buildWechatThemeProjectionCss", () => {
  it("scopes the resolved WeChat theme to the WYSIWYG content", () => {
    const definition = resolveOfficialWechatTheme("minimal-ink");
    const css = buildWechatThemeProjectionCss(definition);

    expect(css).toContain(".wysiwyg-editor.wechat-theme-active .wysiwyg-content{");
    expect(css).toContain(".wysiwyg-editor.wechat-theme-active .wysiwyg-content h1{");
    expect(css).toContain(definition.styles.blockquote);
    expect(css).not.toContain(".markdown-preview h1{");
  });

  it("projects the same theme onto CodeMirror live preview classes", () => {
    const definition = resolveOfficialWechatTheme("minimal-ink");
    const css = buildCodeMirrorWechatThemeProjectionCss(definition);

    expect(css).toContain(".editor-host.wechat-theme-active .cm-editor.cm-live-preview .cm-content{");
    expect(css).toContain(".cm-live-heading-1{");
    expect(css).toContain("font-size:1.68em;");
    expect(css).toContain("line-height:1.9;");
    expect(css).not.toContain("margin:");
    expect(css).not.toContain("padding:");
    expect(css).not.toContain("max-width:");
  });
});
