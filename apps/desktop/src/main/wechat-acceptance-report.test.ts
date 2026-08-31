import { describe, expect, it } from "vitest";
import { generateWechatAcceptanceReport } from "./wechat-acceptance-report";

const confirmation = { bodyPasted: true, draftSaved: true, draftReopened: true, mobilePreviewed: true };

describe("generateWechatAcceptanceReport", () => {
  it("records completed manual checks without claiming publication", () => {
    const report = generateWechatAcceptanceReport({
      jobId: "wechat-job",
      documentId: "document-1",
      sourceHash: "a".repeat(64),
      status: "completed",
      themeId: "deep-blue-tech",
      replacementItems: [{
        itemId: "wechat-item-01",
        sequence: 1,
        kind: "image",
        placement: "block",
        label: "验收图",
        placeholderText: "【FE图片01｜整段替换】",
        sourceOffset: 42,
        mimeType: "image/png",
        width: 320,
        height: 180,
      }],
      omittedReferenceKeys: [],
      confirmation,
      generatedAt: "2026-08-27T12:00:00.000Z",
      appVersion: "0.1.0",
      platform: "win32",
      architecture: "x64",
    });
    expect(report).toContain("本地人工验收清单完成");
    expect(report).toContain("正文主题：深蓝科技（deep-blue-tech）");
    expect(report).toContain("图片（块级）：验收图");
    expect(report).toContain("【FE图片01｜整段替换】");
    expect(report).toContain("不证明文章已经发布或群发");
    expect(report).not.toContain("C:\\");
  });

  it("keeps omissions visibly partial", () => {
    const report = generateWechatAcceptanceReport({
      jobId: "wechat-job-partial",
      documentId: "document-2",
      sourceHash: "b".repeat(64),
      status: "completed-with-omissions",
      themeId: "wechat-native-enhanced",
      replacementItems: [],
      omittedReferenceKeys: ["c".repeat(64)],
      confirmation,
      generatedAt: "2026-08-27T12:00:00.000Z",
      appVersion: "0.1.0",
      platform: "win32",
      architecture: "x64",
    });
    expect(report).toContain("部分完成（含已批准省略项）");
    expect(report).toContain("不得归类为完整成功");
  });
});
