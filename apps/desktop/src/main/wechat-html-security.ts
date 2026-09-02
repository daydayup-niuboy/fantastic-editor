export type WechatHtmlSecurityIssue =
  | "禁止的 HTML 标签"
  | "禁止的属性或事件处理器"
  | "本地、临时或内嵌资源地址"
  | "禁止的 CSS 声明"
  | "含透明度的背景颜色"
  | "固定块宽超过 390px"
  | "字体小于 12px";

/**
 * Audits final公众号 HTML. This remains separate from the clipboard-generated
 * fragment audit because the two outputs have different allow-lists.
 */
export function auditWechatHtmlMarkup(html: string): WechatHtmlSecurityIssue[] {
  const markup = (html.match(/<[^>]*>/g) ?? []).join("\n");
  const issues = new Set<WechatHtmlSecurityIssue>();
  if (/<(?:script|style|iframe|object|embed|base|form|svg|canvas|video)\b/i.test(markup)) issues.add("禁止的 HTML 标签");
  if (/\s(?:class|id|on[a-z]+)\s*=/i.test(markup)) issues.add("禁止的属性或事件处理器");
  if (/\b(?:file|blob|data|app|fantastic-asset):|https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])/i.test(markup)) issues.add("本地、临时或内嵌资源地址");
  for (const match of markup.matchAll(/\sstyle\s*=\s*(["'])([\s\S]*?)\1/gi)) {
    const style = match[2] ?? "";
    if (/(?:^|;)\s*(?:gap|position|float|transform|background-image)\s*:|display\s*:\s*(?:flex|grid)\b|linear-gradient\s*\(|var\s*\(|calc\s*\(|\btransparent\b/i.test(style)) issues.add("禁止的 CSS 声明");
    if (/(?:background|background-color)\s*:[^;]*(?:rgba\s*\(|hsla\s*\(|#[0-9a-f]{8}\b)/i.test(style)) issues.add("含透明度的背景颜色");
    for (const width of style.matchAll(/(?:^|;)\s*width\s*:\s*(\d+(?:\.\d+)?)px\b/gi)) {
      if (Number(width[1]) > 390) issues.add("固定块宽超过 390px");
    }
    for (const fontSize of style.matchAll(/(?:^|;)\s*font-size\s*:\s*(\d+(?:\.\d+)?)px\b/gi)) {
      if (Number(fontSize[1]) < 12) issues.add("字体小于 12px");
    }
  }
  return [...issues];
}
