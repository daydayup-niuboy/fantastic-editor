import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_FONT_BYTES = 50 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = new Set([".ttf", ".otf"]);

const INSTALL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
trap {
  $message = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_.Exception.Message))
  [Console]::Out.Write("FONT_ERROR:$message")
  exit 1
}
$source = $env:FANTASTIC_EDITOR_FONT_SOURCE
$targetDirectory = $env:FANTASTIC_EDITOR_FONT_DIRECTORY
Add-Type -AssemblyName PresentationCore
$glyph = [System.Windows.Media.GlyphTypeface]::new([Uri]::new($source))
$family = @($glyph.Win32FamilyNames.Values)[0]
if ([string]::IsNullOrWhiteSpace($family) -or $family.Length -gt 128 -or $family -match '[\\x00-\\x1f]') { throw '无法读取有效字体名称。' }
[IO.Directory]::CreateDirectory($targetDirectory) | Out-Null
$extension = [IO.Path]::GetExtension($source).ToLowerInvariant()
$stream = [IO.File]::OpenRead($source)
try {
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try { $hash = [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '').ToLowerInvariant().Substring(0, 16) }
  finally { $sha256.Dispose() }
}
finally { $stream.Dispose() }
$targetPath = [IO.Path]::Combine($targetDirectory, "font-$hash$extension")
if (![IO.File]::Exists($targetPath)) { [IO.File]::Copy($source, $targetPath, $false) }
$fontKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts')
try { $fontKey.SetValue("$family (fantastic-editor)", $targetPath, [Microsoft.Win32.RegistryValueKind]::String) }
finally { $fontKey.Dispose() }
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class FantasticEditorFontRegistration {
  [DllImport("gdi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern int AddFontResourceEx(string file, uint flags, IntPtr reserved);
  [DllImport("user32.dll", SetLastError=true)]
  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint message, UIntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result);
}
'@
if ([FantasticEditorFontRegistration]::AddFontResourceEx($targetPath, 0, [IntPtr]::Zero) -eq 0) { throw 'Windows 无法注册此字体文件。' }
$broadcastResult = [UIntPtr]::Zero
[FantasticEditorFontRegistration]::SendMessageTimeout([IntPtr]0xffff, 0x001D, [UIntPtr]::Zero, [IntPtr]::Zero, 2, 1000, [ref]$broadcastResult) | Out-Null
$encodedFamily = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($family))
[Console]::Out.Write("FONT_OK:$encodedFamily")
`;

export function decodeFontInstallOutput(output: string, prefix = "FONT_OK:"): string | null {
  const encoded = output.trim().startsWith(prefix) ? output.trim().slice(prefix.length) : "";
  if (!encoded) return null;
  try {
    return Buffer.from(encoded, "base64").toString("utf8").trim() || null;
  } catch {
    return null;
  }
}

export function validateFontPath(path: string): string | null {
  if (!path || path.length > 32_768) return "字体文件路径无效。";
  if (!SUPPORTED_EXTENSIONS.has(extname(path).toLowerCase())) return "只支持 TrueType（.ttf）和 OpenType（.otf）字体文件。";
  return null;
}

export async function installFontForCurrentUser(path: string, installDirectory: string): Promise<{ fontFamily: string; bytes: Uint8Array }> {
  const validationError = validateFontPath(path);
  if (validationError) throw new Error(validationError);
  if (!installDirectory || installDirectory.length > 32_768) throw new Error("用户字体库路径无效。");
  const file = await stat(path);
  if (!file.isFile() || file.size <= 0 || file.size > MAX_FONT_BYTES) throw new Error("字体文件为空或超过 50 MiB 安全上限。");
  const bytes = await readFile(path);
  const encoded = Buffer.from(INSTALL_SCRIPT, "utf16le").toString("base64");
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, FANTASTIC_EDITOR_FONT_SOURCE: path, FANTASTIC_EDITOR_FONT_DIRECTORY: installDirectory },
      maxBuffer: 1024 * 1024,
    }));
  } catch (error) {
    const output = typeof error === "object" && error && "stdout" in error && typeof error.stdout === "string" ? error.stdout : "";
    throw new Error(decodeFontInstallOutput(output, "FONT_ERROR:") ?? "Windows 无法安装此字体，请确认文件未损坏。", { cause: error });
  }
  const fontFamily = decodeFontInstallOutput(stdout);
  if (!fontFamily) throw new Error("字体已复制，但无法确认字体名称。");
  return { fontFamily, bytes };
}
