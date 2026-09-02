import { applyWechatThemeToFragment, type WechatThemeDefinition } from "./wechat-themes.js";

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function normalizeStyle(style: string): string {
  return style.replace(/#[0-9a-fA-F]{6}\b/g, (value) => value.toLowerCase() === "#ffffff" ? "#fefefe" : value.toLowerCase());
}

/** Deterministic normalization is limited to CSS values in style attributes. */
export function normalizeWechatHtmlMarkup(html: string): string {
  return html.replace(/(\sstyle\s*=\s*)(["'])([\s\S]*?)\2/gi, (_match, prefix: string, quote: string, style: string) => `${prefix}${quote}${normalizeStyle(style)}${quote}`);
}

export interface CompileWechatPublishHtmlInput {
  fragment: string;
  definition: WechatThemeDefinition;
  wrapperFontFromContext: string;
}

export function compileWechatPublishHtml(input: CompileWechatPublishHtmlInput): string {
  const themedFragment = applyWechatThemeToFragment(input.fragment, input.definition);
  const font = escapeAttribute(input.wrapperFontFromContext);
  return normalizeWechatHtmlMarkup(`<section style="${input.definition.wrapperStyle}font-family:&quot;${font}&quot;,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">${themedFragment}</section>`);
}
