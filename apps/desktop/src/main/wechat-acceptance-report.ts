import { WECHAT_THEME_OPTIONS, type OutputResultStatus, type WechatAcceptanceConfirmation, type WechatReplacementItem } from "@fantastic-editor/shared";

export interface WechatAcceptanceReportInput {
  jobId: string;
  documentId: string;
  sourceHash: string;
  status: Extract<OutputResultStatus, "completed" | "completed-with-omissions">;
  themeId: string;
  replacementItems: readonly WechatReplacementItem[];
  omittedReferenceKeys: readonly string[];
  confirmation: WechatAcceptanceConfirmation;
  generatedAt: string;
  appVersion: string;
  platform: string;
  architecture: string;
}

function replacementKindLabel(item: WechatReplacementItem): string {
  const kind = item.kind === "image" ? "图片" : item.kind === "formula" ? "公式" : "Mermaid 流程图";
  return `${kind}（${item.placement === "inline" ? "行内" : "块级"}）`;
}

export function generateWechatAcceptanceReport(input: WechatAcceptanceReportInput): string {
  const resultLabel = input.status === "completed-with-omissions" ? "部分完成（含已批准省略项）" : "本地人工验收清单完成";
  const themeName = WECHAT_THEME_OPTIONS.find((theme) => theme.id === input.themeId)?.name ?? input.themeId;
  const lines = [
    "# fantastic-editor 微信公众号人工验收记录",
    "",
    "> 本记录来自用户在真实公众号后台中的手动确认，只证明清单步骤被声明完成，不代表文章已经发布、群发或通过平台审核。",
    "",
    "## 任务身份",
    "",
    "- 任务 ID：" + input.jobId,
    "- 文档 ID：" + input.documentId,
    "- 源文档 SHA-256：" + input.sourceHash,
    "- 记录时间：" + input.generatedAt,
    "- 应用版本：" + input.appVersion,
    "- 运行环境：" + input.platform + " / " + input.architecture,
    "- 结果：" + resultLabel,
    "- 正文主题：" + themeName + "（" + input.themeId + "）",
    "- 已批准省略项：" + input.omittedReferenceKeys.length,
    "",
    "## 人工确认",
    "",
    "- [x] 正文已粘贴到公众号编辑器",
    "- [x] 全部可用图片、公式和流程图已按清单完成替换，且占位文字已清除",
    "- [x] 公众号草稿已保存",
    "- [x] 草稿已重新打开复核",
    "- [x] 已完成移动端预览",
    "",
    "## 替换清单",
    "",
  ];
  if (input.replacementItems.length === 0) {
    lines.push("- 本文没有需要逐项替换的图片、公式或流程图。");
  } else {
    for (const item of input.replacementItems) {
      lines.push("- [x] " + String(item.sequence).padStart(2, "0") + " " + replacementKindLabel(item) + "：" + item.label);
      lines.push("  - 占位文字：" + item.placeholderText);
      lines.push("  - 资源类型：" + item.mimeType + (item.width && item.height ? "，" + item.width + "×" + item.height : ""));
      lines.push("  - Markdown 字符位置：" + item.sourceOffset);
    }
  }
  if (input.omittedReferenceKeys.length > 0) {
    lines.push("", "## 已批准省略", "");
    for (const key of input.omittedReferenceKeys) lines.push("- " + key);
    lines.push("", "> 本任务含省略项，因此不得归类为完整成功。");
  }
  lines.push("", "## 边界", "", "- 本记录不包含公众号账号名称、文章正文、本地文件路径或图片二进制。", "- 应用没有读取公众号最终草稿内容，以上项目均为用户人工确认。", "- 本记录不证明文章已经发布或群发。", "");
  return lines.join("\n");
}
