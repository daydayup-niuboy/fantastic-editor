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

export function buildCodeMirrorWechatThemeProjectionCss(definition: WechatThemeDefinition): string {
  const scope = ".editor-host.wechat-theme-active .cm-editor.cm-live-preview";
  return [
    `${scope} .cm-content{${definition.wrapperStyle}}`,
    `${scope} .cm-live-heading-1{${definition.styles.h1}}`,
    `${scope} .cm-live-heading-2{${definition.styles.h2}}`,
    `${scope} .cm-live-heading-3{${definition.styles.h3}}`,
    `${scope} .cm-live-paragraph-line{${definition.styles.p}}`,
    `${scope} .cm-live-quote-line{${definition.styles.blockquote}}`,
    `${scope} .cm-live-link{${definition.styles.a}}`,
  ].join("\n");
}
