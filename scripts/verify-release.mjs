import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8"));
const releaseDirectory = resolve(repositoryRoot, "release");
const buildTemporaryDirectory = resolve(repositoryRoot, "build-tmp");
const requireSigned = process.argv.includes("--require-signed");
const portableOnly = process.argv.includes("--portable-only");
const runPortableSmoke = process.argv.includes("--smoke");
const portableArtifactName = `fantastic-editor-${packageJson.version}-portable.exe`;
const artifactNames = portableOnly
  ? [portableArtifactName]
  : [`fantastic-editor-${packageJson.version}-setup.exe`, portableArtifactName];

function hash(bytes, algorithm) {
  return createHash(algorithm).update(bytes).digest("hex").toUpperCase();
}

function powershellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function windowsMetadata(path) {
  if (process.platform !== "win32") return { productVersion: null, fileDescription: null };
  const command = [
    `$path = ${powershellLiteral(path)}`,
    "$item = Get-Item -LiteralPath $path",
    "[ordered]@{ productVersion = $item.VersionInfo.ProductVersion; fileDescription = $item.VersionInfo.FileDescription } | ConvertTo-Json -Compress",
  ].join("; ");
  return JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-Command", command], { encoding: "utf8" }).trim());
}

function windowsAuthenticodeStatus(path) {
  if (process.platform !== "win32") return null;
  const command = [
    `$path = ${powershellLiteral(path)}`,
    "$signature = Get-AuthenticodeSignature -LiteralPath $path",
    "$signature.Status.ToString()",
  ].join("; ");
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

function peSignatureStatus(bytes) {
  if (bytes.length < 0x40) return "InvalidPE";
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset + 24 >= bytes.length || bytes.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") return "InvalidPE";
  const optionalHeaderOffset = peOffset + 24;
  const magic = bytes.readUInt16LE(optionalHeaderOffset);
  const dataDirectoryOffset = optionalHeaderOffset + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : -1);
  if (dataDirectoryOffset < optionalHeaderOffset || dataDirectoryOffset + 40 > bytes.length) return "InvalidPE";
  const certificateTableOffset = dataDirectoryOffset + 4 * 8;
  const certificateFileOffset = bytes.readUInt32LE(certificateTableOffset);
  const certificateSize = bytes.readUInt32LE(certificateTableOffset + 4);
  return certificateFileOffset > 0 && certificateSize > 0 ? "PresentUnchecked" : "NotSigned";
}

async function smokePortable(path) {
  if (process.platform !== "win32") throw new Error("Portable smoke verification requires Windows.");
  const userDataDirectory = resolve(buildTemporaryDirectory, `portable-smoke-${packageJson.version}`);
  await mkdir(userDataDirectory, { recursive: true });
  await mkdir(buildTemporaryDirectory, { recursive: true });
  const result = spawnSync(path, ["--no-sandbox", "--disable-gpu", "--disable-gpu-compositing", `--user-data-dir=${userDataDirectory}`], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      TEMP: buildTemporaryDirectory,
      TMP: buildTemporaryDirectory,
      FANTASTIC_EDITOR_SMOKE_TEST: "1",
    },
    stdio: "ignore",
    timeout: 60_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${portableArtifactName} isolated launch exited with ${result.status ?? "no status"}.`);
  return { exitCode: result.status };
}

const artifacts = [];
for (const name of artifactNames) {
  const path = resolve(releaseDirectory, name);
  const fileStat = await stat(path);
  if (!fileStat.isFile() || fileStat.size < 20 * 1024 * 1024) throw new Error(`${name} is missing or unexpectedly small.`);
  const bytes = await readFile(path);
  if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) throw new Error(`${name} does not have a Windows PE MZ header.`);
  const metadata = windowsMetadata(path);
  const peStatus = peSignatureStatus(bytes);
  if (peStatus === "InvalidPE") throw new Error(`${name} has an invalid PE structure.`);
  const signatureStatus = windowsAuthenticodeStatus(path) ?? peStatus;
  if (metadata.productVersion && !String(metadata.productVersion).startsWith(packageJson.version)) {
    throw new Error(`${name} product version ${metadata.productVersion} does not match ${packageJson.version}.`);
  }
  if (requireSigned && signatureStatus !== "Valid") throw new Error(`${name} signature is ${signatureStatus}.`);
  const artifact = {
    name,
    byteLength: fileStat.size,
    peHeader: "MZ",
    sha256: hash(bytes, "sha256"),
    sha512: hash(bytes, "sha512"),
    signatureStatus,
    productVersion: metadata.productVersion,
    fileDescription: metadata.fileDescription,
  };
  if (runPortableSmoke && name === portableArtifactName) {
    const smoke = await smokePortable(path);
    artifact.isolatedLaunchExitCode = smoke.exitCode;
  }
  artifacts.push(artifact);
}

await mkdir(releaseDirectory, { recursive: true });
if (portableOnly) {
  const manifest = {
    schema: "fantastic-editor-portable-manifest-v1",
    generatedAt: new Date().toISOString(),
    version: packageJson.version,
    platform: "win32",
    arch: "x64",
    artifact: artifacts[0],
  };
  await writeFile(resolve(releaseDirectory, `fantastic-editor-${packageJson.version}-portable-manifest.json`), `${JSON.stringify(manifest, null, 2)}\n`);
} else {
  const manifest = {
    schema: "fantastic-editor-release-manifest-v1",
    generatedAt: new Date().toISOString(),
    version: packageJson.version,
    platform: "win32",
    arch: "x64",
    artifacts,
  };
  await writeFile(resolve(releaseDirectory, `fantastic-editor-${packageJson.version}-release-manifest.json`), `${JSON.stringify(manifest, null, 2)}\n`);
}
for (const artifact of artifacts) {
  console.log(`${artifact.name}\n  size: ${artifact.byteLength}\n  sha256: ${artifact.sha256}\n  signature: ${artifact.signatureStatus}\n  productVersion: ${artifact.productVersion ?? "unknown"}\n  isolatedLaunchExitCode: ${artifact.isolatedLaunchExitCode ?? "not-run"}`);
}
