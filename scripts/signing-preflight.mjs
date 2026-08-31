import { execFileSync } from "node:child_process";
import { resolveSigningConfiguration } from "./signing-config.mjs";

function powershellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function verifyWindowsStoreCertificate(thumbprint) {
  const command = [
    `$thumbprint = ${powershellLiteral(thumbprint)}`,
    "$certificate = Get-ChildItem Cert:\\CurrentUser\\My, Cert:\\LocalMachine\\My -ErrorAction SilentlyContinue | Where-Object { $_.Thumbprint -eq $thumbprint } | Select-Object -First 1",
    "if ($null -eq $certificate) { throw '找不到指定指纹的证书。' }",
    "if (-not $certificate.HasPrivateKey) { throw '指定证书没有可用私钥。' }",
    "if ($certificate.NotAfter -le (Get-Date)) { throw '指定证书已经过期。' }",
    "if (-not ($certificate.EnhancedKeyUsageList.ObjectId -contains '1.3.6.1.5.5.7.3.3')) { throw '指定证书不具备代码签名用途。' }",
    "[ordered]@{ Subject = $certificate.Subject; NotAfter = $certificate.NotAfter.ToString('yyyy-MM-dd') } | ConvertTo-Json -Compress",
  ].join("; ");
  return JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-Command", command], { encoding: "utf8" }).trim());
}

if (process.platform !== "win32") throw new Error("Windows Authenticode 发布只能在 Windows 上执行。");

const configuration = resolveSigningConfiguration();
if (configuration.mode === "windows-store") {
  const certificate = verifyWindowsStoreCertificate(configuration.certificateSha1);
  console.log(`代码签名预检通过：Windows 证书存储；主题 ${certificate.Subject}；有效期至 ${certificate.NotAfter}。`);
} else {
  console.log("代码签名预检通过：已配置受密码保护的 PFX 来源（敏感值未显示）。");
}
console.log(`RFC 3161 时间戳服务：${configuration.timestampServer}`);
