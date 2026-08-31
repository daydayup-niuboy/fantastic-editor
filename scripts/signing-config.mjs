const SHA1_PATTERN = /^[A-Fa-f0-9]{40}$/;

export const DEFAULT_TIMESTAMP_SERVER = "https://timestamp.digicert.com";

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}
export function resolveSigningConfiguration(environment = process.env) {
  const certificateLink = environment.WIN_CSC_LINK || environment.CSC_LINK;
  const certificatePassword = environment.WIN_CSC_KEY_PASSWORD || environment.CSC_KEY_PASSWORD;
  const certificateSha1 = environment.FANTASTIC_EDITOR_WINDOWS_CERTIFICATE_SHA1?.replaceAll(" ", "");
  const timestampServer = environment.FANTASTIC_EDITOR_TIMESTAMP_SERVER || DEFAULT_TIMESTAMP_SERVER;

  if (nonEmpty(certificateLink) && nonEmpty(certificateSha1)) {
    throw new Error("只能选择一种签名身份：PFX（WIN_CSC_LINK）或 Windows 证书存储（FANTASTIC_EDITOR_WINDOWS_CERTIFICATE_SHA1）。");
  }
  if (!nonEmpty(certificateLink) && !nonEmpty(certificateSha1)) {
    throw new Error(
      "未配置代码签名证书。请设置 WIN_CSC_LINK + WIN_CSC_KEY_PASSWORD，或设置 FANTASTIC_EDITOR_WINDOWS_CERTIFICATE_SHA1。",
    );
  }
  if (nonEmpty(certificateLink) && !nonEmpty(certificatePassword)) {
    throw new Error("已配置 WIN_CSC_LINK/CSC_LINK，但没有配置对应的证书密码。");
  }
  if (nonEmpty(certificateSha1) && !SHA1_PATTERN.test(certificateSha1)) {
    throw new Error("FANTASTIC_EDITOR_WINDOWS_CERTIFICATE_SHA1 必须是 40 位十六进制证书指纹。");
  }

  let timestampUrl;
  try {
    timestampUrl = new URL(timestampServer);
  } catch {
    throw new Error("FANTASTIC_EDITOR_TIMESTAMP_SERVER 不是有效 URL。");
  }
  if (timestampUrl.protocol !== "https:") {
    throw new Error("时间戳服务必须使用 HTTPS。");
  }

  return {
    mode: nonEmpty(certificateLink) ? "pfx" : "windows-store",
    certificateSha1: certificateSha1?.toUpperCase() || null,
    timestampServer: timestampUrl.toString(),
  };
}
