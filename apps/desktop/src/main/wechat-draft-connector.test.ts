import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { WechatDraftPayload } from "./output-service.js";
import { WechatDraftConnector } from "./wechat-draft-connector.js";

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function payload(): WechatDraftPayload {
  const first = "【FE图片01｜整段替换】";
  const second = "【FE公式02｜行内替换】";
  return {
    jobId: "wechat-job-test",
    sourceHash: "source-hash",
    title: "测试文章",
    html: `<section><p>${first}</p><p>能量 ${second}</p></section>`,
    replacementItems: [
      { itemId: "wechat-item-01", sequence: 1, kind: "image", placement: "block", label: "图一", placeholderText: first, sourceOffset: 0, mimeType: "image/png", width: 1, height: 1 },
      { itemId: "wechat-item-02", sequence: 2, kind: "formula", placement: "inline", label: "E=mc²", placeholderText: second, sourceOffset: 20, mimeType: "image/png", width: 2, height: 1 },
    ],
    replacements: new Map([
      ["wechat-item-01", { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" }],
      ["wechat-item-02", { bytes: new Uint8Array([4, 5, 6]), mimeType: "image/png" }],
    ]),
  };
}

describe("WechatDraftConnector", () => {
  it("连接检测识别微信 40164 并返回当前公网 IP", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => response({ errcode: 40164, errmsg: "invalid ip 203.0.113.42 ipv6 ::ffff:203.0.113.42, not in whitelist" }));
    const result = await new WechatDraftConnector(fetchMock).testConnection({ appId: "wx-test-id", appSecret: "secret-123456", coverPath: "" });
    expect(result).toEqual({
      status: "whitelist-required",
      ip: "203.0.113.42",
      message: "微信拒绝了当前公网 IP 203.0.113.42。请将它加入该公众号的 IP 白名单。",
    });
  });

  it("连接检测在白名单已放行时返回就绪", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => String(input).includes("api.ipify.org")
      ? response({ ip: "203.0.113.42" })
      : response({ access_token: "token-1" }));
    const result = await new WechatDraftConnector(fetchMock).testConnection({ appId: "wx-test-id", appSecret: "secret-123456", coverPath: "" });
    expect(result).toEqual({ status: "ready", ip: "203.0.113.42", message: "公众号接口连接正常；当前公网 IP 203.0.113.42 已在微信白名单中。" });
  });

  it("批量上传正文图片、替换标记、创建并回读草稿", async () => {
    const coverDir = await mkdtemp(join(tmpdir(), "fantastic-editor-cover-"));
    const coverPath = join(coverDir, "cover.jpg");
    await writeFile(coverPath, new Uint8Array([7, 8, 9]));
    const calls: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/token?")) return response({ access_token: "token-1" });
      if (url.includes("/media/uploadimg?")) return response({ url: "https://mmbiz.qpic.cn/example/image.png" });
      if (url.includes("/material/add_material?")) return response({ media_id: "cover-media-id" });
      if (url.includes("/draft/add?")) return response({ media_id: "draft-media-id" });
      if (url.includes("/draft/get?")) return response({ news_item: [{ title: "测试文章" }] });
      throw new Error(`unexpected URL ${url}`);
    });

    const result = await new WechatDraftConnector(fetchMock).create({
      payload: payload(),
      config: { appId: "wx-test-id", appSecret: "secret-123456", coverPath },
    });

    expect(result).toEqual({ status: "created", draftMediaId: "draft-media-id", uploadedImageCount: 2, verified: true });
    expect(calls.filter((url) => url.includes("/media/uploadimg?")).length).toBe(2);
    expect(calls.some((url) => url.includes("/material/add_material?"))).toBe(true);
  });

  it("缺少凭据或封面时不发起网络请求", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const result = await new WechatDraftConnector(fetchMock).create({ payload: payload(), config: { appId: "", appSecret: "", coverPath: "" } });
    expect(result.status).toBe("failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("微信返回非安全地址时阻止创建草稿", async () => {
    const coverDir = await mkdtemp(join(tmpdir(), "fantastic-editor-cover-"));
    const coverPath = join(coverDir, "cover.jpg");
    await writeFile(coverPath, new Uint8Array([7, 8, 9]));
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/token?")) return response({ access_token: "token-1" });
      if (url.includes("/media/uploadimg?")) return response({ url: "file:///private.png" });
      throw new Error("unexpected URL");
    });
    const result = await new WechatDraftConnector(fetchMock).create({ payload: payload(), config: { appId: "wx-test-id", appSecret: "secret-123456", coverPath } });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.error).toContain("有效的微信图片地址");
  });

  it("提交草稿发布并轮询到已发布状态", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/token?")) return response({ access_token: "token-1" });
      if (url.includes("/freepublish/submit?")) return response({ publish_id: "publish-1" });
      if (url.includes("/freepublish/get?")) return response({ publish_status: 0, article_detail: { item: [{ article_url: "https://mp.weixin.qq.com/s/article-1" }] } });
      throw new Error(`unexpected URL ${url}`);
    });

    const result = await new WechatDraftConnector(fetchMock).publish("draft-media-id", {
      appId: "wx-test-id",
      appSecret: "secret-123456",
      coverPath: "cover.jpg",
    });

    expect(result).toEqual({ status: "published", draftMediaId: "draft-media-id", publishId: "publish-1", articleUrl: "https://mp.weixin.qq.com/s/article-1", verified: true });
    expect(calls.some((url) => url.includes("/freepublish/submit?"))).toBe(true);
    expect(calls.some((url) => url.includes("/freepublish/get?"))).toBe(true);
  });
});
