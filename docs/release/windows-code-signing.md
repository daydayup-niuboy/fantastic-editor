# fantastic-editor Windows 代码签名

## 当前结论

- 正式签名构建入口为 `npm run dist:signed`。
- 该入口会在构建前检查证书配置，构建时强制代码签名与 RFC 3161 时间戳，构建后要求安装版和便携版的 Authenticode 状态均为 `Valid`。
- 当前开发机未发现具备私钥、代码签名用途且尚未过期的证书，也未配置签名环境变量。因此现有 `0.3.0-dev.1` EXE 仍是 `NotSigned`，不能标记为正式签名发行版；这不阻断公益免费项目按未签名方案发布。
- 自签名证书不用于公开发行，也不能替代受信任 CA 颁发的代码签名证书。

## 支持的签名身份

二选一，不可同时配置。

### 受密码保护的 PFX

在当前 PowerShell 会话中设置，不要把真实值写入脚本、`.env`、日志或仓库：

```powershell
$env:WIN_CSC_LINK="D:\secure\fantastic-editor-code-signing.pfx"
$env:WIN_CSC_KEY_PASSWORD="仅在本机输入的证书密码"
npm run dist:signed
```

`WIN_CSC_LINK` 也可以使用 electron-builder 支持的安全证书来源。项目不会打印证书密码或 PFX 内容。

### Windows 证书存储

先将证书及其私钥导入当前用户或本机的“个人”证书存储，再只提供 40 位 SHA-1 指纹：

```powershell
$env:FANTASTIC_EDITOR_WINDOWS_CERTIFICATE_SHA1="40位证书指纹"
npm run dist:signed
```

预检会确认该证书存在私钥、未过期并包含 Code Signing EKU。日志只显示证书主题和到期日，不显示私钥。

## 时间戳与验证

- 默认时间戳服务为 `https://timestamp.digicert.com`；如发布者有指定服务，可设置 `FANTASTIC_EDITOR_TIMESTAMP_SERVER`，但必须是 HTTPS URL。
- `scripts/verify-release.mjs --require-signed` 通过 Windows Authenticode API 检查最终安装版和便携版，只接受 `Valid`。
- 签名后文件内容和哈希会变化，必须使用新生成的 release manifest，不得沿用未签名产物的 SHA-256/SHA-512。
- `npm run dist:rc` 可用于公益项目的未签名候选/发行构建并如实记录 `NotSigned`；只有在确实具备受信任证书时，才使用 `npm run dist:signed` 生成签名发行版。

## 公益免费项目的未签名发布

- fantastic-editor 当前暂不采购商业代码签名证书，证书费用不作为 `0.3.0-rc.2` 完成条件。
- 未签名安装版和便携版可以公开发布，但 Release、README 和 release manifest 必须明确写出 `NotSigned`，同时提供官方来源和 SHA-256 校验值，并提示 Windows 可能显示“未知发布者”或 SmartScreen 警告。
- 不生成自签名公开包，也不把 PE 证书表存在性描述为受信任签名。现有签名脚本保留，未来获得受信任证书或符合条件的免费开源签名服务后再启用。

## 发布边界

- 代码签名证明发布者身份和文件签名后的完整性，不等于 SmartScreen 立即建立信誉，也不证明业务功能、公众号草稿或群发操作通过。
- 当前产品保持单公众号账号；支持显式确认后发布单篇文章，多账号、群发和定时群发不在本阶段范围。
