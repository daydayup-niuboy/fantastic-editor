import { describe, expect, it } from "vitest";
import { resolveOfficialWechatTheme } from "@fantastic-editor/shared";
import { buildCodeMirrorWechatThemeProjectionCss } from "./wechat-theme-projection";

describe("buildWechatThemeProjectionCss", () => {
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
