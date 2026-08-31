import { describe, expect, it } from "vitest";
import { auditWechatHtmlMarkup } from "./wechat-html-security.js";

describe("auditWechatHtmlMarkup", () => {
  it("ignores protocol-like words that are article text rather than markup", () => {
    const html = '<section style="color:#222"><p>说明 <code>file:</code>、blob:、data:、app:、fantastic-asset: 与 http://localhost/。</p></section>';

    expect(auditWechatHtmlMarkup(html)).toEqual([]);
  });

  it.each([
    ['<section style="background:url(data:image/png;base64,AA)">正文</section>', "本地、临时或内嵌资源地址"],
    ['<a href="http://localhost/a">正文</a>', "本地、临时或内嵌资源地址"],
    ['<p onclick="run()">正文</p>', "禁止的属性或事件处理器"],
    ['<script>run()</script>', "禁止的 HTML 标签"],
  ])("blocks unsafe generated markup: %s", (html, expected) => {
    expect(auditWechatHtmlMarkup(html)).toContain(expected);
  });
});
