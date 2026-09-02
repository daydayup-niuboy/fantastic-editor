import type { WechatThemeDefinition, WechatThemeStyleTag } from "@fantastic-editor/shared";

const THEME_TAGS: readonly WechatThemeStyleTag[] = [
  "h1", "h2", "h3", "p", "blockquote", "ul", "ol", "pre", "code", "table", "th", "td", "hr", "a",
];

export function buildWechatThemeProjectionCss(definition: WechatThemeDefinition): string {
  const scope = ".wysiwyg-editor.wechat-theme-active .wysiwyg-content";
  return [
    `${scope}{${definition.wrapperStyle}}`,
    ...THEME_TAGS.map((tag) => `${scope} ${tag}{${definition.styles[tag]}}`),
  ].join("\n");
}
