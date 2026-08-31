export type WechatHtmlSecurityIssue =
  | "禁止的 HTML 标签"
  | "禁止的属性或事件处理器"
  | "本地、临时或内嵌资源地址";

export function auditWechatHtmlMarkup(html: string): WechatHtmlSecurityIssue[] {
  const markup = (html.match(/<[^>]*>/g) ?? []).join("\n");
  const issues: WechatHtmlSecurityIssue[] = [];
  if (/<(?:script|style|iframe|object|embed|base|form)\b/i.test(markup)) issues.push("禁止的 HTML 标签");
  if (/\s(?:class|id|on[a-z]+)\s*=/i.test(markup)) issues.push("禁止的属性或事件处理器");
  if (/\b(?:file|blob|data|app|fantastic-asset):|https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])/i.test(markup)) issues.push("本地、临时或内嵌资源地址");
  return issues;
}
